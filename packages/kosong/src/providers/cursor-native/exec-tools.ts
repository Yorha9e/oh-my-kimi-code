import type { HostToolExecutor, HostToolResult } from '#/provider';

/**
 * Marker case number used when the server payload carries a tool-shaped entry
 * that matches no known exec case. Replies for it use a generic failure
 * envelope since no numbered result case can be derived.
 */
export const UNKNOWN_EXEC_CASE = -1;

/**
 * Static description of one `ExecServerMessage` oneof case: the public cursor
 * tool name handed to the host executor plus the snake_case args key seen on
 * the wire (`shell_args`, …). The table drives decode, support checks, and
 * result-key derivation so no per-tool branching is needed.
 */
export interface ExecCaseDef {
  readonly tool: string;
  readonly argsKey: string;
}

/**
 * Case number to tool mapping for the exec channel, transcribed from the
 * authoritative proto schema map. Entries 30 and 31 are the two forced
 * background variants, 41 to 43 the three allowlist prechecks, and 45 to 52
 * the pi tool family plus the mini swe agent bash entry.
 */
export const EXEC_CASE_DEFS: Readonly<Record<number, ExecCaseDef>> = {
  2: { tool: 'shell', argsKey: 'shell_args' },
  3: { tool: 'write', argsKey: 'write_args' },
  4: { tool: 'delete', argsKey: 'delete_args' },
  5: { tool: 'grep', argsKey: 'grep_args' },
  7: { tool: 'read', argsKey: 'read_args' },
  8: { tool: 'ls', argsKey: 'ls_args' },
  9: { tool: 'diagnostics', argsKey: 'diagnostics_args' },
  10: { tool: 'request_context', argsKey: 'request_context_args' },
  11: { tool: 'mcp', argsKey: 'mcp_args' },
  14: { tool: 'shell_stream', argsKey: 'shell_stream_args' },
  16: { tool: 'background_shell_spawn', argsKey: 'background_shell_spawn_args' },
  17: { tool: 'list_mcp_resource_exec', argsKey: 'list_mcp_resource_exec_args' },
  18: { tool: 'read_mcp_resource_exec', argsKey: 'read_mcp_resource_exec_args' },
  20: { tool: 'fetch', argsKey: 'fetch_args' },
  21: { tool: 'record_screen', argsKey: 'record_screen_args' },
  22: { tool: 'computer_use', argsKey: 'computer_use_args' },
  23: { tool: 'write_shell_stdin', argsKey: 'write_shell_stdin_args' },
  27: { tool: 'execute_hook', argsKey: 'execute_hook_args' },
  28: { tool: 'subagent', argsKey: 'subagent_args' },
  29: { tool: 'redacted_read', argsKey: 'redacted_read_args' },
  30: { tool: 'force_background_shell', argsKey: 'force_background_shell_args' },
  31: { tool: 'force_background_subagent', argsKey: 'force_background_subagent_args' },
  37: { tool: 'subagent_await', argsKey: 'subagent_await_args' },
  38: { tool: 'smart_mode_classifier', argsKey: 'smart_mode_classifier_args' },
  40: { tool: 'canvas_diagnostics', argsKey: 'canvas_diagnostics_args' },
  41: { tool: 'shell_allowlist_precheck', argsKey: 'shell_allowlist_precheck_args' },
  42: { tool: 'mcp_allowlist_precheck', argsKey: 'mcp_allowlist_precheck_args' },
  43: { tool: 'web_fetch_allowlist_precheck', argsKey: 'web_fetch_allowlist_precheck_args' },
  44: { tool: 'git_diff', argsKey: 'git_diff_request' },
  45: { tool: 'pi_read', argsKey: 'pi_read_args' },
  46: { tool: 'pi_bash', argsKey: 'pi_bash_args' },
  47: { tool: 'pi_edit', argsKey: 'pi_edit_args' },
  48: { tool: 'pi_write', argsKey: 'pi_write_args' },
  49: { tool: 'pi_grep', argsKey: 'pi_grep_args' },
  50: { tool: 'pi_find', argsKey: 'pi_find_args' },
  51: { tool: 'pi_ls', argsKey: 'pi_ls_args' },
  52: { tool: 'mini_swe_agent_bash', argsKey: 'mini_swe_agent_bash_args' },
  53: { tool: 'conversation_search', argsKey: 'conversation_search_args' },
  54: { tool: 'agent_store_conflict', argsKey: 'agent_store_conflict_args' },
  56: { tool: 'adopt', argsKey: 'adopt_args' },
};

