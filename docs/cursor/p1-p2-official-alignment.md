# P1/P2 设计输入：官方（服务端/CLI/SDK）压缩与跨模型证据综合

> 来源三路侦察（2026-09，P0 闭环后）：
> 1. scout：网关文档 + `cursor-tap` 逆向笔记（`D:/vscode/sub2api/gemini-shim/docs/`、`D:/vscode/sub2api/tmp/cursor-tap/`）
> 2. explore：官方 Cursor CLI 反编译产物（`D:/vscode/sub2api/tmp/cursor-cli-official/dist-package/`）
> 3. explore：`@cursor/sdk@1.0.30` 逆向（`D:/vscode/sub2api/tmp/cursor-sdk-rev/`，含重建的 `agent_v1.proto` 6117 行）
>
> 本文档是 P1（本地 compact 联动）与 P2（跨模型切换恢复）的实现依据。行号引用以三份原始报告为准。

## 1. 官方图景（三路证据合并）

### 1.1 checkpoint 语义
- checkpoint = `agent.v1.ConversationStateStructure`（Yo）+ blobStore，**可重放的会话快照**，不是截断锚点。
- 服务端在逻辑阶段结束时经 `AgentServerMessage.conversation_checkpoint_update`（field 3）下发；客户端 `agentStore.handleCheckpoint(blobStore, state)` 落盘，瞬错重试时把 `action` 切成 `resumeAction` 携带 `conversationState` 重放（CLI `index.js` nal_agent_retries）。
- 服务器拼 Prompt 时**顺着客户端下一轮 `AgentRunRequest` 携带的 state 锚点递归展开 `turns`(field 8) 链**——state 是客户端权威（client-authoritative），这是我们全部方案的地基（round2 真机已验证）。

### 1.2 官方压缩（P1 的原型）
- **压缩是服务端行为**：`ConversationAction.summarize_action`(f4) 显式触发；`RunContext.force_summarization`(f75) 强制；流内下发 `SummaryStartedUpdate`(f10)/`SummaryCompletedUpdate`(f11)（抓包实测 8 万条日志中 2 次，间隔 ~34ms）。
- **CLI/SDK 本地零压缩**：CLI 侧 grep `compact|compress|truncat|prune` 无会话压缩逻辑，只有 `CliTranscriptWriter` 用 `rootPromptCount/summaryArchiveCount/lastBlobIdHex` 三元游标消费服务端结果（`summaryArchiveCount` 变化→游标归零全量重写）。
- **压缩结果的状态形态**（原 conversationId 内原位完成，不换会话）：
  - 被压缩历史 → 一个 **role="user" 的 JSON blob**，文本前缀 `[Previous conversation summary]:`（抓包实录）；
  - 状态记账：`summary`(f6)、`summary_archive`(f11)、`summary_archives`(f13，每个 archive 含 `summarized_messages[]` + `summary` + `window_tail` + `summary_message` blob id)、`self_summary_count`(f17) 递增、`message_count_at_last_compaction`(f37) 更新；
  - `turns`(f8) 裁剪：旧 turn id 归档，保留尾部窗口。
- **官方触发判定**：`PreCompactRequestQuery`（proto:3547）：`context_usage_percent / context_tokens / context_window_size / message_count / messages_to_compact / is_first_compaction / conversation_id / generation_id`。

### 1.3 跨模型切换（P2 的原型）
- `AgentRunRequest` 中 `conversation_id`(f5)、`conversation_state`(f1) 与 `requested_model`(f9) 平行；CLI 证据：`conversationId: D.getId()` 实例化后不变，`requestedModel` 每 turn 重建，`lastUsedModel` 是 store.db 独立 metadata。
- **结论：官方切模型 = 只换模型字段，conversationId 与全部历史 turn 原样复用**。协议本身模型无关（rootPrompt 是标准 role JSON）。
- 官方没有"非 cursor 轮"的概念（它只有自家协议）；我们的 P2 缺口（切到其他 provider 的轮次不在 cursor 协议里）是移植特有，官方无现成答案，但**压缩产物的注入形态（user JSON blob turn）就是现成的注入原语**。

### 1.4 conversationId 生命周期
- CLI 默认每次启动新会话（UUIDv4）；`--resume/--continue/-N/ID` 复用；`userMessageAction` = fresh run，`resumeAction` = continuation。
- SDK：`conversation_id` 缺省 → 服务端分配新；`agent-<uuid>` 本地 / `bc-<uuid>` 云。
- 官方"重开会话"仅作兜底（丢失 turn 连续性），不是压缩手段。

## 2. 对我们 P0 的验证

- P0 的快照回灌 = SDK 内部 `loadLatest → AgentRunRequest.conversation_state` 同构，方向正确。
- 我们把历史消息 JSON blob 追加进 `rootPromptMessagesJson`（4cf0b60a4）与服务端拼装行为一致。
- 快照 9 字段无需变更；P1/P2 全部在"生成新快照"一侧做。

## 3. P1 设计（本地 compact 联动）

