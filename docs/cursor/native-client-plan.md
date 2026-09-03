# Cursor Native Client 施工计划（tower 工作流任务书）

> 日期：2026-09-03。目标：以**自建纯 API 客户端**替代 `@cursor/sdk` 内置 agent 运行时，消除 N4 安全漏洞（内置工具绕过 engine 权限门），并使 cursor wire 与 anthropic/openai/google 三家 provider 同构。
> 所有协议知识已实测验证，schema 已固化。本文档是 tower 各 mission 的唯一权威依据。

## 0. 已验证事实（施工前提，不需要重新调研）

| 知识 | 来源 |
|---|---|
| Connect bidi 帧格式：`1B flags + 4B BE len + payload(JSON)`；flags bit0=gzip、bit1=EOS trailers | `docs/cursor/proto-schema-map.md` |
| 首帧形态（探针③c + SDK 判别实验双重验证）：`{"runRequest":{action,requestedModel,runId,conversationState:{}}}` | `verification-log.md` 探针①③ |
| `RequestedModel.modelId`（非 id）+ `parameters[{id,value}]` | `proto-schema-map.md` §2 |
| `ConversationStateStructure.turns` = blob id 列表；历史内容经 `preFetchedBlobs`(17) 携带 AI SDK UIMessage JSON blobs | 同上 §2 |
| exec 通道：42 种工具 args（ExecServerMessage）→ 同号 result（ExecClientMessage），靠 `id`/`exec_id` 配对 | 同上 §3 |
| 权限拒绝 = 客户端主动回 `rejected`/`permission_denied`（Shell/Mcp Result 的原生 case） | 同上 §3 |
| 错误分类：`invalid_argument`(协议) / `not_found+ERROR_*`(业务) / `resource_exhausted`(池/EOS trailer, HTTP 200) | 同上 §4 |
| 身份头必需：`x-cursor-client-type: sdk` + `x-cursor-client-version: sdk-1.0.30` + `x-request-id` | `official/` + fingerprint 文档 |
| token 供给：走网关 `/api/cursor/token`（轮转可用账号）；**不要用本地 IDE token** | 探针附加发现 |
| usage 语义：流事件 per-turn（input/cacheRead/cacheWrite/output）；EOS trailer 才有错误 | 探针① + proto-schema §4 |
| 网关：`https://127.0.0.1:51443`（生产 51142），原生路径 `/agent.v1.AgentService/Run` 直接代理 | ho_843a375ba56c |

**约束**：
- 真机请求节制（Team 双池额度；探针只用于验收节点）；
- High Load 期间不阻塞开发——协议层已知，真机只验证最终产物；
- 不改动 `packages/agent-core-v2/`、`kap-server/`、transcript 相关注释禁区（repo AGENTS.md）；
- 提交不带 co-author。

## 1. 架构设计（已定，不要重新设计）

```
packages/kosong/src/providers/cursor-native/     ← 新目录，与 cursor.ts（旧 SDK 路线）并存
├── frame.ts          Connect bidi 帧编解码（envelope + EOS trailer 解析）
├── run-stream.ts     Run 流客户端：建连（fetch + connect+json）、发帧、收帧迭代器
├── conversation.ts   engine Message[] ↔ ConversationStateStructure/blob 的映射
├── exec-tools.ts     exec 通道：工具 args 解码 → engine toolExecutor → result 编码回传
├── errors.ts         错误分类（invalid_argument/not_found/resource_exhausted → kosong 错误）
└── index.ts          CursorNativeChatProvider implements ChatProvider
```

**关键接口对齐**（与三家同构）：
- `generate(systemPrompt, tools, history, options)` → `StreamedMessage`
- 流事件映射：`textDelta` → text part、`thinkingDelta` → think part、`toolCall*` → function call（交 engine 执行——**这是 N4 修复的本质**）、`turnEnded` → usage、EOS trailer error → 抛出对应错误类型
- 工具循环：engine 的 toolExecutor 执行（权限门/hooks/yolo 全部生效）→ 结果编码为 `exec_client_message` 回传 → 服务端继续流
- systemPrompt → `system_prompt_spec`(29, append 模式) 或 `custom_system_prompt`(8)（探针④后实验定）

## 2. Mission 拆分

### M1 — 帧层 + Run 流客户端（纯本地，无真机）
**scope**: `packages/kosong/src/providers/cursor-native/{frame,run-stream,errors}.ts`
**任务**:
1. `frame.ts`：encode（string → envelope Buffer）、decode 迭代器（bytes → {flags, payload}，处理粘包/半包）、EOS trailer 解析（gzip + JSON error 提取）
2. `run-stream.ts`：`openRunStream(gatewayUrl, token, firstFrame)` → AsyncIterable<ServerFrame>；含身份头注入、token 注入
3. `errors.ts`：EOS trailer error → 分类（`CursorProtocolError` / `CursorModelError` / `CursorResourceError`），保留 `debug.error` 代码与 `isRetryable`
**验收**: 单元测试（帧编解码 roundtrip、粘包处理、trailer 解析）全绿；无网络依赖
**依赖**: 无

