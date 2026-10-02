# Engine Adaptation: Cursor Native Provider State Persistence

> Design record for making `CursorNativeChatProvider` state survive process
> restarts / session resume. Produced from three parallel explorations
> (2026-09-09): session persistence internals, official CLI persistence
> reference, and boundary scenarios (model switching, compaction).

## Problem

`CursorNativeChatProvider` is the only stateful provider in kosong. Its
protocol state lives entirely in memory:

```text
_blobStore          Map<string,string>  blob content (server-pushed, base64)
_turnIds            string[]            arrival-ordered blob ids
_promptMessageIds   string[]            role-JSON message blob ids
_rootPromptIds      string[]            initial system/rules blob ids
_latestStateBlobId  string|null         state anchor (§ continuation-protocol.md)
_conversationId     string|null         agent-<uuid>, session key
_lastRunId          string|null         request that produced the turn
_lastUsage          TokenUsage|null     budget replay
```

Provider instances are cached **per resolved model config** — v1
`ConfigState.providerMemo` (keyed by `JSON.stringify(providerConfig)`), v2
`ModelRequesterImpl.cachedChatProvider`. Any process restart, session
materialization, or config change (`notifyConfigChanged` clears the catalog
cache) rebuilds the provider empty. Engine `history[]` **is** fully replayed
on resume (wire.jsonl → contextMemory), but cursor blobs are proto binaries +
KV round-trips — orthogonal to the JSON history, impossible to rebuild from
it. Result: after any restart, cursor continuations are orphan questions.

Every other provider is stateless (request built purely from `history[]`) and
needs none of this — the adaptation is cursor-native-local by design.

## Official CLI reference (what "right" looks like)

The official CLI persists blobs + metadata in one SQLite `store.db`
(`blobs(id,data)` + `meta(key,value)`) under `~/.cursor/chats/<md5(cwd)>/`.
Recovery reads exactly **one** blob: `metadata.latestRootBlobId` →
deserialize the ConversationStateStructure; everything else loads on demand
from the store. Metadata is a single JSON document written wholesale.

Takeaways: (1) a single JSON snapshot of ids/pointers is the right mental
model; (2) blob content can be loaded lazily because the server cache holds
everything the ids point at; (3) no SQLite needed in omkc — we already have
atomic document storage + append logs.

## omkc persistence landscape

Session layout: `sessions/<workspaceId>/<sessionId>/{state.json,
agents/<agentId>/wire.jsonl, tasks/…}`. Two truths:

- `wire.jsonl` (IAppendLogStore): ordered event records, replayed by
  `EventDispatcherService.restore()` through `executeEvent(event, silent)`
  into replayable states.
- `state.json` (IAtomicDocumentStore): aggregate metadata (title, archive
  flags), not history.

Recovery hooks that already exist (v2):

- `EventDispatcherService.hooks.onDidRestore` — per-agent "replay done"
  (subscribed by e.g. undoService).
- `SessionLifecycleService.onDidCreateSession` (source `resume`).
- Replayable states must be contributed while `restorePhase === 'new'`.

No per-provider persistence precedent exists; the `ChatProvider` interface has
no serialize/lifecycle hooks. This is a first.

## Chosen design — v2 replayable state (option B)

1. **Snapshot state**: `defineState('cursor', …)` registered via
   `agentState.contributeState(cursorStateKey)` with the provider snapshot
   (all 8 fields above, blobStore as a plain record). Replayable → survives
   wire replay automatically.
2. **Save**: a durable event (e.g. `CursorCheckpointUpdated`) dispatched when
   a cursor run finishes (turnEnded / checkpoint / blob callbacks land);
   `durable` makes `WireService.appendRecord` persist it. The event handler
   folds the snapshot into the state.
3. **Load**: after `dispatcher.restore()`, the state already holds the last
   snapshot; the provider (created lazily by `ModelRequesterImpl`) is
   hydrated from `agentState.get(cursorStateKey)` on first `resolveChatProvider`
   — or the provider reads the state service directly to avoid double-keeping.
4. **Isolation**: one snapshot per (session, agent); the per-model provider
   cache must map back to the owning agent's state, not a global.

Size: ~4 files / ~120 lines. The alternative for the v1 fallback engine
(`AgentRecordEvents` + `cursor.blob_state` record, ~80 lines) is documented
but deferred — v1 is on the deprecation path.

## Boundary scenarios (current facts)

### Model switching

Same alias away-and-back with no config change: the catalog cache returns the
same provider instance — state survives. Cross-model turns are invisible to
cursor either direction: non-cursor rounds never produce cursor blobs, and
`rootPromptMessagesJson` cannot express them. Fresh cursor instance (cursor
first used late in a session) starts blank. Short-term: document "model
switch ≠ context inheritance". Mid-term: inject non-cursor segments as text
into `userMessage.text` on switch-back.

### Compaction — broken and silently dangerous

Compaction replaces engine history with a summary; cursor requests never read
history, so they keep replaying the full old blob set — compaction is a no-op
on the wire. Worse, engine token counting is rebased to the small post-
compaction value, so `shouldCompact` may never fire again while the real wire
payload keeps growing toward the window limit. The fix (separate work item)
must be an atomic replacement: on `ContextApplyCompaction`, rebuild the blob
table from kept messages + summary and reset checkpoint/anchor — appending
the summary alongside the old chain would double the context instead.

## Implementation notes

- Event ordering: dispatch the checkpoint event after the response stream is
  fully consumed (turnEnded), not per-blob, to keep wire.jsonl compact.
- blobStore growth: long sessions can reach megabytes. Wire records tolerate
  it short-term; if it becomes a problem, externalize content through the
  engine blob store and keep only ids in the snapshot.
- Fork semantics: replayable state participates in wire slicing, so
  `fork(session, turnIndex)` yields a consistent cursor snapshot — an
  advantage over a sidecar file (which was the reason option C was rejected).