### 3.1 选定方案：模仿官方压缩后的状态形态（本地伪造服务端压缩结果）

compact（`ContextApplyCompaction`）发生在 cursor session 时，**重建 cursor 协议快照**：

1. 由 compact 管线的摘要文本构造 `[Previous conversation summary]:\n...` 的 role="user" JSON blob（官方抓包形态），编码入 blobStore；
2. 重建 rootPromptMessagesJson：保留 system/rules 头部 + summary 消息 blob（+ compact 保留的尾部消息，若 compact 管线产出 keptMessages）；**丢弃被压缩段落的旧 blob 引用**；
3. 清空 `turnIds` / `promptMessageIds`（旧 turn 不再引用），重置 `latestStateBlobId`（下轮 generate 产生新 anchor）；
4. `conversationId` **不变**（官方原位压缩语义；服务器按 conversationId 关联其侧记录）；
5. 记账字段 `selfSummaryCount`/`messageCountAtLastCompaction`：**首版省略**（proto optional，缺席=默认值；若真机探测发现服务器行为异常再补 v2）;
6. 顺带做 blobStore GC：把不再被任何引用（rootPrompt/turns/anchor）指向的 blob 从快照剔除——**压缩是天然 GC 点**，同时缓解 critic F3（patch 历史放大）与 F8（体积诊断）；
7. 新快照走既有 `CursorCheckpointUpdated` durable 事件 fold（复用 P0 全链路），**不新增事件类型**。

明确不做：真发 `SummarizeAction` 让服务端压缩（依赖服务端对我们指纹的接受度 + 账号消耗，风险收益比差）；`PreCompactRequestQuery` hook（那是服务端回调客户端的钩子，我们触发源用本地 compact 管线）。

### 3.2 接线

- 挂点：v2 侧监听 compact 完成事件（`ContextApplyCompaction` 或 fullCompactionService 完成处，实现时探明确切符号）；
- provider 侧新增公开方法 `compactState(summaryText: string, opts?: { keptMessageBlobs?: … })` → 产出新快照（内部复用 4cf0b60a4 的 blob 编码器）；
- v2 侧 compact 监听器调用后 fold；时序必须在下一轮 generate 之前（compact 本身在轮间，天然满足）。

### 3.3 已知风险

- **服务器是否接受"骤减的 turns/无 archive 记账"的 state**：round2 证明了客户端权威 state 被遵从，但"从全量历史骤减为单 summary turn"未被真机验证过 → **动工前做一次真机探针**（用户配合）：构造 compact 后快照发一轮，确认模型可答且无 unknown blob 风暴。
- compact 后 engine 的 token rebase 可能使 auto-compact 不再触发（HANDOVER §5 旧知）；本轮不做 auto-compact 判定修复，仅保证手动 `/compact` 正确。

## 4. P2 设计（跨模型切换恢复）

### 4.1 选定方案：切回 cursor 时把非 cursor 轮次注入为 user JSON blob turn

- 复用 P1 的注入原语（同一编码器）：切换回 cursor 模型时，收集 contextMemory 中上次 cursor 快照之后的非 cursor 段落，编码为（可选多条）role="user"/"assistant" JSON blob 追加进快照，fold 一次。
- 切走（cursor → 其他）**零动作**：P0 快照持久化已保证状态在；非 cursor provider 无状态，天然不感知。
- 触发点：requester 解析出 cursor provider 且检测到"距上次 fold 后 contextMemory 有非 cursor 产出"→ 注入后 fold。实现时以"最近一次 cursor fold 的轮次游标 vs contextMemory 游标"判定。
- 与官方的差异声明（写进 JSDoc）：官方所有轮都在协议内，无此场景；我们采用与官方压缩产物同构的注入形态，服务器视角等价于"用户转述了中间过程"。

### 4.2 首版边界

- 注入形态统一为 user JSON blob（不做 assistant 双角色首版，简化；官方压缩产物也只用 user 形态）；
- 图片/工具调用等富内容段落首版降级为文本转述；
- 极端场景（cursor → 非 cursor → cursor 快速往返）靠游标幂等，不重复注入。

## 5. 实施切分（tower，建议单 mission 或两 mission）

P1 与 P2 共享注入原语（`rebuildFromMessages`），改动同域（cursorBridge/cursorState/kosong provider + v2 监听器）：

- **M-A（P1）**：provider `compactState()` + blobStore GC + v2 compact 监听 + fold 接线 + 单测（含"快照骤减后往返等值"）；
- **M-B（P2）**：非 cursor 段落收集器 + 注入 + 游标幂等 + 单测；
- scope 重叠在同一链路上，倾向**顺序单 mission**（M-A 完成后 M-B 基于 M-A），或依赖关系 `M-B deps: [M-A]` 两 mission 并行度有限。

前置：真机探针（§3.3）——用户开一个 cursor 会话 → 跑 1-2 轮 → 用我们构造的 compact 快照探针（可先做成本地临时构建或调试命令）→ 确认服务器接受。
