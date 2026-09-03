# Engine 无状态契约 vs Cursor 有状态会话：错配与「全量重建窗口」

> 来源：三家无状态 provider（anthropic.ts / google-genai.ts / openai-responses.ts）与 cursor.ts 的 generate() 对比调研。日期：2026-09-03。

## Engine 的隐式契约

engine 把 provider 当作"**无状态 + 每轮全量**"转发层。证据：

| 维度 | anthropic.ts | google-genai.ts | openai-responses.ts |
|---|---|---|---|
| system prompt | 每轮传完整 `system`（带 cache_control，`anthropic.ts:994`） | 每轮传 `systemInstruction`（`google-genai.ts:865`） | 每轮传 `instructions`（`openai-responses.ts:1143`） |
| history | 每轮全量转换发送，`mergeConsecutiveUserMessages` 合并连续 user（`anthropic.ts:1015`） | 每轮全量 `contents`（`google-genai.ts:861`） | 每轮全量 `input`，且 `store:false`（`openai-responses.ts:1138`） |
| 会话状态 | 无 | 无 | 无 |
| usage | API per-request 透传，天然 per-turn | 同左 | 同左 |
| 工具处理 | 共享 helper：`normalizeToolCallIdsForProvider` + merge 工具 | 同左 | 同左 |

## Cursor 的违背点

`cursor.ts`（789 行）是唯一天然违背该契约的 wire：

1. **system prompt 只在新会话首条生效**：`buildFreshPrompt`（cursor.ts:277）把 systemPrompt 拼进第一条 user 文本；续聊（工具循环 / 重开）不携带。engine 每轮传入的新鲜 systemPrompt（含动态 reminder / plan mode / goal）对模型持续失效；重开会话时 systemPrompt 混进 user 文本累积（脏）。
2. **engine 历史对上游无感**：engine 把完整 `history` 当"要发的上下文"传入，cursor 只摘尾部工具结果（`trailingToolResults`，cursor.ts:241）或最新 user 文本（`buildFreshPrompt`）；全量语义只存在于 SDK 的 `conversation_state` 里。压缩 / 注入 / 回滚在 SDK 侧全部不落地。
3. **重试语义不同**：无状态 provider 重试 = 重发全量（幂等）；cursor `resume` 续聊有顺序依赖，engine 层重试进入 cursor 的行为完全不同（S8，额度敏感：Team 双池每次交互计 1 次）。

## 方案：全量重建窗口（full-snapshot rebuild window）

不是把 cursor 改回无状态（那会丢掉有状态会话的增量效率），而是**在关键事件点用 engine 全量 history 重建 SDK 会话**：

```text
触发事件 → agent.close() + 清 _lastAgentId → Agent.create()
首条消息 = 完整上下文重建包：
  1. 当前 systemPrompt（新鲜注入，而非首轮旧版本）
  2. 压缩摘要 / 完整 engine history 的序列化（替代 SDK 旧 conversation_state）
  3. 最新 user 消息
中间轮次继续走增量续聊（resume + 尾部工具结果）
```

### 候选触发条件

- engine `fullCompaction` 完成（压缩后 SDK 会话与 engine transcript 脱节）
- engine 动态注入关键事件（plan 模式切换、goal 变更、大块上下文注入）
- 重试边界（engine 发起的 turn 重试，避免 resume 顺序错乱）
- 真实上下文水位接近模型窗口（配合 provider 会话水位，依赖 usage 口径修复）
- session 恢复 / 跨进程续接（配合 `_lastAgentId` 持久化）

### 重建包的格式问题（待探索）

- `send()` 的消息 payload 上限未验证：完整 history 序列化后能否塞进一条 user 消息？
- 摘要 vs 全量：全量过大时退回压缩摘要 + 最近 N 轮（沿用 engine 的 transcript 压缩产物）。
- 工具调用的中间态（open tool calls）在重建时如何处理——SDK 是否接受"历史中已解决的 tool exchange"作为纯文本。

### 重建时机约束：只能在 turn 边界重建

engine 的上下文是动态流：system prompt 每轮在变（reminder/plan/goal 注入）、tool 结果持续追加、history 尾部经常是未闭合的 tool exchange（assistant 发了 tool_call → 结果还没回）。turn 中间的流不能重建——open tool_calls 序列化成文本塞进新会话会语义断裂（SDK 当普通文本）。

约束：**重建只在 turn 边界触发**（工具循环收敛、assistant 回复完整后），此时 history 是闭合的。候选触发条件中，压缩完成 / plan 切换 / session 恢复天然是 turn 边界；重试边界 / 水位触发若落在 turn 中间，要么等 turn 收敛，要么只重建已闭合前缀 + 丢弃未闭合尾部（tool 循环重跑，engine 有重试语义兜底）。

### 重建包的三段结构

`send()` 只接受一条用户消息，重建包 = 把动态流折叠成三段：

```text
[新鲜 systemPrompt]   ← engine 当轮传入的最新版本（含动态约束），而非首轮旧版本
[历史折叠段]           ← history 已闭合部分 → 摘要 / 摘要 + 最近 N 轮逐条
[最新 user 消息]       ← history 尾部最后一条 user
```

