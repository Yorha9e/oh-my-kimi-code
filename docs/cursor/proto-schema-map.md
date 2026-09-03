# agent/v1 proto 字段映射（自建客户端 schema 参考）

> 来源：`@cursor/sdk@1.0.30` bundle 提取（官方生成代码，字段名即 proto name 的 JSON name 形式）+ 网关侧 wire 逆向交叉验证（ho_ee8049ac0d45）。
> 用途：自建纯 API 客户端的唯一字段依据。已由探针 ①③ 实测验证（首帧被上游完整接受）。

## 1. 顶层信封

```proto
message AgentClientMessage {          // client → server 每帧
  oneof message {
    AgentRunRequest run_request = 1;          // JSON: runRequest（探针②验证）
    ExecClientMessage exec_client_message = 2;
    KvClientMessage kv_client_message = 3;
    ConversationAction conversation_action = 4;
    ExecClientControlMessage exec_client_control_message = 5;
    InteractionResponse interaction_response = 6;
    ClientHeartbeat client_heartbeat = 7;
    PrewarmRequest prewarm_request = 8;
  }
}
```

server → client 为 `AgentServerMessage`（oneof: interaction_update(1) / exec_server_message(2) / conversation_checkpoint_update(3) / kv_server_message(4) / exec_server_control_message(5) / interaction_query(7) / ttft_breakdown(8)）。

## 2. AgentRunRequest（首帧）

```proto
message AgentRunRequest {
  ConversationStateStructure conversation_state = 1;   // 必需（可为空对象）
  ConversationAction action = 2;                        // user_message_action 等
  ModelDetails model_details = 3;
  McpTools mcp_tools = 4;
  string conversation_id = 5;
  string custom_system_prompt = 8;                      // 简单字符串版 system prompt
  RequestedModel requested_model = 9;                   // 见下
  string harness = 13;
  string conversation_group_id = 16;
  string dev_raw_model_slug = 18;
  bool client_supports_inline_images = 19;
  string run_id = 25;
  string agent_session_id = 26;
  bool client_supports_routed_model_update = 28;
  SystemPromptSpec system_prompt_spec = 29;             // oneof: replace(1) | append(2) —— string
  ClientLlmGatewayCredential client_llm_gateway_credential = 30;
  repeated PreFetchedBlob pre_fetched_blobs = 17;       // { id: bytes, value: bytes }
}
```

### RequestedModel（探针②的 `ERROR_BAD_MODEL_NAME` 由此修正）

```proto
message RequestedModel {
  string model_id = 1;                    // JSON: modelId（不是 id！）
  bool max_mode = 2;
  repeated ModelParameter parameters = 3; // Param { 1: id(string), 2: value(string) }
  oneof credentials { ApiKeyCredentials api_key_credentials = 4; AzureCredentials = 5; BedrockCredentials = 6; }
  bool built_in_model = 7;
  bool is_variant_string_representation = 8;
}
```

### ConversationStateStructure（探针③验证：可为 `{}`，turns 是 blob id）

```proto
message ConversationStateStructure {
  repeated bytes root_prompt_messages_json = 1;  // blob
  repeated bytes turns = 8;                       // ★ blob id 列表（32B 哈希），内容走 pre_fetched_blobs
  repeated bytes todos = 3;                       // blob
  repeated string pending_tool_calls = 4;
  TokenDetails token_details = 5;                 // 网关观测：f1 当前 token / f2 上限 / f3 分项预算(system_prompt/tools/rules/skills)
  optional bytes summary = 6;                     // blob
  optional bytes plan = 7;                        // blob
  repeated string previous_workspace_uris = 9;
  optional Mode mode = 10;
  map<string, bytes> file_states = 12;
  map<string, FileState> file_states_v2 = 15;
  repeated bytes summary_archives = 13;
  // blob 内容经 AgentRunRequest.pre_fetched_blobs(17) 携带 {id, value}
}
```

**历史续接模型**（重要）：`turns` 只存 blob id；turn 内容（AI SDK UIMessage JSON，Vercel AI SDK v2 形态：role + content[] 判别联合 + providerOptions）以 blob 形式经 `pre_fetched_blobs` 首帧携带。观测到的 content type：`text` / `reasoning`(带 signature) / `redacted-reasoning` / `tool-call`(toolCallId/toolName/args)。

### Action 链

```proto
message ConversationAction { oneof action { UserMessageAction user_message_action = 1; ResumeAction = 2; CancelAction = 3; SummarizeAction = 4; ShellCommandAction = 5; StartPlanAction = 6; ExecutePlanAction = 7; … } }
message UserMessageAction { UserMessage user_message = 1; RequestContext request_context = 2; bool send_to_interaction_listener = 3; repeated UserMessage prepend_user_messages = 4; ConversationHistory conversation_history = 7; }
message UserMessage { string text = 1; string message_id = 2; SelectedContext selected_context = 3; Mode mode = 4; bool rich_text = 8; … }
```

