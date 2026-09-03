# 探索：engine 动态约束写成项目规则文件（S1 的官方解法可行性）

> 探索日期：2026-09-03。依据：`docs/cursor/official/` 官方文档 + `@cursor/sdk@1.0.30` 类型定义。
> 结论：**可行，但有约束条件**；不是 S1 的完整解法，是部分解法。

## 1. 问题回顾（S1：system prompt 首轮失效）

`buildFreshPrompt`（`cursor.ts:277`）把 engine 的 systemPrompt 拼进**首条** user 消息；续聊（工具循环 / 重建）不携带。engine 每轮传入的新鲜 systemPrompt（含动态 reminder / plan mode / goal）对模型持续失效。

SDK 全文检索 `systemPrompt` / `system prompt` / `rules` / `skills`：**零命中**——官方 SDK 没有 system prompt 概念，它的"规则"是自己的文件系统机制。

## 2. 官方规则机制（rules.md）

| 类型 | 位置 | 作用域 |
|:---|:---|:---|
| Project Rules | `.cursor/rules/*.mdc` | 版本控制，作用于本代码库 |
| User Rules | 全局 | 所有项目 |
| Team Rules | dashboard 管理 | 团队级 |
| **AGENTS.md** | 项目根 | "Simple alternative to `.cursor/rules`"，纯 markdown |

官方定性："When applied, rule contents are **included at the start of the model context**." —— 规则被注入模型上下文开头，正是我们要的位置。

### 规则触发矩阵（frontmatter 三字段）

| `alwaysApply` | `description` | `globs` | 行为 |
|:---|:---|:---|:---|
| `true` | — | — | **总是包含**（globs/description 忽略） |
| `false` | — | provided | 上下文中有匹配文件时自动附加 |
| `false` | provided | omitted | Agent 读 description 判断相关性后拉取 |
| `false` | omitted | omitted | 仅在聊天中 `@rule-name` 提及时 |

**关键**：`.mdc` 扩展名是必须的——"A plain `.md` file in `.cursor/rules` is ignored by the rules system because it has no frontmatter"。若偏好纯 markdown 则用 `AGENTS.md`。

### 兼容目录

`.claude/agents/`、`.codex/agents/` 与 `.cursor/agents/` 并存（Claude / Codex 兼容），冲突时 `.cursor/` 优先。

## 3. SDK 侧的开关：`local.settingSources`

```ts
export type SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";
```

位于 `LocalAgentOptions.settingSources`（`options.d.ts:149`）。语义（官方原文）：

- 控制**从哪些磁盘配置源加载**（MCP 服务器、钩子、子智能体等）；
- `"project"` → `.cursor/mcp.json` 等项目配置；
- `"user"` → `~/.cursor/mcp.json`；
- `"plugins"` → 插件服务器；
- **"未设置 `local.settingSources` 时，只会加载内联服务器"** —— 默认**不读磁盘**；
- `local.settingSources` **不适用于云端代理**（仅本地）。

相关能力：
- `agent.reload()`：不释放资源重读文件系统配置（钩子、项目 MCP、子智能体）→ **动态更新规则无需重建会话**；
- `platform.prewarmLocalWorkspace(options)`：预热解析（规则、技能、MCP、忽略文件），避免首次 `send()` 承担开销；
- `local.dirs`（1.0.27+）：多根工作区，从多个目录加载 rules/skills/项目上下文。

## 4. **`LocalAgentOptions` 无 systemPrompt 字段**（关键约束）

实测 `options.d.ts` 的 `LocalAgentOptions` 字段全集：`cwd`、`dirs`、`autoReview`、`store`、`settingSources`、`sandboxOptions`、`customTools`、`enableAgentRetries`。

**没有 systemPrompt**。文档中的 `AgentDefinition.prompt`（"子智能体的系统提示词"）属于 **Cloud Agent / 子智能体定义路径**，不在 `LocalAgentOptions` 里。

→ **结论：engine 的 systemPrompt 无法通过 SDK 参数传入，只能走文件系统（rules/AGENTS.md）。**

## 5. 可行性判定

### 可行部分 ✅

- 把 engine 的**相对静态**的约束（项目规范、架构决策、编码约定）写成 `.cursor/rules/*.mdc`（`alwaysApply: true`）或 `AGENTS.md`；
- 注入位置在模型上下文开头，且**每轮都在**（规则由 SDK 每次加载，不受我们只发增量的影响）；
- 开 `settingSources: ["project"]`（或含 `"user"`）才会读磁盘——**需要显式开启**；
- 动态变更可用 `agent.reload()` 热更新，**不必重建会话**。

### 不可行 / 有代价的部分 ⚠️

| 问题 | 说明 |
|:---|:---|
| **副作用：会污染用户仓库** | 写 `.cursor/rules/` 或 `AGENTS.md` 进用户项目目录，是**侵入式**改动。社区版往用户仓库落文件需谨慎（可能干扰用户自己或团队已有的 cursor 配置） |
| **高频动态约束不合适** | 每轮的 plan mode / goal / 临时 reminder 变化频繁，写文件 + reload 的开销与原子性都不如直接传参 |
| **`AGENTS.md` 可能已存在** | 用户/其他工具（含 kimi-code 自身的 AGENTS.md 约定）可能已有该文件，写入会冲突 |
| **加载时机** | 规则在工作区解析阶段加载（首次 `send()` 或 prewarm），不是每轮实时读——`reload()` 才是刷新手段 |
| **未设置就不读磁盘** | 默认行为是只读内联，必须显式开 `settingSources` |

### 自研推断部分（官方未说可这么用）⚠️

官方文档描述 rules 是**给用户在 Cursor 产品里用的**，没有"嵌入方通过写规则文件注入自身约束"的用法说明。这条路属于**合理推断**（机制支持，但非官方推荐用法），落地需真机验证：

- V1：`settingSources: ["project"]` 下，写入 `.cursor/rules/kimi-code-context.mdc`（`alwaysApply: true`）是否每次都进上下文？
- V2：`reload()` 后新内容是否下一次 `send()` 就生效（跨 resume 也生效）？
- V3：与 `custom-user-tools` MCP 服务器同时存在时有无冲突？

## 6. 建议

**分层处理 S1**，不要指望单一手段：

| 约束类型 | 方案 |
|:---|:---|
| 静态项目规范 | 可选：写 `.cursor/rules/*.mdc` 或 `AGENTS.md`（**需用户明确同意**，属侵入式） |
| 高频动态（plan/goal/reminder） | 走**重建窗口注入**（已有方案）或**每轮 user 消息前缀**（轻量，每轮都发） |
| 兼容性考虑 | 复用 `.claude/` / `.codex/` 兼容目录的可能性值得单独评估（对 DSH④ 多 harness 有价值） |

**最低成本的兜底**：每轮把当前 systemPrompt 作为 user 消息前缀发送（而不是只在首轮）。代价是多发重复 token（但 cache 能吸收，因为前缀稳定 → `cacheReadTokens` 命中），换来语义正确性。这比写文件安全，且不侵入用户仓库。

## 7. 待验证项（新增）

- **N7**：`settingSources: ["project"]` 下 rules 注入是否每轮生效（V1）；
- **N8**：`reload()` 刷新规则的生效时机与跨 resume 行为（V2）；
- **N9**：`AGENTS.md` 与 `.cursor/rules/` 并存时的优先级与冲突（V3）；
- **N10**：每轮前缀发送 systemPrompt 的 cache 命中率与 token 代价（决定最低成本兜底是否划算）。