历史折叠段的体积权衡：全量逐条（含 tool 结果文本）体积大，可能吃掉半个窗口；engine 压缩摘要小但丢细节。中间路线是**摘要 + 最近 N 轮逐条**（N 可配）——与 SDK 自身 compaction 产物同构，应该能吃。多模态方面：`collectImages` 只支持新会话路径，重建正好是新会话，反而是当前唯一能带图的机会。

### 官方权威结论（cursor.com/cn/docs/sdk/typescript，2026-09-03 拉取）

1. **usage 语义确认（P0-① 定性）**：文档明写"`run.usage` 和 `result.usage` 在整个运行过程中始终为**累计值**"（汇总所有上报轮次）；而 `usage` 流事件（`SDKUsageMessage`）"在每个上报用量的轮次结束时触发一次，携带**该轮**的 `TokenUsage`"。→ 我们走的是流事件路径 (`cursor.ts:458`)，**语义上是 per-turn，1.5M 假象另有成因**（很可能是 `inputTokens` 与 cache 计数叠加 / TUI Session-usage 面板的累计账单被误读）。`agent.getUsage()` 是计费用量，**不可用于上下文水位**。
2. **对话状态持久化确认（P0-③ 可行）**：本地智能体把对话状态持久化到主目录 SQLite 检查点；"该存储在进程重新启动后仍会保留，因此在全新的进程中调用 `Agent.resume(agentId)` 可以从上次结束的位置继续"。→ **跨进程 resume 官方支持，`_lastAgentId` 持久化方向正确**。官方推荐的调度器模式即"维护 agentId → SDKAgent 映射，进程重启后从磁盘恢复并 resume"。
3. **`Agent.create()` vs `resume()` 语义**：create 必产生新 agentId（新对话）；续接必须 `Agent.resume(agentId)`。→ **全量重建 = create 新 agent，增量续聊 = resume，边界清晰**。
4. **每次 `send()` 都加载最新检查点传给模型** → 上下文单调累加，SDK 侧无上限约束（与之前结论一致）。
5. **`run.conversation()` 可读取结构化对话历史**（`ConversationTurn[]`，含 assistantMessage 步骤）——这是**重建包的历史来源候选**：可从旧会话读出真实发生过什么，再折叠成文本注入新会话（比用 engine history 更贴近上游视角）。
6. **fast 参数实锤（P1-⑤）**：官方示例 `model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] }` → **`fast` 是独立 model parameter，不是 id 后缀**。现有 `resolveWireModel` 只处理 effort/reasoning，未覆盖 `fast`。
7. **单次运行模型覆盖**：`send({ model })` 覆盖后持续生效，可用于运行时切换模型/ctx 参数（TUI 动态切换的实现入口）。
8. **对话模式**：`send({ mode: "plan" | "agent" })` 可逐轮切换模式——engine 的 plan mode 切换有了原生对接点（优于重建）。
9. **resume 后内联 `mcpServers` 不保留**（含机密信息），需 re-传入或用文件配置——我们的 customTools 走 `local.customTools` 每次重传，无此问题，但需注意 MCP 相关配置。
10. **本地存储可注入（`local.store`）**：默认 SQLite（工作区状态根目录），可选 `JsonlLocalAgentStore`（四文件 NDJSON：agents/runs/run_events/checkpoints），也可实现 `LocalAgentStore` 自定义后端（Redis/Postgres/内存）。`Agent.list/get/listRuns/getRun` 必须与 `resume` 使用同一存储实例才读到相同数据。→ **解决 S5（多会话交错）与 P0-④（孤儿管理）**：我们可为每个 engine session 注入独立 store，或用 `Agent.list` 做归档清理。
11. **自定义工具安全边界（S6 定性）**：`local.customTools` 注册为名为 `custom-user-tools` 的 MCP 服务器，模型经标准 MCP 路径发现调用；"自定义工具无需交互式批准"，**沙箱化与 Auto-review 模式下会直接调用不提示**；拒绝规则与沙箱限额仍适用；且**子智能体（含嵌套）也能使用**。→ 权限控制在 **SDK 侧的 `reject rules` + 沙箱限额**，不是我们这层；需确认我们的 `toSdkCustomTools` 是否依赖了 engine 侧权限门（可能双重门控或漏门）。
12. **钩子只支持文件配置**（`.cursor/hooks.json` / `~/.cursor/hooks.json`），无内联选项；云端运行项目钩子。→ SDK 的 `preCompact` 等 hook 只能由磁盘配置文件提供，SDK 嵌入方不实现 hook executor（与之前 bundle 分析一致：preCompact 属宿主 RPC 服务）。
13. **配置优先级**：每次 send 的内联配置 > create 的内联配置 > 项目文件 > 用户文件 > 团队/仪表盘配置（`cursor_sdk_ts.txt:1890`）。→ 我们的 per-send `local.customTools` 位于最高优先级，会**覆盖**磁盘上的项目配置。
14. **`reload()` 可重读文件系统配置**（钩子、项目 MCP、子智能体）而无需释放资源 → engine 侧配置变更可用它热更新，不必重建会话。

### 与现有 TODO 的关系

- P0-② 压缩联动 = 本方案的第一个触发条件实现。
- S1（system 失忆）= 本方案顺带修复的副作用。
- P0-① usage 口径修复是水位触发条件的前提。
- P0-③ agentId 持久化是 session 恢复触发条件的前提。