/**
 * Exec cases the host executes via the engine permission gate: shell (2),
 * write (3), delete (4), grep (5), read (7), ls (8), mcp (11), fetch (20).
 * Every other known case degrades to an explicit failure result and never
 * reaches the executor.
 */
export const SUPPORTED_EXEC_CASES: ReadonlyArray<number> = [2, 3, 4, 5, 7, 8, 11, 20];

/**
 * One decoded server tool request: the oneof case number, the public cursor
 * tool name, the normalized executor args, and the id pair that must be
 * echoed back so the server can match the reply.
 */
export interface ExecRequest {
  readonly caseNo: number;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly id?: number;
  readonly execId?: string;
}

/**
 * Host-side verdict for one exec request. `success` carries the joined tool
 * output text, `failure`/`timeout`/`spawnError` carry a message, and the two
 * denial kinds carry an optional host-side note that is intentionally left
 * off the wire (both encode as empty protocol messages).
 */
export type ExecOutcome =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'failure'; readonly message: string }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'spawnError'; readonly message: string }
  | { readonly kind: 'rejected'; readonly message?: string }
  | { readonly kind: 'permissionDenied'; readonly message?: string };

/**
 * Encode-side options: the client-measured execution time echoed as
 * `localExecutionTimeMs` (field 39) alongside the paired id fields.
 */
export interface ExecEncodeOptions {
  readonly localExecutionTimeMs?: number;
}

/**
 * Per-call policy seam for the exec loop. `isPermissionDenied` lets the
 * provider owner (M4) plug the engine permission verdict in: it sees the raw
 * executor rejection and returns true when that rejection means "the engine
 * permission gate refused this call". `isTimeout` overrides timeout
 * detection the same way. When omitted, the built-in detectors
 * ({@link isPermissionDeniedError}, {@link isTimeoutError}) apply.
 */
export interface HandleExecOptions extends ExecEncodeOptions {
  readonly isPermissionDenied?: (error: unknown) => boolean;
  readonly isTimeout?: (error: unknown) => boolean;
}

/**
 * Explicit permission-denial signal. When the engine adapter maps a host
 * permission refusal to this error, the exec loop encodes the protocol-native
 * `permission_denied` result (shell/mcp) or `rejected` (every other tool)
 * instead of a generic failure. Prefer this over message sniffing whenever
 * the refusal is known programmatically.
 */
export class ExecPermissionDeniedError extends Error {
  /**
   * Create a denial signal carrying the host-side reason for logs.
   */
  constructor(message?: string) {
    super(message ?? 'tool call denied by engine permission policy');
    this.name = 'ExecPermissionDeniedError';
  }
}

/**
 * Explicit host-rejection signal. Throw it when the call was refused outside
 * the permission policy (approval declined, user rejection) so the loop
 * encodes the protocol-native `rejected` result instead of a failure.
 */
export class ExecRejectedError extends Error {
  /**
   * Create a rejection signal carrying the host-side reason for logs.
   */
  constructor(message?: string) {
    super(message ?? 'tool call rejected by host');
    this.name = 'ExecRejectedError';
  }
}

/**
 * True for the eight core cases the host executes. Everything else (known
 * but unsupported, or entirely unknown) must degrade to a failure result.
 */
export function isSupportedTool(caseNo: number): boolean {
  return SUPPORTED_EXEC_CASES.includes(caseNo);
}

