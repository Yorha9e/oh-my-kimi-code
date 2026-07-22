import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Event, KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  AgentStatusThrottle,
  shouldExportEventType,
  startStatusServer,
  toStatusJson,
  type StatusServerHandle,
} from '#/cli/status-export';

type EventListener = (event: Event) => void;

function createStubSource(): { source: Pick<KimiHarness, 'onEvent'>; emit: (event: Event) => void } {
  const listeners = new Set<EventListener>();
  return {
    source: {
      onEvent(listener: EventListener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(event: Event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function makeEvent(type: string, extra: Record<string, unknown> = {}): Event {
  return { type, sessionId: 'sess-1', agentId: 'agent-1', ...extra } as unknown as Event;
}

const handles: StatusServerHandle[] = [];

async function startTestServer(
  source: Pick<KimiHarness, 'onEvent'>,
  basePort = 0,
  maxPortRetries = 100,
): Promise<StatusServerHandle> {
  const handle = await startStatusServer(source, '9.9.9-test', basePort, maxPortRetries);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
  vi.useRealTimers();
});

describe('shouldExportEventType', () => {
  it('exports lifecycle events and drops high-frequency streaming events', () => {
    for (const type of [
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
      'subagent.completed',
      'subagent.failed',
      'subagent.suspended',
      'background.task.started',
      'background.task.terminated',
      'compaction.started',
      'compaction.completed',
      'goal.updated',
      'skill.activated',
      'error',
      'warning',
    ]) {
      expect(shouldExportEventType(type), type).toBe(true);
    }
    for (const type of [
      'assistant.delta',
      'thinking.delta',
      'tool.call.delta',
      'shell.output',
      'tool.progress',
      'session.meta.updated',
    ]) {
      expect(shouldExportEventType(type), type).toBe(false);
    }
  });
});

describe('toStatusJson', () => {
  it('strips the envelope into sessionId/agentId/type/payload', () => {
    const json = JSON.parse(toStatusJson(makeEvent('turn.started', { turnId: 3 }), 1234)) as {
      ts: number;
      sessionId: string;
      agentId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    expect(json).toEqual({
      ts: 1234,
      sessionId: 'sess-1',
      agentId: 'agent-1',
      type: 'turn.started',
      payload: { turnId: 3 },
    });
  });
});

describe('AgentStatusThrottle', () => {
  it('emits the first update immediately and coalesces the window to the latest trailing state', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new AgentStatusThrottle(500);
    const emit = (frame: string): void => {
      emitted.push(frame);
    };

    throttle.offer('a1', 'running-1', emit, 1000);
    throttle.offer('a1', 'running-2', emit, 1100);
    throttle.offer('a1', 'idle', emit, 1200);
    expect(emitted).toEqual(['running-1']);

    vi.advanceTimersByTime(400);
    // The trailing frame carries the final state, not an intermediate one.
    expect(emitted).toEqual(['running-1', 'idle']);

    // After the window the next update leads again.
    throttle.offer('a1', 'running-3', emit, 2000);
    expect(emitted).toEqual(['running-1', 'idle', 'running-3']);
    throttle.dispose();
  });

  it('throttles agents independently', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new AgentStatusThrottle(500);
    const emit = (frame: string): void => {
      emitted.push(frame);
    };

    throttle.offer('a1', 'a1-first', emit, 1000);
    throttle.offer('a2', 'a2-first', emit, 1100);
    expect(emitted).toEqual(['a1-first', 'a2-first']);
    throttle.dispose();
  });
});

describe('status SSE server', () => {
  it('serves /health with product, version and pid plus CORS', async () => {
    const { source } = createStubSource();
    const handle = await startTestServer(source);

    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      ok: true,
      product: 'omkc-status-source',
      version: '9.9.9-test',
      pid: process.pid,
    });
  });

  it('answers OPTIONS with 204 and unknown paths with 404', async () => {
    const { source } = createStubSource();
    const handle = await startTestServer(source);

    const options = await fetch(`http://127.0.0.1:${handle.port}/events`, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('*');

    const missing = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    expect(missing.status).toBe(404);
  });

  it('streams filtered events as SSE frames on /events', async () => {
    const { source, emit } = createStubSource();
    const handle = await startTestServer(source);

    const res = await fetch(`http://127.0.0.1:${handle.port}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string): Promise<string> => {
      while (!buffer.includes(needle)) {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    // Excluded events must not produce frames; the included one must.
    emit(makeEvent('assistant.delta', { delta: 'hello' }));
    emit(makeEvent('turn.started', { turnId: 7 }));
    const text = await readUntil('turn.started');
    expect(text).not.toContain('assistant.delta');

    const frame = text.split('\n\n').find((part) => part.includes('turn.started'));
    expect(frame).toBeDefined();
    expect(frame!.startsWith('data: ')).toBe(true);
    const json = JSON.parse(frame!.slice('data: '.length)) as {
      ts: number;
      sessionId: string;
      agentId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    expect(json.sessionId).toBe('sess-1');
    expect(json.agentId).toBe('agent-1');
    expect(json.type).toBe('turn.started');
    expect(json.payload).toEqual({ turnId: 7 });
    expect(typeof json.ts).toBe('number');

    await reader.cancel();
  });

  it('throttles agent.status.updated frames per agent', async () => {
    const { source, emit } = createStubSource();
    const handle = await startTestServer(source);

    const res = await fetch(`http://127.0.0.1:${handle.port}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string): Promise<string> => {
      while (!buffer.includes(needle)) {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    emit(makeEvent('agent.status.updated', { phase: 'running' }));
    emit(makeEvent('agent.status.updated', { phase: 'idle' }));
    // Leading frame arrives immediately; the trailing "idle" lands after the
    // 500ms throttle window instead of being dropped.
    const text = await readUntil('"idle"');
    const frames = text
      .split('\n\n')
      .filter((part) => part.startsWith('data: ') && part.includes('agent.status.updated'));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('running');
    expect(frames[1]).toContain('idle');

    await reader.cancel();
  }, 10_000);

  it('falls back to the next port on EADDRINUSE', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = blocker.address();
    const takenPort = typeof address === 'object' && address !== null ? address.port : 0;
    expect(takenPort).toBeGreaterThan(0);

    try {
      const { source } = createStubSource();
      const handle = await startTestServer(source, takenPort, 3);
      expect(handle.port).toBe(takenPort + 1);
    } finally {
      blocker.close();
    }
  });

  it('rejects when every candidate port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = blocker.address();
    const takenPort = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const { source } = createStubSource();
      await expect(startStatusServer(source, '9.9.9-test', takenPort, 0)).rejects.toThrow();
    } finally {
      blocker.close();
    }
  });
});
