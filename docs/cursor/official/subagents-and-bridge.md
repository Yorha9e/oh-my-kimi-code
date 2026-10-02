# Cursor 官方 subagents / sdk-bridge 文档：对接结论

> 来源：`https://cursor.com/docs/subagents.md`、`https://cursor.com/docs/sdk/bridge.md`（2026-09-03 经代理 `127.0.0.1:10808` 从官方 `llms.txt` 索引拉取的 `.md` 原文，全量 243 篇已下载至 `/tmp/cursor_md/`，2.9MB）。

## 1. 模型参数官方语法（**解答 ctx/fast 的正规写法**）

官方文档「Model parameters」：给模型 id 追加方括号设置 per-model 选项，形如 `id=value` 对，多个用逗号分隔。

| 示例 | 行为 |
|:---|:---|
| `composer-2.5[]` | 钉住基础模型。空括号选标准变体而非 fast 变体 |
| `composer-2.5[fast=false]` | 显式选标准（非 fast）变体 |
| `claude-opus-5[effort=high]` | 推理强度设为 `high` |
| `claude-opus-5[context=300k]` | **上下文窗口设为 300k tokens** |
| `claude-opus-5[effort=high,context=300k]` | 组合多个选项 |

官方明确："Available options depend on the model, and use the same `id=value` pairs as the SDK's model parameters."

**对我们的结论**：

- **`context` 就是此前待定的 ctx 字段**——官方语义是"上下文窗口大小"（如 `300k`），与 `effort`、`fast` 并列为方括号内的 `id=value` 参数；
- 三个参数（fast / effort / context）**同一套语法、同一套底层 model parameter 机制**，只是 subagent frontmatter 用方括号糖，SDK 用 `params: [{id, value}]`；
- 我们目前的 `resolveWireModel` 只处理 `effort`/`reasoning`，**`fast` 与 `context` 均未解析**；
- 建议解析层统一：识别 `[k=v,...]` 方括号语法 + `-fast` 后缀，统一转成 `ModelSelection.params`（与官方 `params:[{id:"fast",value:"true"}]` 同构）。

## 2. Subagent 配置与生命周期

### frontmatter 字段

| 字段 | 类型 | 默认 | 说明 |
|:---|:---|:---|:---|
| `name` | string | 文件名 | 小写字母+连字符 |
| `description` | string | — | 决定 Agent 何时委派 |
| `model` | string | `inherit` | `inherit` 或具体模型 ID（可带 `[参数]`） |
| `readonly` | boolean | `false` | 限制写权限 |
| `is_background` | boolean | `false` | 后台运行不阻塞父 agent |

### 文件位置与优先级

- 项目级：`.cursor/agents/`、`.claude/agents/`、`.codex/agents/`（后两者为兼容 Claude/Codex，**本身就支持多 harness 的 agent 定义复用**）；
- 用户级：`~/.cursor/agents/`、`~/.claude/agents/`、`~/.codex/agents/`；
- 冲突时 `.cursor/` 优先于 `.claude/`、`.codex/`。

### 生命周期关键事实

- **每次执行返回 agent ID，传此 ID 可恢复 subagent 并保留完整上下文**："Resume agent abc123 and analyze the remaining test failures"；后台 subagent 运行时写状态，完成后仍可恢复。
- **嵌套限制**（Cursor 2.5+）：主 agent 与其直接 subagent 可派生 subagent，但**"a subagent launched by another subagent can't launch further ones"**——即最多两层派生（主 → 子 → 孙，孙不能再派）。嵌套还需当前 mode 有 Task 工具权限，且 hooks 或工具策略可阻止派生。
- **上下文隔离**：每个 subagent 独立上下文窗口，"Subagents start with a clean context"，父 agent 需在 prompt 中给足信息。
- **并行**：单个消息中发多个 Task 工具调用即并发执行。
- **隔离副本**：默认共享父 checkout；要求隔离时各 subagent 用独立 Git worktree（各自分支）或独立云环境。
- **失败处理**：返回 error 状态给父 agent，父可重试、带上下文恢复或另行处理。
- **内置三个**：`explore`（代码搜索，用更快模型跑并行搜索）、`bash`（shell 命令，隔离冗长输出）、`browser`（浏览器 MCP，过滤 DOM 噪声）。设计动机是"这三类操作产生噪声中间输出且吃上下文"。
- **成本提醒**：subagent 独立消耗 token，五个并行约五倍消耗。

**对我们的结论**：

- `cursor/task` 的 `agentId` 恢复 + 此处"resume with full context"互相印证，**subagent 生命周期持久化是官方一等公民**；
- 嵌套两层的硬限制值得注意——我们的 tower/orchestrator 若经 cursor 渠道派生，深度会受限（靠 cursor 自身派生时）；若由我们 engine 侧派生则不受此限（每个派生都是独立的 SDK agent）；
- `.claude/agents/` / `.codex/agents/` 兼容目录对 DSH④（多 harness）有价值：agent 定义可跨 harness 复用。

## 3. SDK Bridge（多语言路径，对我们价值有限）

- 定位：嵌入 TS SDK 的本地小服务器，通过 Connect/protobuf 暴露同一 agent 接口，**给没有一等 SDK 的语言（Go/Rust/Java/C#）用**；
- 官方建议 TS/Python 直接用一等 SDK，bridge 面向 "SDK authors and platform teams"；
- 协议：`sdk.v1` Connect RPC，loopback HTTP/1.1；**经典 gRPC over HTTP/2 连不上**；Python SDK 内部就跑 bundled bridge；
- 产物：`bin/cursor-sdk-bridge`、`proto/sdk/v1/`（该二进制的契约）、`manifest.json`；release tag 与 TS/Python SDK 版本一致。

**对我们的结论**：我们是 TypeScript 项目且直接用 `@cursor/sdk`，**不需要 bridge**。但 `proto/sdk/v1/` 契约可作为 wire 格式的权威参考（比从 bundle 反推 proto 可靠）。

## 4. 待继续核实的文档

全量 243 篇已就位，尚未精读但相关度高的：
- `docs_hooks.md`（hooks 完整语义，`preCompact` 等事件）
- `docs_models_*.md`（各模型支持的参数集，可校验我们的值域）
- `docs_sdk_changelog.md`（SDK 版本变更，含我们用的 1.0.30）
- `help_customization_context.md`（上下文管理）
- `docs_skills.md`、`docs_rules.md`（与 subagent 的分工边界）
