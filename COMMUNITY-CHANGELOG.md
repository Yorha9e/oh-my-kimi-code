# 社区版更新日志（oh-my-kimi-code）

本文件记录 [oh-my-kimi-code](https://github.com/Yorha9e/oh-my-kimi-code) 社区版（呼出命令 `omkc`）相对上游 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 新增的变更。按版本倒序排列。

## 0.29.1-omkc.7

_2026-07-28 · 内置 create-subagent-profile 技能。_

- **新增内置技能 `create-subagent-profile`**：让主代理知道如何创建自定义子代理 profile——何时该建（可复用角色 / 同角色多模型 / 沉淀工作方式）、`<home>/agents/*.md` 的格式与 frontmatter 缺省行为、命名与内置同名的避让规则、"一个 profile + 多个 slot"的同角色多模型模式，以及创建后的模型绑定与验证步骤。遇到"帮我定义一个 XX agent"类需求时会自动触发。

## 0.29.1-omkc.6

_2026-07-27 · 状态导出端口重试的监听器泄漏修复。_

- **修复 TUI 频繁出现 `MaxListenersExceededWarning`**：内嵌状态导出服务在端口被占时逐个递增重试，旧实现每次失败都在共享 Server 上残留一个 `listening` 监听器，重试超过 10 次即触发 Node 的监听器上限警告。现在失败路径会正确摘除挂起的回调，并补了回归测试。

## 0.29.1-omkc.5

_2026-07-25 · resume 换模型续跑。_

- **resume 支持 `binding_slot` 覆盖模型**：`Agent(resume=<id>, binding_slot=<槽位>)` 用槽位绑定的模型唤回子代理——原模型被限流（429）或安全策略拒绝时，换模型续跑不丢上下文。覆盖固化到子代理配置，后续 resume/retry 沿用新模型；槽位未配置或别名未知时回退原模型并给出显式警告。实验 flag 关闭时行为不变，`retry` 与 swarm 批量 resume 不受影响。
- **README 新增「自定义子代理 profile」教程**：profile 文件格式、frontmatter 字段、模型绑定、「同角色多模型」槽位组合与 resume 换模型的完整用法。

## 0.29.1-omkc.4

_2026-07-24 · 自定义子代理 profile 与显示修复。_

### 统一自定义 Agent/Profile 目录

- 自定义 Agent 统一由 Session Agent Catalog 发现，支持 Plugin、用户、额外目录、项目与显式文件作用域；项目级文件可放在 `.kimi-code/agents/*.md` 或 `.agents/agents/*.md`。
- `name` 缺省取文件名；`description` 缺省取正文首个非空行；兼容旧 `when_to_use`，并支持 `tools`、`disallowedTools`、`subagents`、`model_preference` 与 OMKC `slot`。
- Agent 工具类型、spawn、resume 与列表共用同一 Catalog 和 `subagents` allowlist，旧 home-only loader 不再绕过委派限制。单文件解析失败会跳过并告警，不影响会话启动。

### 子代理模型管理界面增强

- `/settings` 的 Subagent models 面板类型下拉经 `listSubagentProfiles` RPC 拉取当前 Agent 实际可委派的 Profile；`/subagent-model list` 同时列出 Plugin、项目、用户、额外与显式来源标记（如 `(project)`），RPC 失败时回退内置列表。
- 槽位删除交互改为在 Settings 面板选中后按 `D` 键。
- `binding_slot` 工具参数描述收敛为纯透传语义：slot 是用户侧的隐式模型路由层，不再向 LLM 暴露「用于选择模型/effort」的描述，profile（用途/prompt）是 LLM 选择子代理的唯一语义接口——类型列表更短，主上下文更省 token。

### 显示与杂项修复

- 托管 OAuth provider（Kimi Code 官方模型服务）在模型选择器、`/logout` 列表与登出提示中固定显示为「Kimi Code」，不再随社区版品牌显示为 Oh My Kimi Code。
- 反馈入口 URL 修正指向 `Yorha9e/oh-my-kimi-code` 的 Issues。

### omkc-status 伴生状态服务

- 交互启动时可自动拉起 omkc-status 伴生进程（独立于 MOA 卡片单独开关），只读监听会话持久化文件并对外提供 HTTP `/state` 与 SSE `/events`；`/health` 携带 status-protocol-v1 版本标记做兼容性协商。

## 0.29.0-omkc.2

_2026-07-23 · 自更新机制改指社区 GitHub Releases。_

- **自更新改指社区 GitHub Releases**：更新源从官方 CDN 切换到社区 Releases  feed（`Yorha9e/oh-my-kimi-code`，可用环境变量 `OMKC_UPDATE_REPO` 覆盖），检查更新、按 SHA-256 校验下载、并在进程内安装原生构建。
- **部分安装方式回退为手动指引**：通过 npm / homebrew / Windows 原生方式安装的实例，自更新时给出 Releases 链接的手动升级指引而非自动替换——Windows 原生安装走这条手动路径。
- 版本号升至 `0.29.0-omkc.2`。

## 0.29.0-omkc.1

_2026-07-23 · 社区版首发。_

oh-my-kimi-code 是 MoonshotAI/kimi-code 的社区 fork，用来先行落地一批「多代理编排」相关特性，成熟后会以 PR 回馈上游。它与官方版完全并存：命令为 `omkc`（官方是 `kimi`），数据目录为 `~/.omkc`（官方是 `~/.kimi-code`），同机安装互不污染。

版本号采用 `<上游基线>-omkc.<迭代>` 规则：`0.29.0-omkc.1` 表示基于上游 `0.29.0` 基线的第 1 次社区迭代。本日志只列社区版**新增**的内容，上游 0.29.0 自身的特性不在此重复。

### 子代理模型绑定（默认开启）

- 按子代理类型（`coder` / `explore` / `plan` 等）绑定模型与思考强度；绑定是用户配置而非 LLM 决策，在子代理创建时机械生效，调用方无法临时改写。
- 命名槽位（slot）：用 `/subagent-model` 的 `set slot <name>` / `clear slot <name>` 管理，`list` 分「类型」与「槽位」两区展示；`AgentSwarm` 支持按槽位分发。
- 全局层：绑定除工作区 `.kimi-code/local.toml` 外，也可写在全局 `~/.omkc/local.toml`；解析优先级为 工作区槽位 > 全局槽位 > 工作区类型 > 全局类型 > 继承。
- `/settings` 新增「Subagent models」面板：一屏批量编辑所有类型与槽位绑定，按 Tab 在工作区 / 全局两层间切换，并可内联「+ Add slot…」新建槽位。
- 中断后恢复的子代理保持原有绑定（sticky resume），不再被重新对齐到父代理的模型。
- 绑定展示附带模型能力标识。
- 工作区绑定指向未知模型别名时自动修复或提示；当过期绑定的重新询问被关闭时，给出回退到继承的警告。

### MOA 多代理辩论 profiles

- 内置 `orchestrator` / `critic` / `synthesizer` 等角色化子代理配置，让多代理协作以结构化辩论的形式展开。

### 独立数据目录与首启迁移

- 数据目录独立为 `~/.omkc`（环境变量优先级 `OMKC_HOME` > `KIMI_CODE_HOME` > 默认），与官方目录完全隔离。
- 首次启动检测到官方 `~/.kimi-code` 时自动迁移配置、凭据、会话、技能、插件、主题、输入历史等（复制不移动、不覆盖、无需重新登录）；在源目录放 `.skip-migration-to-omkc` 可跳过，迁移失败仅告警、不阻塞启动。

### /sync-from-kimi 增量同步

- 新增 `/sync-from-kimi` 命令，从官方 `~/.kimi-code` 增量同步用户数据到 omkc 主目录。

### 内嵌状态导出（SSE）

- CLI 进程内建 loopback SSE 状态服务（`127.0.0.1:39631` 起，只绑环回、零写盘），供外部工具订阅 agent 状态；开关为 `tui.toml` 的 `[moa] status_export`（默认开）。

### moa-card 桌面悬浮卡片

- 交互启动时自动拉起 moa-card 桌面卡片，实时显示 MOA 辩论进度与各 agent 状态；开关为 `tui.toml` 的 `[moa] card`（默认开）。

### kosong Anthropic 兼容端点加固

- `max_tokens` 保守兜底，加上 400 错误自动解析并重试，兼容更多第三方 Anthropic 风格端点（已提上游 [PR #2066](https://github.com/MoonshotAI/kimi-code/pull/2066)）。

### 命令与品牌

- CLI 呼出命令更名为 `omkc`（oh-my-kimi-code），与官方 `kimi` 全局并存、互不覆盖。

### CI / 发布管线

- 发布改走原生单文件可执行文件（SEA）：六个平台各产出 `omkc-<target>.zip` + `.zip.sha256`，并汇总 `manifest.json`；推送 `oh-my-kimi-code@x.y.z` tag 即发正式版。
- 移除 Nix 构建与 pkg-pr-new 工作流。

### 文档

- 重写 README 为社区版使用教程，覆盖单文件下载安装、源码构建、Windows 下的 Node.js 升级指引等。

### 修复

- 修复 Agent 工具告警在结构化（content-part）输出下触发的类型化 lint 缺陷。
- 修复一批在 Windows 上运行测试的兼容性问题。
- 对齐 omkc 更名与子代理模型绑定默认开启后的测试断言。
