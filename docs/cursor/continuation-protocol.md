# Cursor Native Protocol: Continuation & LLM Request Flow

> Reverse-engineered record of the cursor agent channel wire protocol, as
> implemented in `packages/kosong/src/providers/cursor-native/`. Everything
> here was verified against live traffic (gateway taps) and the official CLI /
> SDK bundles (`agent.v1` protobuf definitions in the dist-package). This is
> the reference for anyone touching the continuation logic or building another
> cursor client.

## The request in one picture

A round-trip has two halves: the **Run request** the client assembles, and the
**blob store** the server reaches into while hydrating it.

```text
AgentClientMessage.runRequest
├─ action.userMessageAction.userMessage      ← current question
│    ├─ text                                 (system prompt folded in, SDK shape)
│    ├─ message_id                           (uuid v4)
│    └─ conversation_state_blob_id  [f10]    ★ state anchor (see §4)
├─ conversationState                         ← what the renderer reads
│    ├─ rootPromptMessagesJson  [f1]         ★ THE context message list (see §3)
│    ├─ turns  [f8]                          ← ConversationTurn blob refs
│    ├─ tokenDetails  [f5]
│    └─ previousWorkspaceUris / activeBranchName / agentType /
│       conversationStartedTimestampMs / conversationStartedTimeZone
├─ requestedModel { modelId, parameters }
├─ conversationId                            (client-issued `agent-<uuid>`)
└─ runId                                     (uuid, per round)
```

Wire format: the JSON channel (Connect bidi stream, length-prefixed frames
with JSON bodies). Blob ids travel as base64 strings; the server answers
`kvServerMessage.getBlobArgs` requests on the same stream and the client must
reply with `kvClientMessage.getBlobResult.blobData` (base64) or the run
deadlocks.

## 1. The blob store is the source of truth

The server content-addresses every message under a 32-byte blob id (base64 on
the wire). During a round it **pushes** blobs (`kvServerMessage.setBlobArgs`)
and later **fetches** them back (`getBlobArgs`). A client must cache every
pushed blob verbatim — the server never re-sends content, and its hydrate
worker blocks forever on an unanswered get.

Blob classes observed on the wire, and how to tell them apart:

| Class | Shape | Role |
|---|---|---|
| root message (system / rules) | plain JSON, `{"role":"system"\|"user","content":"<string>"}` (rules content starts with `<rules`) | initial context; belongs in `rootPromptMessagesJson` |
| round message (user / assistant) | plain JSON, `{"role":"user"\|"assistant","content":[{type:"text"\|"redacted-reasoning",...}]}` | the actual conversation turns; **also** belongs in `rootPromptMessagesJson` (§3) |
| user turn | binary proto `UserMessage`: f1 text, f2 message_id, f3 selected_context, f10 conversation_state_blob_id, f17 thread_id, f25/f26 timestamps | referenced by `AgentConversationTurn.f1` |
| native step | binary proto `ConversationStep` oneof: f1 assistant_message / f2 tool_call / f3 thinking_message | referenced by `AgentConversationTurn.f2[]` |
| state pack | binary proto `ConversationStateStructure` (mini: f1 roots ×2, f5 tokenDetails, f8 turns, f9/f19/f22/f26/f27 workspace) | the state-anchor chain (§4) |
| aggregate pack | binary, f1 opens with a nested `0a 20` (32B blob reference) | index of prior state; not a message |

Discriminating rules that survived every probe:

- JSON text (`{` first byte) is always a **message**, never a pack. The old
  rule "JSON = state snapshot" silently dropped the assistant answer and left
  continuations memoryless.
- A binary blob whose f1 payload is bare readable text is a **UserMessage**;
  one whose f1 payload opens with another `0a` tag is a **ConversationStep**
  (its oneof member). Reading a bare-text payload as proto surfaces a
  meaningless field 2 and mis-classifies real turns.
- Whether an inner `field 2` is a string (wt 2 → `message_id` → turn) or a
  varint (wt 0 → timestamp → step) — counting inner fields does not work: a
  step's text+timestamp pair has just as many fields as a turn's
  text+messageId pair.
- A pack's field 1 either holds a 32-byte blob id directly (`0a 20 …`) or
  nests a proto that does (`0a <len> 0a 20 …`).

## 2. `AgentConversationTurn` — the four-level reference structure

`turns` elements are parsed as `ConversationTurn`, whose single field wraps an
`AgentConversationTurnStructure` (source-verified field list):

```proto
AgentConversationTurnStructure {
  1: user_message   // 32B blob id — NOT an embedded body
  2: steps          // repeated 32B blob ids
  3: request_id     // uuid string of the round that produced the turn
  4: encrypted_model, 5: dynamic_tool_count, 6: send_message_step_indices,
  7: routed_model_display_name  // optional
}
ConversationTurn { 1: agent_conversation_turn }  // this one IS embedded
```

The official consumer (CLI source) walks it like this:

```js
getBlob(turns[i])            → ConversationTurn
  .agentConversationTurn
  getBlob(user_message)      → UserMessage        // f1 is an id again!
  for (step of steps) getBlob(step) → ConversationStep
```

Two hard rules learned the expensive way:

- **Never embed message bodies.** The declared proto type says "message" but
  the semantics are 32-byte blob-id references. An embedded 140B UserMessage
  gets looked up as a KV key, fails, and the failure shape drifts with the
  bytes — the source of every `illegal tag: field no N` /
  `invalid end group tag` / `invalid varint` / `cant skip wire type 4` /
  `premature EOF` error we saw. (The last one is a protobuf `RangeError`
  thrown when a varint timestamp is read as a string length.)
