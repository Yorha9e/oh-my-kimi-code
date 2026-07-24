/**
 * Engine status export for external consumers (omkc-status).
 *
 * Embeds a tiny loopback-only HTTP server in the interactive CLI process and
 * forwards the filtered v1 engine event stream to external consumers over
 * SSE. Nothing is written to disk: consumers discover instances by scanning
 * 127.0.0.1 ports 39631..39731 for GET /health.
 *
 * Wire contract: `status-protocol-v1` (see the cross-repo contract spec). The
 * /health body carries `protocolVersion: 1`; the field is additive, so a
 * legacy consumer that ignores unknown fields keeps working, and a consumer
 * that sees no `protocolVersion` at all is reading a pre-v1 (legacy v0) source.
 *
 * The event listener runs synchronously inside the RPC dispatch loop, so it
 * stays lightweight and non-blocking: it only serializes and writes into the
 * clients' socket buffers. Slow clients never back-pressure the engine — a
 * client whose unflushed backlog exceeds 1000 frames is disconnected.
 * Every initialization error is swallowed; the export must never affect
 * the CLI.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';

import type { Event, KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { getVersion } from './version';

export const STATUS_PORT_BASE = 39631;
export const STATUS_PORT_MAX_RETRIES = 100;
export const STATUS_PRODUCT_NAME = 'omkc-status-source';
/**
 * `status-protocol-v1` wire contract version advertised on /health. Bumping
 * this major is a breaking change: consumers accept a missing field (legacy
 * v0) or `1`, and must safely skip an unknown future major (> 1).
 */
export const STATUS_PROTOCOL_VERSION = 1;

const LOOPBACK_HOST = '127.0.0.1';
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CLIENT_BACKLOG_FRAMES = 1000;
const AGENT_STATUS_THROTTLE_MS = 500;

/**
 * Event types worth forwarding. High-frequency streaming events
 * (assistant.delta, thinking.delta, tool.call.delta, shell.output,
 * tool.progress) are intentionally excluded.
 */
const EXPORTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.status.updated',
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'tool.call.started',
  'tool.result',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'background.task.started',
  'background.task.terminated',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'goal.updated',
  'skill.activated',
  'error',
  'warning',
]);

export function shouldExportEventType(type: string): boolean {
  return EXPORTED_EVENT_TYPES.has(type);
}

/**
 * Leading+trailing throttle for `agent.status.updated`, keyed by agent id.
 * The first update inside a window is emitted immediately; later ones are
 * coalesced and the latest is emitted when the window ends, so the consumer
 * never misses the final state (e.g. back to idle at turn end).
 */
export class AgentStatusThrottle {
  private readonly lastSentAt = new Map<string, number>();
  private readonly trailing = new Map<string, { frame: string; timer: NodeJS.Timeout }>();

  constructor(private readonly windowMs: number) {}

  offer(
    agentId: string,
    frame: string,
    emit: (frame: string) => void,
    now: number = Date.now(),
  ): void {
    const last = this.lastSentAt.get(agentId);
    if (last === undefined || now - last >= this.windowMs) {
      this.lastSentAt.set(agentId, now);
      emit(frame);
      return;
    }
    const existing = this.trailing.get(agentId);
    if (existing !== undefined) {
      existing.frame = frame;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.trailing.get(agentId);
      this.trailing.delete(agentId);
      if (entry === undefined) return;
      // Deterministic: the trailing frame leaves exactly at the window end.
      this.lastSentAt.set(agentId, last + this.windowMs);
      emit(entry.frame);
    }, this.windowMs - (now - last));
    timer.unref();
    this.trailing.set(agentId, { frame, timer });
  }

  dispose(): void {
    for (const entry of this.trailing.values()) {
      clearTimeout(entry.timer);
    }
    this.trailing.clear();
  }
}

