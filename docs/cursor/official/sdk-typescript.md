# Cursor SDK 官方文档：权威结论摘录

> 来源：`https://cursor.com/cn/docs/sdk/typescript`（2026-09-03 通过代理 `127.0.0.1:10808` 拉取，转为纯文本存于 `/tmp/cursor_sdk_ts.txt`，约 118KB）。
>
> 本文只摘录对「cursor provider ↔ engine 接线」有决策价值的官方表述，并标注对应的本地代码位置。完整文档见原文。

## 1. Usage 语义（决定 P0-① 走向）

官方原文：

- "`run.usage` 和 `result.usage` 在整个运行过程中始终为**累计值**。"
- `usage` 流事件（`SDKUsageMessage}$`）"会在每个上报用量的轮次结束时触发一次，并携带**该轮**的 `TokenUsage`。"
- `agent.getUsage()` 获取的是"**计费** token 用量和美元费用"，另注"令牌计数由运行时报告，不代表费用"。

字段定义：`TokenUsage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens? }`，且 `totalTokens = input+output+cacheRead+cacheWrite`，`reasoningTokens` 是 `outputTokens` 的子集不复算。

**对我们的结论**：

- 我们消费的是流事件（`packages/kosong/src/providers/cursor.ts:458` 的 `case 'usage'`），**语义是 per-turn，口径本身正确**；
- 因此 TUI 的 1.5M 假象**不是** SDK 累计导致，需要转向排查：cache 计数叠加、`mapUsage`（cursor.ts:384）的字段映射、TUI `Session usage` 面板（`usage-panel.ts:102` `buildSessionUsageSection`，按模型累加每轮 input+output）的累计账单被误读为上下文；
- `agent.getUsage()` **不可用作上下文水位**（它是计费口径）。

## 2. 对话状态持久化与跨进程续接（P0-③ 可行）

官方原文：

- "本地智能体会将对话状态持久化到检查点存储中……每次调用 `agent.send()` 都会加载该智能体的最新检查点并传递给模型……该存储在进程重新启动后仍会保留，因此在全新的进程中调用 `Agent.resume(agentId)` 可以从上次结束的位置继续。"
- "`Agent.create()` 每次都会使用新的 `agentId` 创建一个全新的智能体。若要继续现有对话，请在首次调用时获取 `agent.agentId`，之后使用 `Agent.resume(agentId)`。"
- 官方推荐调度器范式：维护 `agentId → SDKAgent` 映射，"如果进程重启导致内存中的映射丢失，则从磁盘恢复并调用 `Agent.resume()`"。

**对我们的结论**：`_lastAgentId` 持久化方向正确且受官方支持；重建 = `create`（新会话），续聊 = `resume`（续接），边界清晰。

## 3. 本地存储可注入（解 S5 + P0-④）

官方原文：默认 SQLite（工作区状态根目录），否则回退 `JsonlLocalAgentStore`。三种后端：

| 存储 | 导入 | 适用 |
|---|---|---|
| `SqliteLocalAgentStore` | `@cursor/sdk/sqlite` | 工作区状态根目录下基于磁盘的 SQLite |
| `JsonlLocalAgentStore` | `@cursor/sdk` | 指定目录的 NDJSON（`agents.ndjson`/`runs.ndjson`/`run_events.ndjson`/`checkpoints.ndjson`），便于查看/复制/diff |
| 自定义 | 实现 `LocalAgentStore` | 内存、Redis、Postgres 等 |

"`Agent.list`、`Agent.get`、`Agent.listRuns`、`Agent.getRun` 中**使用同一存储实例**，确保它们读取相同的数据。" 也可用 `Cursor.configure({ local: { store } })` 设进程级默认。

**对我们的结论**：可为每个 engine session 注入独立 store（解决 S5 多会话交错），并用 `Agent.list` 实现旧会话归档清理（P0-④）。注意 `local.store` 仅对本地智能体生效。

## 4. 自定义工具与权限边界（S6 定性）