- **Reference server-issued blobs.** Steps must point at the native step
  blobs the server itself pushed (thinking first, then assistant — the replay
  order). A self-built step id resolves to nothing in the server cache and is
  silently skipped (`if (!s) continue`), which starves the model of the
  previous answer and sends it rummaging through the account summary — the
  origin of the hallucinated "2051"/"302" answers.

## 3. `rootPromptMessagesJson` is THE context message list

This is the single most counter-intuitive fact of the protocol, and the one
that closed the loop: despite the name, `rootPromptMessagesJson` (field 1,
repeated bytes) is **the full message list handed to the LLM** — not just
system prompts.

```text
rootPromptMessagesJson = [
  system blob,          // {"role":"system", ...}        2286B
  rules blob,           // {"role":"user","content":"<rules>…"} 12948B
  round1 user blob,     // {"role":"user", …}            576B   ← history
  round1 assistant blob // {"role":"assistant", …}       478B   ← history
]
```

The server expands these into its Messages array in order:
`system → rules → round1 user → round1 assistant → round2 question`. Leave
the round's user/assistant blobs out and the model only sees system + rules —
it then invents answers from whatever account-level summary it can reach,
while `inputTokens` stays flat. With them in, `inputTokens` jumps by the
history size and recall is exact.

So the continuation recipe is, in full:

1. Track every message blob the server issues, in arrival order
   (`classifyBlob` in `index.ts`).
2. On the next generate, set `rootPromptMessagesJson` to
   `[…initial roots, …round message blob ids]`.
3. Set `turns` to the wrapped `ConversationTurn` blob id (§2).
4. Mount the question with a state anchor (§4).

## 4. The state anchor — `UserMessage.f10`

`UserMessage.conversation_state_blob_id` (field 10) is not decoration. The
server's rewind projection skips any message whose anchor is empty, and the
prompt renderer builds history by **recursively expanding the anchor**, not by
reading the request's `turns` parameter:

```text
conversationStateBlobId ──▶ State blob ──f8──▶ turn blob ──▶ user/steps
                    (turns param only APPENDS to the NEXT state blob;
                     it is never read for the current prompt)
```

Anchoring rules:

- The **initial** state pack the round's own user turn points at contains zero
  turns — anchoring round 2 there yields an empty history (delta −6).
- A **turn blob used as an anchor** is worse: it gets parsed as a
  ConversationState, its f1 (user text) is mis-assembled as root prompt
  content (+9562 tokens of noise), and its missing f8 still yields zero
  history.
- The working anchor is a **ConversationState blob whose f8 references the
  round's turn** — either the one the server SETs at round end, or a client-
  built one: base state bytes + `0x42 0x20 <32B turn id>` appended (repeated
  field, appending is wire-equivalent), sha256-addressed, registered in the
  client blob store.

## 5. Other request fields that matter

- `conversationId`: client-issued `agent-<uuid>` (the UUID part is locally
  generated per the CLI source; the server claims the session under the
  client-provided id). Reuse it across rounds — a round2-only id has no
  session.
- `tokenDetails` (f5): `{usedTokens, maxTokens, breakdown}` — the CLI replays
  the server-issued budget on resume. We synthesize it from the previous
  run's usage with a 200k default cap.
- Model parameters ride `requestedModel.parameters` as
  `{id, value}` string pairs (e.g. `effort`); `customSystemPrompt` must stay
  unset — the upstream turns it into a CLI `--system-prompt` flag that only
  accepts file paths.
- Free-plan accounts can only use the `default` (Auto) model; named models
  like `composer-2.5` require quota. Auto routing may produce assistant
  content with `reasoning`+`signature` instead of `redacted-reasoning`+`data`
  — the server expects the latter shape and fails to parse its own output on
  that path; use a named model for continuation testing.

## 6. Error taxonomy (what each parse error implied)

| Error | Actual meaning |
|---|---|
| `illegal tag: field no N wt M` (N drifts with content) | JSON text being parsed as proto (0x7b = a start-group tag) — history content reached the parser in the wrong container |
| `invalid end group tag` | same family; group end without start |
| `invalid varint` | varint encoding illegal — recursion mis-read a message body as a proto stream |
| `cant skip wire type 4` | parser landed mid-body on a group-end byte |
| `premature EOF` | protobuf `RangeError`: a length prefix (often a varint timestamp read as a string length) outran the buffer |
| `field no 0` | length-prefix misalignment — the parser started inside data |
| silent skip, flat `inputTokens`, "not mentioned" answers | structure parsed fine but referenced ids resolve to nothing (`if (!s) continue`); check anchor + blob-id references first |

## 7. Verification checklist for any change here

1. `pnpm -C packages/kosong run build` then `npx vitest run --project kosong`.
2. Local frame audit before any live request: build the first frame and
   confirm `rootPromptMessagesJson` = roots + message blobs (arrival order),
   `turns` = one ConversationTurn blob id whose f1/f2 are 32-byte ids of
   server-issued blobs, `userMessage.conversationStateBlobId` = a state blob
   whose f8 references that turn.
3. Live two-round probe: round1 notes a fact, round2 asks for it back.
   Success = round2 answers the fact verbatim and `kvDiagnostics` shows all
   gets hitting. `inputTokens` delta ≈ +history size confirms the mount.