## 3. exec 通道（工具执行，本次新提取）

**语义分工**：服务端把要执行的工具放 `exec_server_message`（oneof case 与工具一一对应），客户端执行后回 `exec_client_message`（**result case 与 args case 同号对应**），双方靠 `id`(uint32)/`exec_id`(string) 配对。工具调用的**模型可见语义**（toolName/args JSON）另行在 `InteractionUpdate.tool_call_*` 明文 JSON 下发。

### ExecServerMessage oneof（42 种 args case）

| no | case | no | case |
|---|---|---|---|
| 2 | shell_args | 23 | write_shell_stdin_args |
| 3 | write_args | 27 | execute_hook_args |
| 4 | delete_args | 28 | subagent_args |
| 5 | grep_args | 29 | redacted_read_args |
| 7 | read_args | 30/31 | force_background_shell/subagent_args |
| 8 | ls_args | 37 | subagent_await_args |
| 9 | diagnostics_args | 38 | smart_mode_classifier_args |
| 10 | request_context_args | 40 | canvas_diagnostics_args |
| 11 | mcp_args | 41/42/43 | shell/mcp/web_fetch_allowlist_precheck_args |
| 14 | shell_stream_args | 44 | git_diff_request |
| 16 | background_shell_spawn_args | 45–52 | pi_read/bash/edit/write/grep/find/ls、mini_swe_agent_bash |
| 17/18 | list/read_mcp_resource_exec_args | 53 | conversation_search_args |
| 20 | fetch_args | 54 | agent_store_conflict_args |
| 21/22 | record_screen/computer_use_args | 56 | adopt_args |

### ExecClientMessage oneof（与 args 同号对应的 result）

`shell_result(2) / write_result(3) / delete_result(4) / grep_result(5) / read_result(7) / ls_result(8) / diagnostics_result(9) / mcp_result(11) / subagent_result(28) / …` 全部与 args 同号。另有公共字段：`id(1, uint32)`、`exec_id(15, string)`、`local_execution_time_ms(39)`、`hook_additional_contexts(45)`。

### 核心工具字段

```proto
message ShellArgs { 1: command, 2: working_directory, 3: timeout, 4: tool_call_id,
                    5: simple_commands(rep), 6/7: has_input/output_redirect,
                    9: requested_sandbox_policy, 10: file_output_threshold_bytes }
message ShellResult { oneof result { 1: success, 2: failure, 3: timeout, 4: rejected,
                    5: spawn_error, 7: permission_denied } + 101: sandbox_policy, 102: is_background }

message ReadArgs { 1: path, 2: tool_call_id, 4: offset, 5: limit, 6: encoding_hint }
message ReadToolSuccess { oneof output { 1: content, 6: data, 9/10: *_blob_id },
                         2: is_empty, 3: exceeded_limit, 4: total_lines, 5: file_size, 7: path }

message WriteArgs { 1: path, 2: file_text, 3: tool_call_id, 5: file_bytes, 6: encoding_hint }

message McpArgs { 1: name, 2: args(map<string,Value>), 3: tool_call_id,
                  4: provider_identifier, 5: tool_name, 8: skip_approval, 9: server_identifier }
message McpResult { oneof result { 1: success, 2: error, 3: rejected,
                   4: permission_denied, 5: tool_not_found, 6: server_not_found, 7: approved } }

message SubagentArgs { 1: tool_call_id, 2: subagent_type, 3: model_id, 4: prompt,
                      5: readonly, 6: resume_agent_id, 7: run_in_background, 9: parent_conversation_id }
```

**权限要点**：`ShellResult.rejected / permission_denied` 与 `McpResult.rejected / permission_denied / approved` 都是**客户端主动可回的结果类型**——自建客户端下，engine 权限门拒绝工具 = 回 `rejected`/`permission_denied`，协议原生支持。

## 4. 错误形态（实测汇总）

| 场景 | 形态 |
|---|---|
| 协议层错误 | `invalid_argument`（如 "First message must be a run request"、"Conversation state is required"、字段 decode 失败） |
| 业务层模型错误 | `not_found + ERROR_BAD_MODEL_NAME` |
| 限额/池错误 | `resource_exhausted + ERROR_RATE_LIMITED_CHANGEABLE / ERROR_RESOURCE_EXHAUSTED("High Load") / ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT`（后者伪装成"版本过旧"文案）——**均在 EOS trailer，HTTP 200** |
| 二进制畸形 | `internal / parse binary: illegal tag: field no 0 wire type 1` |

## 5. 与上游稳定性的对照注记

- 2026-09-03 探针期间出现的 `ERROR_RESOURCE_EXHAUSTED / "High Load"` 是美国区 AI 提供商集体故障所致，非协议/账号问题。
- proto 字段名以本文档为准（SDK 官方生成代码），网关 wire 逆向只给字段号（无名字），两者已在字段号上交叉一致。