### M2 — 对话映射层（纯本地，无真机）
**scope**: `packages/kosong/src/providers/cursor-native/conversation.ts`
**任务**:
1. engine `Message[]` → 首帧 `action.userMessageAction` + `conversationState`（首轮：空 state + user text；续轮：`preFetchedBlobs` 携带 AI SDK UIMessage JSON blobs + `turns` id 列表）
2. AI SDK UIMessage 形态适配：kosong Message → `{role, content[], providerOptions}`（content type: text/reasoning/tool-call）
3. usage 事件映射：`turnEnded` {input/output/cacheRead/cacheWrite/reasoning} → kosong `TokenUsage`
**验收**: 单元测试覆盖首轮/续轮/含工具历史三种映射；无网络依赖
**依赖**: M1（类型引用）

### M3 — exec 工具循环（纯本地，无真机）
**scope**: `packages/kosong/src/providers/cursor-native/exec-tools.ts`
**任务**:
1. `ExecServerMessage` oneof 解码（42 case 中先支持核心 8 种：shell/read/write/grep/ls/delete/mcp/fetch；其余 case 显式报"unsupported tool"回 `failure` result，不 crash）
2. 与 engine `HostToolExecutor` 对接：args 转换（如 `ShellArgs.command/working_directory/timeout`）→ `executor(name, args)` → 结果编码为对应 `*Result`（success/failure/rejected/permission_denied 由 executor 的 isError 与 engine 权限判定决定）
3. `ExecClientMessage` 编码回传（保持 `id`/`exec_id` 配对）
**验收**: 单元测试（每种核心工具的 args→executor→result roundtrip；unsupported case 优雅降级）
**依赖**: M1

### M4 — Provider 组装 + 真机验收（依赖上游池恢复）
**scope**: `packages/kosong/src/providers/cursor-native/index.ts` + 真机探针
**任务**:
1. `CursorNativeChatProvider implements ChatProvider`：组装 M1-M3；`withThinking` 沿用 clone 范式（effort → `RequestedModel.parameters`）
2. 真机探针：完整对话（text_delta + turn_ended + usage 断言）→ 工具对话（engine executor 被调用 + result 回传后流继续）
3. 与旧 `cursor.ts` 并存（不删除），导出切换由后续 PR 决定
**验收**: 真机探针全绿（text/usage/tool 三断言）；`pnpm -C packages/kosong test` 全绿
**依赖**: M1+M2+M3；上游 High Load 恢复

### M5（后置，单独评审）— 旧路线处置
SDK 路线（cursor.ts）与新路线并存的切换决策、`tools:["mcp"]` 白名单备用方案、`@cursor/sdk` 依赖移除——**不在本次 tower 范围内**，M4 验收后单独讨论。

## 3. 明确不做（防 scope 蔓延）

- 不实现 `interaction_query` 处理（122 dump 零出现；收到时按 unsupported 记日志）；
- 不实现多模态（image_in 续聊本来就不通，S4 另行修复）；
- 不动 `cursor.ts` 旧路线的行为（除了 import 不冲突）；
- 不做 `system_prompt_spec` 实验以外的新字段实验；
- 不建新包/新 workspace——全部在 `packages/kosong` 内。

## 4. 验收总标准

1. `pnpm -C packages/kosong test` 全绿（新增单测 + 原有全量不回归）；
2. 真机探针三断言全绿：纯文本对话（text_delta 组装正确 + turnEnded usage 合理）→ 工具对话（executor 被调 + 回传后流继续）→ 错误注入（EOS trailer 错误被正确分类抛出）；
3. TypeScript 编译零错误；
4. AGENTS.md 禁区无改动。

## 5. 背景资料索引（worker 必读）

| 文档 | 内容 |
|---|---|
| `docs/cursor/proto-schema-map.md` | 全部 proto 字段（权威） |
| `docs/cursor/verification-log.md` | 探针历史 + 首帧形态演化 |
| `docs/cursor/exploration-api-client-feasibility.md` | 架构决策背景 |
| `packages/kosong/src/providers/cursor.ts` | 旧路线（withThinking clone 范式参考；toolExecutor 接口形态参考） |
| `packages/kosong/src/provider.ts` | ChatProvider 接口契约 |
| 网关 `docs/cursor-run-stream.md`（D:/vscode/sub2api/gemini-shim） | wire 逆向交叉参考 |