/**
 * Default permission-denial detector for executor rejections. Matches the
 * shapes a host permission gate produces: policy/approval wording in the
 * message as well as EPERM/EACCES codes. M4 can bypass or extend it via
 * `HandleExecOptions.isPermissionDenied` or the explicit error classes.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  const haystack = `${errorCode(error)} ${errorMessage(error)}`;
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Default timeout detector for executor rejections. Matches timeout wording,
 * ETIMEDOUT codes, and TimeoutError names; shell timeouts encode as the
 * native `timeout` result, other tools fall back to `failure`.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const haystack = `${errorCode(error)} ${errorMessage(error)}`;
  return TIMEOUT_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Decode one parsed server frame into an {@link ExecRequest}. Returns null
 * for anything that is not an exec tool request (interaction updates,
 * checkpoints, trailers, malformed envelopes), so the caller simply ignores
 * it. Never throws on malformed input. Accepts both camelCase and snake_case
 * envelope and args keys, plus numeric case keys, since the gateway wire has
 * been observed in both casings.
 */
export function decodeExecServerMessage(msg: unknown): ExecRequest | null {
  if (!isRecord(msg)) return null;
  const inner = msg['execServerMessage'] ?? msg['exec_server_message'];
  if (!isRecord(inner)) return null;
  const id = toExecNumericId(inner['id']);
  const execId = toExecId(inner['execId'] ?? inner['exec_id']);
  for (const [caseNo, def] of execCaseEntries()) {
    const raw = inner[def.argsKey] ?? inner[snakeToCamel(def.argsKey)] ?? inner[String(caseNo)];
    if (isRecord(raw)) {
      return { caseNo, toolName: def.tool, args: normalizeExecArgs(def.tool, raw, inner), id, execId };
    }
  }
  const fallbackKey = Object.keys(inner).find(
    (key) => key !== 'id' && key !== 'execId' && key !== 'exec_id' && isRecord(inner[key]),
  );
  if (fallbackKey === undefined) return null;
  const fallbackArgs = inner[fallbackKey];
  return {
    caseNo: UNKNOWN_EXEC_CASE,
    toolName: fallbackKey,
    args: isRecord(fallbackArgs) ? { ...fallbackArgs } : {},
    id,
    execId,
  };
}

/**
 * Encode one `ExecClientMessage` envelope for a decoded request plus its
 * host verdict. The result case number always matches the args case number
 * (`shell_result` for `shell_args`, …), and the `id`/`exec_id` pair is echoed
 * back verbatim. Result payload shapes follow the proto schema map where
 * documented (`ReadToolSuccess.content`, the `ShellResult`/`McpResult`
 * oneofs); undocumented success payloads carry `{ output }` and failures
 * carry `{ message }` as best effort. MCP failures use the native `error`
 * case (not `failure`), and `rejected`/`permission_denied` encode as empty
 * messages. Requests with no known case fall back to a generic `{ failure }`
 * envelope so they are never silently dropped.
 */
export function encodeExecClientMessage(
  req: ExecRequest,
  outcome: ExecOutcome,
  opts?: ExecEncodeOptions,
): Record<string, unknown> {
  const def = EXEC_CASE_DEFS[req.caseNo];
  const body: Record<string, unknown> = {};
  if (def === undefined) {
    body['failure'] = { message: outcomeText(req, outcome) };
  } else {
    const inner = resolveInnerResult(def.tool, req, outcome);
    body[resultKeyFor(def.argsKey)] = { [inner.name]: inner.payload };
  }
  if (req.id !== undefined) body['id'] = req.id;
  if (req.execId !== undefined) body['execId'] = req.execId;
  if (opts?.localExecutionTimeMs !== undefined) body['localExecutionTimeMs'] = opts.localExecutionTimeMs;
  return { execClientMessage: body };
}

/**
 * Decode, execute through the host executor (the engine permission gate
 * lives behind it), and encode the reply in one step. Unsupported cases
 * short-circuit to a failure result without touching the executor.
 * Executor rejections are classified into failure, timeout, spawnError, or
 * the protocol-native denial results; the loop itself never throws for
 * executor behavior and never drops a decodable request. Returns null only
 * for non-exec input, matching {@link decodeExecServerMessage}.
 */
export async function handleExecServerMessage(
  msg: unknown,
  executor: HostToolExecutor,
  opts?: HandleExecOptions,
): Promise<Record<string, unknown> | null> {
  const req = decodeExecServerMessage(msg);
  if (req === null) return null;
  if (!isSupportedTool(req.caseNo)) {
    return encodeExecClientMessage(req, { kind: 'failure', message: unsupportedMessage(req) }, opts);
  }
  let outcome: ExecOutcome;
  try {
    outcome = resultToOutcome(await executor(req.toolName, req.args), req.toolName);
  } catch (error) {
    outcome = classifyThrown(error, opts);
  }
  return encodeExecClientMessage(req, outcome, opts);
}

const PERMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /permission denied/i,
  /permission_denied/i,
  /denied by policy/i,
  /policy denied/i,
  /operation not permitted/i,
  /requires approval/i,
  /approval denied/i,
  /approval rejected/i,
  /user rejected/i,
  /rejected by user/i,
  /\bEPERM\b/,
  /\bEACCES\b/,
];

const TIMEOUT_PATTERNS: ReadonlyArray<RegExp> = [/timed?\s?out/i, /\bETIMEDOUT\b/, /deadline exceeded/i];

const SPAWN_PATTERNS: ReadonlyArray<RegExp> = [/spawn/i, /\bENOENT\b/];

const EXEC_ARG_FIELDS: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>> = {
  shell: {
    command: ['command'],
    workingDirectory: ['workingDirectory', 'working_directory'],
    timeout: ['timeout'],
    toolCallId: ['toolCallId', 'tool_call_id'],
  },
  read: {
    path: ['path'],
    toolCallId: ['toolCallId', 'tool_call_id'],
    offset: ['offset'],
    limit: ['limit'],
    encodingHint: ['encodingHint', 'encoding_hint'],
  },
  write: {
    path: ['path'],
    fileText: ['fileText', 'file_text'],
    toolCallId: ['toolCallId', 'tool_call_id'],
    fileBytes: ['fileBytes', 'file_bytes'],
    encodingHint: ['encodingHint', 'encoding_hint'],
  },
  delete: {
    path: ['path'],
    toolCallId: ['toolCallId', 'tool_call_id'],
  },
  grep: {
    pattern: ['pattern', 'query', 'text'],
    path: ['path', 'directory', 'dir'],
    toolCallId: ['toolCallId', 'tool_call_id'],
  },
  ls: {
    path: ['path', 'directory', 'dir'],
    toolCallId: ['toolCallId', 'tool_call_id'],
  },
  mcp: {
    name: ['name'],
    args: ['args'],
    toolCallId: ['toolCallId', 'tool_call_id'],
    providerIdentifier: ['providerIdentifier', 'provider_identifier'],
    toolName: ['toolName', 'tool_name'],
    skipApproval: ['skipApproval', 'skip_approval'],
    serverIdentifier: ['serverIdentifier', 'server_identifier'],
  },
  /** Best effort: the upstream FetchArgs shape is undocumented, confirm with the M4 live probe. */
  fetch: {
    url: ['url', 'uri', 'href'],
    toolCallId: ['toolCallId', 'tool_call_id'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function execCaseEntries(): Array<[number, ExecCaseDef]> {
  return Object.entries(EXEC_CASE_DEFS).map(([key, def]): [number, ExecCaseDef] => [Number(key), def]);
}

function snakeToCamel(value: string): string {
  return value.replaceAll(/_([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());
}

function resultKeyFor(argsKey: string): string {
  let base = argsKey;
  if (base.endsWith('_args')) {
    base = base.slice(0, -'_args'.length);
  } else if (base.endsWith('_request')) {
    base = base.slice(0, -'_request'.length);
  }
  return `${snakeToCamel(base)}Result`;
}

function toExecNumericId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value !== '' && Number.isInteger(Number(value))) return Number(value);
  return undefined;
}

function toExecId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeExecArgs(
  tool: string,
  raw: Record<string, unknown>,
  inner: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const mapping = EXEC_ARG_FIELDS[tool];
  if (mapping !== undefined) {
    for (const [canonical, aliases] of Object.entries(mapping)) {
      const found = aliases.map((alias) => raw[alias]).find((value) => value !== undefined);
      if (found !== undefined) out[canonical] = found;
      for (const alias of aliases) {
        if (alias !== canonical) delete out[alias];
      }
    }
  }
  if (out['toolCallId'] === undefined) {
    const topLevel = inner['toolCallId'] ?? inner['tool_call_id'];
    if (typeof topLevel === 'string') out['toolCallId'] = topLevel;
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (error === null || error === undefined) return 'unknown error';
  try {
    const encoded = JSON.stringify(error);
    if (typeof encoded === 'string' && encoded !== '') return encoded;
  } catch {
    return 'unknown error';
  }
  return 'unknown error';
}

function errorCode(error: unknown): string {
  if (isRecord(error) && (typeof error['code'] === 'string' || typeof error['code'] === 'number')) {
    return String(error['code']);
  }
  return '';
}

function isSpawnError(error: unknown): boolean {
  const haystack = `${errorCode(error)} ${errorMessage(error)}`;
  return SPAWN_PATTERNS.some((pattern) => pattern.test(haystack));
}

function joinResultText(result: HostToolResult): string {
  const content = (result as { content?: unknown })['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .join('\n');
}

function resultToOutcome(result: HostToolResult, toolName: string): ExecOutcome {
  if (!isRecord(result)) return { kind: 'failure', message: `tool "${toolName}" returned no result` };
  const text = joinResultText(result);
  if (result['isError'] === true) {
    return { kind: 'failure', message: text === '' ? `tool "${toolName}" reported failure` : text };
  }
  return { kind: 'success', text };
}

function classifyThrown(error: unknown, opts?: HandleExecOptions): ExecOutcome {
  if (error instanceof ExecRejectedError) return { kind: 'rejected', message: errorMessage(error) };
  if (error instanceof ExecPermissionDeniedError) return { kind: 'permissionDenied', message: errorMessage(error) };
  const denies = opts?.isPermissionDenied ?? isPermissionDeniedError;
  if (denies(error)) return { kind: 'permissionDenied', message: errorMessage(error) };
  const timesOut = opts?.isTimeout ?? isTimeoutError;
  if (timesOut(error)) return { kind: 'timeout', message: errorMessage(error) };
  if (isSpawnError(error)) return { kind: 'spawnError', message: errorMessage(error) };
  return { kind: 'failure', message: errorMessage(error) };
}

function failureCaseFor(tool: string): string {
  return tool === 'mcp' ? 'error' : 'failure';
}

function resolveInnerResult(
  tool: string,
  req: ExecRequest,
  outcome: ExecOutcome,
): { name: string; payload: Record<string, unknown> } {
  switch (outcome.kind) {
    case 'success': {
      if (tool === 'read') {
        const path = req.args['path'];
        return {
          name: 'success',
          payload: {
            content: outcome.text,
            path: typeof path === 'string' ? path : undefined,
            isEmpty: outcome.text.length === 0,
          },
        };
      }
      return { name: 'success', payload: { output: outcome.text } };
    }
    case 'timeout': {
      if (tool === 'shell') return { name: 'timeout', payload: { message: outcome.message } };
      return { name: failureCaseFor(tool), payload: { message: outcome.message } };
    }
    case 'spawnError': {
      if (tool === 'shell') return { name: 'spawnError', payload: { message: outcome.message } };
      return { name: failureCaseFor(tool), payload: { message: outcome.message } };
    }
    case 'rejected':
      return { name: 'rejected', payload: {} };
    case 'permissionDenied': {
      if (tool === 'shell' || tool === 'mcp') return { name: 'permissionDenied', payload: {} };
      return { name: 'rejected', payload: {} };
    }
    case 'failure':
      return { name: failureCaseFor(tool), payload: { message: outcome.message } };
  }
}

function outcomeText(req: ExecRequest, outcome: ExecOutcome): string {
  switch (outcome.kind) {
    case 'success':
      return outcome.text;
    case 'rejected':
    case 'permissionDenied':
      return outcome.message ?? `${req.toolName} denied by host`;
    case 'failure':
    case 'timeout':
    case 'spawnError':
      return outcome.message;
  }
}

function unsupportedMessage(req: ExecRequest): string {
  if (req.caseNo === UNKNOWN_EXEC_CASE) {
    return `unrecognized cursor tool payload "${req.toolName}": not executed by the host`;
  }
  return `unsupported cursor tool "${req.toolName}" (case ${req.caseNo}): not executed by the host`;
}
