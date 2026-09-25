/**
 * The v1 (`@moonshot-ai/agent-core`) SDK client — test-only since M3.
 *
 * The public SDK surface is v2-only (`SDKRpcClientV2` / `createKimiHarnessV2`);
 * this client exists solely so the dual-engine parity net (`v1-v2-parity`)
 * and the v1-driven tests can still construct a real `KimiCore` harness.
 * `agent-core` therefore stays a devDependency of this package.
 */
import {
  createRPC,
  ensureConfigFile,
  getRootLogger,
  KimiCore,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type ApprovalRequest as V1ApprovalRequest,
  type ApprovalResponse as V1ApprovalResponse,
  type CoreAPI,
  type Event as V1Event,
  type QuestionRequest as V1QuestionRequest,
  type QuestionResult as V1QuestionResult,
  type RPCMethods,
  type SDKAPI,
  type ToolCallRequest as V1ToolCallRequest,
  type ToolCallResponse as V1ToolCallResponse,
} from '@moonshot-ai/agent-core';
import type { Kaos } from '@moonshot-ai/kaos';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';

import { KimiAuthFacade } from '#/auth';
import { readConfigFile, type ImageConfig } from '#/config/index';
import { KimiHarness } from '#/kimi-harness';
import type { OAuthTokenProviderResolver } from '#/model-provider';
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
} from '#/events';
import { ImageLimits } from '#/image';
import { SDKRpcClientBase } from '#/rpc';
import { noopTelemetryClient, type TelemetryClient } from '#/telemetry';
import type {
  CreateSessionOptions,
  KimiHarnessOptions,
  KimiHostIdentity,
  OAuthRefreshOutcome,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
} from '#/types';

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  /**
   * Host UI mode (`'print'` for `kimi -p`, `'cli'` for the TUI, ...). Forwarded
   * to the v1 core, which applies print-mode config defaults when it is
   * `'print'`.
   */
  readonly uiMode?: string;
}

/**
 * The v1 core's reverse-RPC surface handed back to the engine (events out,
 * approval/question/tool-call requests in). Lives here with the v1 client
 * because only this client pairs with `createRPC<CoreAPI, SDKAPI>`.
 *
 * The engine hands protocol-shaped payloads (the wire union from
 * `@moonshot-ai/agent-core`); the SDK's public `Event` / interaction types
 * are structurally identical on every field the engine actually sends (the
 * known deltas are type-level only), so the bridge casts at this single
 * boundary — same technique as `translateDomainEvent` on the v2 path.
 */
export class ClientAPI implements SDKAPI {
  constructor(readonly client: SDKRpcClientBase) {}

  emitEvent(event: V1Event): void {
    this.client.receiveEvent(event as unknown as Event);
  }

  requestApproval(
    request: V1ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<V1ApprovalResponse> {
    return this.client.requestApproval(
      request as unknown as ApprovalRequest & { sessionId: string; agentId: string },
    );
  }

  requestQuestion(
    request: V1QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<V1QuestionResult> {
    return this.client.requestQuestion(
      request as unknown as QuestionRequest & { sessionId: string; agentId: string },
    );
  }

  toolCall(request: V1ToolCallRequest): Promise<V1ToolCallResponse> {
    return this.client.toolCall(request as unknown as ToolCallRequest);
  }
}

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly core: KimiCore;

  private readonly ready: Promise<RPCMethods<CoreAPI>>;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    // agent-core's root logger is the process-root singleton (node-sdk's
    // copy shares the same slot — see `src/logging/logger.ts`), so this one
    // configure covers both the v1 core's writes and the public `log`.
    void getRootLogger().configure(resolveLoggingConfig({ homeDir: this.homeDir }));

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    this.core = new KimiCore(coreRpc, {
      homeDir: options.homeDir,
      configPath: this.configPath,
      kimiRequestHeaders: this.createKimiRequestHeaders(),
      resolveOAuthTokenProvider:
        options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: this.telemetry,
      appVersion: this.identity?.version,
      uiMode: options.uiMode,
    });
    this.ready = sdkRpc(new ClientAPI(this));
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    try {
      // Close live sessions and stop the shared MCP OAuth service (proactive
      // refresh timers, in-flight authorization flows) before flushing logs.
      await this.core.shutdown();
    } catch {
      // never let core shutdown block process exit
    }
    try {
      await getRootLogger().flush();
    } catch {
      // never let logger flush block process exit
    }
  }

  protected async getRpc(): Promise<RPCMethods<CoreAPI>> {
    return this.ready;
  }

  override async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    const { planMode, ...coreInput } = input;
    void planMode;
    return this.core.createSessionWithOverrides(coreInput, { kaos, persistenceKaos });
  }

  override async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    return this.core.resumeSessionWithOverrides(
      { ...input, sessionId: input.id },
      { kaos, persistenceKaos },
    );
  }

  private createKimiRequestHeaders(): Record<string, string> | undefined {
    if (this.identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir: this.homeDir,
      ...this.identity,
    });
  }
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: new ImageLimits(process.env, readImageSection(rpc.configPath)),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}

/**
 * The owner-scoped `[image]` limits the harness exposes for prompt-ingestion
 * compression. The core loaded the same section into its own instance; this
 * rebuilds the SDK-typed one from the (already validated — the core read it
 * during construction) config file, falling back to built-in defaults when
 * the file is absent or unreadable.
 */
function readImageSection(configPath: string): ImageConfig | undefined {
  try {
    return readConfigFile(configPath).image;
  } catch {
    return undefined;
  }
}
