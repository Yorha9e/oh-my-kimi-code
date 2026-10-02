/**
 * App-level MCP wire types shared by the SDK surface (`#/types` re-exports),
 * `SDKRpcClientBase`, and the v2 client.
 *
 * These are pure type declarations: the community v2 engine has no
 * `app/mcpManagement` module, so the shapes v1's `rpc/core-api.ts` put on the
 * wire are owned here (field-identical ports). Runtime config parsing lives in
 * `#/config` (zod) and the v1-replica store in `v2/global-mcp.ts`.
 */
import type { McpServerConfig } from '#/config/index';

export type McpServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryPluginOrigin {
  readonly id: string;
  /** Manifest-local server name (without the `plugin-<id>:` runtime prefix). */
  readonly name: string;
}

export type GlobalMcpServerConfig = McpServerConfig & { readonly name: string };

/**
 * Source-qualified server identity for the app-level MCP surface. Global
 * servers are addressed by their (runtime) name; plugin servers by plugin id
 * plus the manifest-local server name — the identity stays stable even when a
 * runtime-name collision makes the bare name ambiguous.
 */
export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | {
      readonly source: 'plugin';
      readonly pluginId: string;
      readonly serverName: string;
    };

export type GlobalMcpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  // Stored credentials exist but are expired without a usable refresh token
  // (or failed an online verification): re-login required.
  | 'oauth-expired';

export interface GlobalMcpServerAuthStatus {
  readonly name: string;
  readonly authStatus: GlobalMcpServerAuthState;
}

/** App-level inspection adds `unavailable` (probe failed / ambiguous name). */
export type AppMcpServerAuthState = GlobalMcpServerAuthState | 'unavailable';

/**
 * Wire-facing view of an MCP server's effective config: literal stdio `env` /
 * remote `headers` values are replaced by their sorted key lists, since they
 * may carry credentials (v1's `mcp/config-view.ts` projection).
 */
export type McpServerConfigView =
  | (Omit<Extract<McpServerConfig, { readonly transport: 'stdio' }>, 'env'> & {
      readonly envKeys?: readonly string[];
    })
  | (Omit<Exclude<McpServerConfig, { readonly transport: 'stdio' }>, 'headers'> & {
      readonly headerKeys?: readonly string[];
    });

export type AppMcpServerConfig = McpServerConfigView;

export interface AppMcpServerDescriptor {
  /** `global:<name>` or `plugin:<pluginId>:<serverName>` (URL-encoded parts). */
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly canonicalUrl: string | undefined;
  readonly origin: McpServerLocator['source'];
  /** The final effective config after source-specific transforms, redacted. */
  readonly config: AppMcpServerConfig;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export interface AppMcpServerInspection extends AppMcpServerDescriptor {
  readonly authStatus: AppMcpServerAuthState;
  readonly checkedAt?: number;
  readonly error?: string;
}

export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

/**
 * One entry of the unified MCP management view: the effective config plus its
 * source metadata. Read-only entries withhold secret-bearing values: their
 * stdio `env` / remote `headers` are redacted to the `envKeys` / `headerKeys`
 * lists, while mutable (user-level) entries keep the full values so edit UIs
 * can prefill.
 */
export type McpManagedServerInfo = GlobalMcpServerConfig & {
  readonly source: McpServerSource;
  /** global: defining file path; plugin: plugin id. */
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
  /** Set instead of `env` / `headers` when the entry is read-only. */
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
};

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  // 'removed' is only produced by the v2 engine (config-driven tombstone);
  // v1 never emits it, but SDK consumers share this type across engines.
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
  /** Config origin tag (v1 only for now): global layered files / plugin / caller. */
  readonly source?: McpServerSource;
  /**
   * The effective config the entry is running (or last failed) with, in its
   * wire-facing view: stdio `env` / remote `headers` values are redacted to
   * key lists because they may carry credentials (v1 only for now).
   */
  readonly config?: AppMcpServerConfig;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface GlobalMcpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}