/** Strip the envelope fields; the remaining event fields become the payload. */
export function toStatusJson(event: Event, ts: number): string {
  const { type, sessionId, agentId, ...payload } = event as {
    type: string;
    sessionId: string;
    agentId: string;
  } & Record<string, unknown>;
  return JSON.stringify({ ts, sessionId, agentId, type, payload });
}

export interface StatusServerHandle {
  readonly server: Server;
  readonly port: number;
  close(): void;
}

interface SseClient {
  readonly res: ServerResponse;
  /** Frames written since the last 'drain'; a growing backlog means a slow consumer. */
  backlog: number;
}

/**
 * Start the loopback status server. Resolves once it is listening; rejects
 * when no port in `basePort..basePort+maxPortRetries` is available.
 * `basePort: 0` asks the OS for an ephemeral port (tests).
 */
export async function startStatusServer(
  source: Pick<KimiHarness, 'onEvent'>,
  version: string,
  basePort: number = STATUS_PORT_BASE,
  maxPortRetries: number = STATUS_PORT_MAX_RETRIES,
): Promise<StatusServerHandle> {
  const clients = new Set<SseClient>();
  const throttle = new AgentStatusThrottle(AGENT_STATUS_THROTTLE_MS);

  const broadcast = (frame: string): void => {
    for (const client of clients) {
      if (!client.res.writable || client.backlog > MAX_CLIENT_BACKLOG_FRAMES) {
        clients.delete(client);
        client.res.destroy();
        continue;
      }
      if (!client.res.write(frame)) {
        client.backlog += 1;
      }
    }
  };

  const unsubscribe = source.onEvent((event) => {
    try {
      if (!shouldExportEventType(event.type)) return;
      const frame = `data: ${toStatusJson(event, Date.now())}\n\n`;
      if (event.type === 'agent.status.updated') {
        throttle.offer(event.agentId, frame, broadcast);
        return;
      }
      broadcast(frame);
    } catch {
      /* never let the export break event dispatch */
    }
  });

  const heartbeat = setInterval(() => {
    broadcast(': ping\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          product: STATUS_PRODUCT_NAME,
          protocolVersion: STATUS_PROTOCOL_VERSION,
          version,
          pid: process.pid,
        }),
      );
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Headers are otherwise held back until the first event frame; flush
      // them now so the client's fetch() resolves immediately.
      res.flushHeaders();
      const client: SseClient = { res, backlog: 0 };
      clients.add(client);
      res.on('drain', () => {
        client.backlog = 0;
      });
      // The client went away: drop the reference so the Set cannot leak.
      // (ServerResponse 'close' = connection closed; IncomingMessage 'close'
      // already fires once a bodyless GET is complete, so it cannot be used.)
      res.on('close', () => {
        clients.delete(client);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listenWithFallback(server, basePort, maxPortRetries);

  return {
    server,
    port,
    close(): void {
      clearInterval(heartbeat);
      throttle.dispose();
      unsubscribe();
      for (const client of clients) {
        client.res.destroy();
      }
      clients.clear();
      server.close();
    },
  };
}

async function listenWithFallback(
  server: Server,
  basePort: number,
  maxPortRetries: number,
): Promise<number> {
  for (let offset = 0; offset <= maxPortRetries; offset++) {
    const port = basePort === 0 ? 0 : basePort + offset;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, LOOPBACK_HOST, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || offset === maxPortRetries) {
        throw error;
      }
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('no status port available');
}

/**
 * Wire the status export into interactive startup. Fire-and-forget: the
 * server is unref'd so it never keeps the CLI process alive, and every
 * failure is swallowed.
 */
export function startStatusExport(
  harness: Pick<KimiHarness, 'onEvent'>,
  enabled: boolean,
): void {
  if (!enabled) return;
  let version = 'unknown';
  try {
    version = getVersion();
  } catch {
    /* ignore */
  }
  startStatusServer(harness, version)
    .then((handle) => {
      handle.server.unref();
    })
    .catch(() => undefined);
}
