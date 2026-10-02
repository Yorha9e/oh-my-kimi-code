# Cursor 官方 hooks / SDK changelog：对接结论

> 来源：`https://cursor.com/docs/hooks.md`（64KB）、`https://cursor.com/docs/sdk/changelog.md`（2026-09-03 从官方 `llms.txt` 索引拉取的 `.md` 原文）。

## 1. preCompact：SDK 内部**确实有**自动压缩（推翻此前判断）

此前从 bundle 反推认为"SDK 无可用压缩"，官方文档给出相反结论——`preCompact` 钩子在压缩发生前触发。

输入字段（官方定义）：

```json
{
  "trigger": "auto" | "manual",
  "context_usage_percent": 85,
  "context_tokens": 120000,
  "context_window_size": 128000,
  "message_count": 45,
  "messages_to_compact": 30,
  "is_first_compaction": true | false
}
```

输出：可选的 `user_message`（压缩发生时展示给用户的消息）。

官方定性：**"This is an observational hook that cannot block or modify the compaction behavior."**（仅观测，不能阻断或修改压缩行为。）

**修正后的结论**：

- SDK/后端**自带自动压缩**，触发条件由 `context_usage_percent` 驱动，且暴露 `context_tokens` 与 `context_window_size`——**这正是我们想要的"真实上下文水位"**；
- 但 `preCompact` **只是观测钩子**：我们不能通过它注入自定义压缩策略，也不能阻止压缩；
- 与之前的 bundle 分析不矛盾：`fullContextTokenLimit` 等字段是**服务端 statsig 下发**的配置，客户端无消费点——因为压缩逻辑在**服务端/运行时**，不在我们嵌入的 SDK 客户端里；
- **重大意义**：P2-⑨「上下文兜底自动重开」可能**不必要**——上游已自动压缩。P0-② 的压缩联动也应重新评估：我们需要的是**观测**上游压缩并同步 engine 侧状态，而不是自己触发重建。

### 其他相关 hook 事件

Agent hooks 全集（Cmd+K / Agent Chat）：`sessionStart`、`sessionEnd`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`subagentStart`、`subagentStop`、`beforeShellExecution`、`afterShellExecution`、`beforeMCPExecution`、`afterMCPExecution`、`beforeReadFile`、`afterFileEdit`、`beforeSubmitPrompt`、`preCompact`、`stop`、`afterAgentResponse`、`afterAgentThought`。

- hooks 是**独立进程**，通过 stdio 双向 JSON 通信；可 observe / block / modify（除 preCompact 这种纯观测型）；
- 配置文件：`hooks.json`（项目级 `.cursor/` 或用户级 `~/.cursor/`），也可由插件提供；
- **支持加载第三方工具的 hooks**（含 Claude Code）：见 `docs/reference/third-party-hooks.md`；
- 云端 agent 支持大部分 hook，`sessionStart`/`sessionEnd`/MCP 类/Tab 类/`workspaceOpen` 不支持。

## 2. SDK changelog：版本能力边界（我们锁的是 1.0.30）

changelog 只列到 **1.0.27**（最新条目），而 `package.json` 锁的是 `@cursor/sdk@1.0.30` —— 1.0.28~1.0.30 的变更**未在公开 changelog 中列出**（可能是内部修复或未发布说明）。

按版本的关键能力：

| 版本 | 能力 | 我们的使用 |
|:---|:---|:---|
| 1.0.22 | Local runs 发出 per-turn `usage` 事件，`run.usage` / `RunResult.usage` 累计 | ✅ 我们消费的正是此路径 |
| 1.0.23 | 失败运行暴露结构化错误 `{ message, code }`；local run history 抗中断写入 | ⚠️ **P1-⑥ 错误链路可直接用 `error.code` 分类**，不必解析消息文本 |
| 1.0.25 | `agent.getUsage()`（云端，含费用）；`Agent.getUsage(agentId)` 无需 handle | 计费口径，不作水位 |
| 1.0.26 | `customTools` 在沙箱/auto-review 下**不再报交互式审批错误**；`platform.prewarmLocalWorkspace` 预热；`workspaceScanCacheTtlMs` 控制扫描缓存 | ⚠️ 印证 S6：customTools 无交互式门控 |
| 1.0.27 | `tools` 白名单 / `disallowedTools` 黑名单（public name 或 capability group，如 `"shell"`、`"mcp"`）；**仅 local agent，且 `resume` 后不持久**；浏览器登录 `Cursor.auth.login()`；`getUsage()` 支持 local；`local.dirs` 多根工作区 | 🔶 **`tools` 白名单是 S6 权限边界的官方手段**，但 resume 不持久需每次重传；多根工作区对多目录项目有用 |

**重要**：1.0.27 的 `tools` 白名单说明"**not persisted across `resume`**"——我们的 per-send `local.customTools` 同样每次重传，行为一致，无隐患。

## 3. 对既有结论的修正汇总

| 项 | 此前判断 | 官方修正 |
|:---|:---|:---|
| SDK 是否有压缩 | 无可用压缩，需自建 | **有自动压缩**（服务端驱动），但嵌入方只能观测（preCompact） |
| 上下文水位能否获取 | 需自己记账累计 | `preCompact` 输入直接给 `context_tokens` / `context_window_size`；但**只有压缩发生时才有** |
| 压缩能否被嵌入方控制 | — | **不能**（preCompact 明确 cannot block or modify） |
| 错误分类 | 需解析消息 | `error.code` 结构化（1.0.23+） |
| 权限边界 | 未定性 | `tools`/`disallowedTools` 白黑名单（1.0.27+，local only，resume 不持久）+ customTools 无交互式审批 |

## 4. 由此产生的新待办

- **N1**：确认 preCompact 的 `context_tokens`/`context_window_size` 能否**不经压缩事件**也读到（若只能在压缩时拿到，则水位触发仍需自己记账）；
- **N2**：评估 P2-⑨（自动重开兜底）是否取消——上游自动压缩若可靠，自建兜底属重复建设；
- **N3**：P0-② 重新定位为「观测上游压缩 → 同步 engine 侧状态」而非「触发重建」；
- **N4**：P1-⑥ 改用 `error.code` 分类（1.0.23+ 已结构化）。