官方原文：

- "`local.customTools` 传入后，SDK 会将其注册为名为 `custom-user-tools` 的 MCP 服务器。智能体会通过与其他服务器相同的 MCP 路径发现并调用它们。"
- "拒绝规则和沙箱限额仍然适用，但**自定义工具无需交互式批准**，因此沙箱化和 Auto-review 模式运行会**直接调用它们，不会提示**。"
- "自定义工具也可供子智能体（包括嵌套子智能体）使用。"
- 自定义工具仅适用于本地智能体；传云端会抛 `ConfigurationError`。

**对我们的结论**：权限控制在 SDK 侧的 reject rules + 沙箱限额，不在我们的 executor 层；需确认 `toSdkCustomTools` 与 engine 权限门的关系（可能双重门控或漏门）。

## 5. 钩子（hooks）与 preCompact

官方原文：钩子"无 [内联选项] — 仅支持文件配置"（`.cursor/hooks.json` + `~/.cursor/hooks.json`）；云端运行项目钩子，企业版还运行团队/企业钩子。

**对我们的结论**：SDK 的 `preCompact` 等 hook 只能由磁盘配置文件提供，SDK 嵌入方不实现 hook executor（与 bundle 分析一致：hook 属宿主 RPC 服务）。**不能指望通过 SDK 内部压缩控制上下文**。

## 6. 模型参数与 per-send 覆盖（P1-⑤ + TUI 切换）

官方原文与示例：

```ts
const run = await agent.send("Plan the refactor", {
  model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
});
```

- "传递给 `agent.send()` 的 `model` 会覆盖智能体在该次运行中的模型选择，**之后会持续生效**：后续发送时若未指定覆盖，将继续使用新模型。"
- "`run.model` 和 `result.model` 反映该次运行实际使用的模型选择，且运行开始后不可更改。"

**对我们的结论**：

- **`fast` 是独立 model parameter**（`{id:"fast", value:"true"}`），**不是模型 id 后缀**——现有 `resolveWireModel`（cursor.ts:757）只处理 `effort`/`reasoning`，未覆盖 `fast`，这是 `-fast` 后缀解析失败的根源；
- per-send `send({ model })` 覆盖后持续生效 = **TUI 动态切换模型/ctx 的原生入口**（对应 P1-⑤ 的 ctx 切换诉求）。

## 7. 对话模式逐轮切换（P1-⑤b，可替代部分重建）

官方原文："在 `Agent.create()` 中设置 `mode`，以确定首次运行的模式。在后续的 `agent.send()` 调用中，省略 `mode` 可保留对话当前的模式；传入 `mode` 则**仅切换该次运行的模式**。" 取值 `mode: "plan" | "agent"`。

**对我们的结论**：engine 的 plan mode 切换有原生对接点，**不必靠会话重建**。

## 8. 其他

- **配置优先级**（原文 1890 行附近）：`send()` 内联 > `create()` 内联 > 项目文件 > 用户文件 > 团队/仪表盘配置。我们的 per-send `local.customTools` 位于最高优先级，会覆盖磁盘项目配置。
- **`reload()`**："重新读取文件系统配置（钩子、项目 MCP、子智能体），无需释放资源" → engine 侧配置变更可热更新，不必重建会话。
- **`run.conversation()`**：返回 `ConversationTurn[]`（智能体轮次含步骤 / shell 轮次含命令与输出），"无需订阅实时流，即可用它渲染或持久化该运行的结构化历史记录" → **全量重建的历史来源候选**（上游视角的真实对话，优于序列化 engine history）。
- **resume 后内联 `mcpServers` 不保留**（含机密信息），需重新传入或用文件配置。
- **`requestId`**：每次 `send()` 生成 UUID，贯穿 Run/RunResult/错误，用于与后端日志关联 → 可用于我们的链路追踪。
- **取消**：`run.cancel()` 使状态变 `cancelled`，"正在进行的工具调用将停止"，部分输出保留。
