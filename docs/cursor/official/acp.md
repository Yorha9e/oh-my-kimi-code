# Cursor 官方 ACP 文档：对接结论

> 来源：`https://cursor.com/docs/cli/acp.md` 与 `https://cursor.com/docs/cli/reference/parameters.md`（2026-09-03 经代理 `127.0.0.1:10808` 从官方 `llms.txt` 索引拉取的 `.md` 原文）。
>
> 对 kimi-code 社区版的意义：ACP 是 cursor 官方暴露的**宿主协议**，与我们 engine 的 ACP server（`packages/acp-server`）同协议族，是多 harness 协作（DSH④）的现成对接面。

## 1. 传输与协议

- 启动：`agent acp`（CLI 隐藏命令，"intended for custom ACP clients and advanced integrations"）。
- 传输：stdio；信封：JSON-RPC 2.0；分帧：newline-delimited JSON（一行一条）；client 写 stdin，Cursor CLI 写 stdout，日志走 stderr。
- 请求流：`initialize` → `authenticate`（`methodId: "cursor_login"`）→ `session/new`（或 `session/load`）→ `session/prompt` → 处理 `session/update` 通知 → `session/request_permission` 回决策 → 可选 `session/cancel`。

## 2. 会话 / 模式 / 权限

- 会话：`session/new` 创建，`session/load` 恢复既有对话。
- **模式三种**：`agent`（完整工具）、`plan`（规划、只读）、`ask`（问答、只读）。注意 CLI `--mode` 文档写的是 `plan` 或 `ask`，SDK `send({mode})` 示例写的是 `"plan" | "agent"` —— **`ask` 模式在 SDK 侧未出现**，逐轮切换时以 SDK 声明为准。
- 权限：工具需审批时发 `session/request_permission`，客户端回 `allow-once` / `allow-always` / `reject-once`。**若客户端不回答，工具执行会阻塞**。
- MCP：支持项目级/用户级 `.cursor/mcp.json`；**团队级 MCP（dashboard 配置）在 ACP 模式下不支持**。

## 3. Cursor 扩展方法（关键）

两类：**阻塞型**（agent 等待响应）与**通知型**（fire-and-forget）。

| 方法 | 类型 | 用途 |
|:---|:---|:---|
| `cursor/ask_question` | 阻塞 | 向用户提多选题，agent 阻塞等答 |
| `cursor/create_plan` | 阻塞 | 请求明确的计划审批（含 plan markdown + todos + phases） |
| `cursor/update_todos` | 通知 | todo 状态更新（`merge` 控制合并/整体替换） |
| `cursor/task` | 通知 | **subagent 任务通知** |
| `cursor/generate_image` | 通知 | 生成图片通知 |

### `cursor/task` 对 subagent 接线的价值

```ts
interface CursorTaskRequest {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType: "unspecified" | "computer_use" | "explore" | "video_review"
              | "browser_use" | "shell" | "vm_setup_helper" | { custom: string };
  model?: string;
  agentId?: string;   // ← 设为先前创建的 subagent 即可恢复
  durationMs?: number;
}
```

- `subagentType` 支持 `{ custom: "your_type" }` → **可映射我们 engine 的 subagent profile 名**；
- `agentId` 可恢复先前 subagent → 与 SDK 的 `Agent.resume(agentId)` 呼应，**subagent 生命周期也有原生持久化**；
- 响应回 `{outcome:"completed", agentId?, durationMs?}` → 可用于我们的 subagent 树/时间线（DSH①-1b2）。

### 其他方法对 engine 的映射

- `cursor/ask_question` ↔ engine 的交互式询问（我们 P0 里的"回退链兜底：交互式询问并填入"有现成协议）；
- `cursor/create_plan` ↔ Plan 模式审批（比 SDK `send({mode:"plan"})` 更结构化，带 todos/phases）；
- `cursor/update_todos` ↔ engine TodoList 的跨进程同步（我们的 TodoList 目前无 description 字段，ACP 侧的 content/status 可直接对接）。

## 4. 认证

- ACP 声明 `cursor_login` 为 auth method；实际可预先用 CLI 路径认证：`agent login`、`--api-key` / `CURSOR_API_KEY`、`--auth-token` / `CURSOR_AUTH_TOKEN`。
- 端点与 TLS 选项从根命令传：`agent -e https://api2.cursor.sh acp`、`agent -k acp`。

## 5. CLI 参数补充（parameters.md）

- `--model <model>`、`--mode <mode>`、`--plan`、`--list-models`、`--resume [chatId]`、`--continue`（= `--resume=-1`）。
- `--sandbox <enabled|disabled>`、`--approve-mcps`、`--trust`（headless）、`--workspace`、`--plugin-dir`、`-w/--worktree`。
- 子命令：`acp`、`ls`（恢复会话）、`resume`、`create-chat`、`worker`、`mcp`、`sandbox` 等。

## 6. 对社区版接线的结论

| 我们的目标 | 官方现成面 | 结论 |
|---|---|---|
| 多 harness 协作（DSH④） | cursor CLI 原生 ACP server（stdio + JSON-RPC） | **可对接**：我们的 `acp-server` 与 cursor `agent acp` 同协议族，跨 harness 有标准通道，无需自研 |
| subagent 生命周期/树 | `cursor/task` 的 `agentId` 恢复 + `subagentType` 自定义 | SDK 侧 `Agent.resume` + ACP 侧 `cursor/task` 双通道可用 |
| Plan 模式 | `send({mode})` 逐轮切换 + `cursor/create_plan` 阻塞审批 | 两种粒度都有，不必靠会话重建 |
| 权限门控 | `session/request_permission` | 与 SDK `local.customTools` 的"无需交互式批准"形成对照：**走 ACP 有门控，走 SDK customTools 无门控**（S6 安全面） |
| 交互式询问兜底 | `cursor/ask_question` | 现成协议，可接 engine 回退链 |

## 7. 注意点

- SDK 文档说自定义工具"无需交互式批准"，而 ACP 文档说"若不回答权限请求，工具执行会阻塞"——**两条路径的权限模型不同**，接入时需明确我们走哪条（当前 cursor provider 走 SDK customTools 路径 = 无交互式批准，权限依赖 SDK 侧 reject rules + 沙箱）。
- 团队级 MCP 在 ACP 模式不支持，接入时若依赖团队 MCP 配置需注意。
