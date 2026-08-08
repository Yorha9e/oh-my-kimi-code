# omkc 使用指南

> 面向使用者的完整操作手册。安装、迁移、更新见 [README.md](README.md)；功能实现细节与代码索引见 [COMMUNITY-FEATURES.md](COMMUNITY-FEATURES.md)。

## 目录

1. [Slash 命令全表](#1-slash-命令全表)
2. [子代理模型绑定：类型与槽位](#2-子代理模型绑定类型与槽位)
3. [自定义子代理 profile](#3-自定义子代理-profile)
4. [moamcp 插件：Tips / 黑板 / 交接 / 状态面板](#4-moamcp-插件tips--黑板--交接--状态面板)
5. [Tower 工作流（多代理协作施工）](#5-tower-工作流多代理协作施工)
6. [MOA 辩论](#6-moa-辩论)
7. [moawerewolf 狼人杀彩蛋](#7-moawerewolf-狼人杀彩蛋)
8. [配置示例汇总](#8-配置示例汇总)

---

## 1. Slash 命令全表

TUI 输入框敲 `/` 弹出补全，`Enter` 执行；部分命令仅空闲态可用（流式输出中先 `Esc` 中断）。

### 1.1 内置命令（与官方 0.34.0 一致）

| 分类 | 命令（别名） | 用途 |
| --- | --- | --- |
| 账号 | `/login` `/logout`(`disconnect`) | 登录 / 登出 provider |
| 模型 | `/model` | 切换会话模型 |
| | `/secondary_model` | 配置子代理 secondary model（实验项） |
| | `/effort`(`thinking`) | 切换思考强度 |
| | `/provider`(`providers`) | 管理 AI provider |
| 模式 | `/yolo`(`yes`) | 自动批准工具调用（仍可提问） |
| | `/auto` | 全自主模式 |
| | `/permission` | 选择权限模式 |
| | `/plan` | 计划模式（`/plan clear` 仅空闲） |
| | `/swarm [on\|off\|<task>]` | swarm 模式 |
| | `/goal` | 自主目标（`status/pause/resume/cancel/replace/next`） |
| 会话 | `/new`(`clear`) | 新会话 |
| | `/sessions`(`resume`) | 浏览/恢复会话 |
| | `/fork` | 复制会话为副本（不切换） |
| | `/title`(`rename`) | 会话标题 |
| | `/undo` | 撤回上一条提示词 |
| | `/compact <指令>` | 压缩上下文 |
| | `/export-md`(`export`) | 导出 Markdown |
| | `/export-debug-zip` | 导出调试 ZIP |
| | `/add-dir [list\|<path>]` | 额外工作区目录 |
| 任务 | `/tasks`(`task`) | 后台任务浏览 |
| | `/btw <问题>` | fork 旁路子代理问问题 |
| 界面 | `/settings`(`config`) | 设置（含 Subagent models 面板） |
| | `/theme` | 终端主题 |
| | `/editor` | Ctrl-G 外部编辑器 |
| | `/reload` | 重载 config.toml / tui.toml |
| | `/reload-tui` | 仅重载 TUI 偏好 |
| 信息 | `/help`(`h`,`?`) | 命令与快捷键 |
| | `/usage` | token 与配额 |
| | `/status` | 会话与运行时状态 |
| | `/mcp` | MCP server 状态 |
| | `/plugins` | 插件管理 |
| | `/experiments`(`experimental`) | 实验特性开关 |
| | `/version` | 版本信息 |
| 其他 | `/init` | 生成 AGENTS.md |
| | `/web` | Web UI 打开当前会话 |
| | `/copy` | 复制上一条助手消息 |
| | `/feedback`(`bug`) | 反馈（社区版指向社区仓库 Issues） |
| | `/exit`(`quit`,`q`) | 退出 |

### 1.2 社区新增命令

| 命令 | 用途 |
| --- | --- |
| `/subagent-model [list]` | 查看/管理子代理模型绑定：`set [slot] <名>` 绑定、`clear [slot] <名>` 清除 |
| `/sync-from-kimi` | 从官方 `~/.kimi-code` 增量同步数据（可反复执行） |
| `/tip-save [说明]`（`/tip`） | 后台 fork 主代理，把讨论中最有价值的 1–3 个想法/结论写入 Project Tips |

### 1.3 插件注入命令

插件命令按 `插件id:命令` 命名空间注册，正文即执行步骤，`$ARGUMENTS` 传参。

| 命令 | 用途 |
| --- | --- |
| `/moamcp:tips [过滤]` | 列出当前工作区 Tips（`status=`/`tags=`/`module=`） |
| `/moamcp:tip-new <描述>` | 从当前讨论起草 Tip，确认后保存 |
| `/moamcp:tip-show <id>` | 查看 Tip 完整内容 |
| `/moamcp:tip-promote <id>` | 提升为当前 Session 的执行 Todo |
| `/moamcp:tip-archive <id>` | 归档（默认列表隐藏，历史保留） |
| `/moawerewolf:ww-new` | 创建一局狼人杀（12–16 人、每座位槽位、`task_id`） |

---

## 2. 子代理模型绑定：类型与槽位

社区版默认开启 `subagent-model-selection` 实验项，无需手动开。

### 2.1 两级配置

| 层级 | 文件 | 作用范围 |
| --- | --- | --- |
| 工作区 | `<项目>/.kimi-code/local.toml` | 仅当前项目（**官方版与社区版共享此文件**，配置互通） |
| 全局 | `~/.omkc/local.toml` | 所有项目的兜底 |

每个层级里都可以写两类绑定：

```toml
# 按类型：所有 explore 子代理默认走这个模型
[subagent.explore]
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

# 命名槽位：按槽位名寻址，派遣时用 binding_slot 指定
[subagent-slot.longcat]
model = "MT/LongCat-2.0"
thinking_effort = "high"
```

字段：`model`（模型别名）、`thinking_effort`、`inherit`（为 `true` 时整层跳过，等于不绑）。

### 2.2 解析优先级

**显式派遣参数 > 工作区槽位 > 全局槽位 > 工作区类型 > 全局类型 > 继承主代理**。

绑定是用户配置而非 LLM 决策，spawn 时机械生效；绑定不存在、`inherit: true` 或模型别名已失效时整层跳过，落回下一级。

### 2.3 日常使用

- **交互绑定**：`/subagent-model set coder`（或 `set slot longcat`），按提示选模型与强度，写入工作区配置。
- **查看**：`/subagent-model list` 分 Types / Slots 两节列出。
- **图形面板**：`/settings` → Subagent models，Tab 切工作区/全局两层；`+ Add slot…` 内联建槽，选中行按 `D` 删除/清除；非内置 profile 带来源徽章（`(project)` `(user)` `(plugin)` `(extra)` `(explicit)`），声明了 `slot` 的 profile 显示 `follows slot: <名>`。
- **派遣时指定槽位**：让主代理「用 longcat 槽派一个 explore」，它会在 `Agent` 调用里带 `binding_slot="longcat"`。
- **断点续跑换模型**：子代理 429/限流时 `Agent(resume=<id>, binding_slot=<另一个槽位>)`，上下文不丢；换过的模型固化，后续 resume 沿用（sticky resume）。

---

## 3. 自定义子代理 profile

### 3.1 放哪里

| 来源 | 位置 | 优先级 |
| --- | --- | --- |
| 显式指定 | `--agent-file <路径>` 启动参数 | 最高 |
| 项目级 | `.kimi-code/agents/*.md`、`.agents/agents/*.md` | ↑ |
| Extra 目录 | `config.toml` 顶层 `extra_agent_dirs` | |
| 全局 | `~/.omkc/agents/*.md` | |
| 插件自带 | 插件 `agents/` 目录（如 moamcp 的 tower profile） | |
| 内置 | `coder`/`explore`/`plan` 等 | 最低 |

同名冲突内置类型时跳过并告警；坏文件只跳过不阻塞启动；会话启动时加载，**新增/修改后开新会话生效**。

### 3.2 文件格式

```markdown
---
name: reviewer
description: 严格的代码审查者
whenToUse: 需要对一个 diff 或方案做对抗性审查时
tools: [Read, Grep, Glob, Bash]
slot: review-cheap
---

你是一名严格的代码审查者……（正文即角色 prompt，不用解释子代理机制）
```

字段全部可选：`name`（缺省文件名）、`description`（缺省正文首行）、`whenToUse`（兼容 `when_to_use`）、`tools`（缺省继承 coder 工具集）、`disallowedTools`、`subagents`、`model_preference`、`slot`（OMKC 扩展，自动跟随同名 `[subagent-slot.*]`）。

### 3.3 快捷创建

直接对主代理说「帮我创建一个 xxx 子代理 profile」，内置技能 `create-subagent-profile` 会引导它按规范生成文件、避让冲突、建议后续绑定。

---

## 4. moamcp 插件：Tips / 黑板 / 交接 / 状态面板

安装：TUI 里 `/plugins` 安装 moamcp（仓库 [Yorha9e/moamcp](https://github.com/Yorha9e/moamcp)）。装完后插件自带 MCP 工具（`moa_*`）、slash 命令（`/moamcp:*`）、会话规范 skill、PreToolUse 守卫钩子和一组 Web 面板。

### 4.1 Project Tips（跨会话想法卡片）

- **是什么**：项目级、跨 Session 持久化的功能想法/设计结论卡片（title/summary/context/status/module/tags/documentRefs）。
- **命令流**：`/moamcp:tip-new` 起草 → 你确认 → 保存；`/moamcp:tips` 列表；`tip-show` 查看；`tip-promote` 提升为执行 Todo；`tip-archive` 归档。
- **快捷流**：`/tip-save`（`/tip`）一句话让后台子代理自动提炼保存，模型走 `[subagent-slot.tip_save]`。
- **生命周期**：`captured → exploring → planned → implemented → archived`，旁路 `deferred`/`discarded`。
- **纪律**：插件规范约定「先草案后确认、启动不自动扫描、workspace 参数必传」，由 `using-moamcp` skill 在每个会话注入。

### 4.2 共享黑板（Raw Board）

通用键值逃生口（markdown ≤96KB、键级 last-write-wins、墓碑删除），三个作用域：`workspace`（默认，本项目）、`global`（跨项目）、`task:<id>`（辩论局内）。适合跨 agent/跨会话共享契约、决策、状态指针；`moa_board_wait` 可长轮询等新值。

### 4.3 定向交接（Mailbox / Handoff）

给**另一个项目**或 **user-global 收件箱**发一条结构化交接（标题/摘要/上下文），接收方按需拉取、确认消费或归档。v2 支持 agent 级寻址（`toAgent`/`fromAgent`，形如 `<label>:<sessionId>:<agentId>`）。交接不参与召回索引，是拉取式消息。

### 4.4 Agent Status 隶属树面板

- omkc 进程内嵌 loopback SSE 状态服务（`127.0.0.1:39631` 起探测 `/health`，只绑环回、零写盘），广播 subagent 生命周期事件（含 `parentAgentId`）。
- moamcp 消费后折叠成树：Web 面板 `/status-board` 按 session 分组展示主/子代理嵌套关系、busy 状态、来源（local/remote），活跃置顶、不活跃折叠。
- 嵌套子代理（子代理再派子代理）同样入树。

### 4.5 Web 面板总览

面板地址在 moamcp 启动时打印（Bus 端口）。导航含六项：MOA Debate（辩论卡片）、Workspace Memory（Agents/Board/Inbox/Projects/Tips 五页）、MoA Runs、Agent Status、Tower Workflow、System Health。（狼人杀观战页 `/werewolf` 属于独立插件 moawerewolf 自有的 Bus，不在 moamcp 导航内。）

---

## 5. Tower 工作流（多代理协作施工）

moamcp v0.13.0 起内置的多代理工程编排：把一个大目标拆成若干互不相交的 mission，由 tower-orchestrator 派 worker 在**独立 git worktree** 里施工，reviewer 对抗审查，全部干净后过**硬性合并门**合回主干。

- **角色**（插件自带 profile，声明 `slot: tower-orchestrator/worker/reviewer`）：
  - `tower-orchestrator`：控制塔，独占协议杠杆（boot/plan/spawn/register/merge/teardown/ci），前台两阶段派遣；
  - `tower-worker`：单个 mission 的施工者，只能写自己 worktree 里的 mission 范围；
  - `tower-reviewer`：只读审查一条分支，提交 `clean | p1-N | p2-N` 裁决。
- **写入守卫**：worker 的 `Write/Edit` 被限制在其 worktree 内——omkc 侧 v1 权限策略 + v2 permissionPolicy 双引擎策略，外加插件 PreToolUse 钩子兜底；守卫镜像 `<repo>/.tower-guard.json` 由 tower 控制器维护。
- **worktree 布局**：仓库兄弟目录 `<repo名>-worktrees/wt-<n>`，mission 分支 `feat/M<n>-<slug>`；teardown 时脏 worktree 保留（`force` 可强清）。
- **面板**：`/tower` 页看 mission 表（状态 + CI 徽章 + review gate）、roster 身份校验、活动日志。
- **用法**：对主代理说「用 tower 工作流做 XX」，它会转派 tower-orchestrator 角色走完整流程；也可以在 `/tower` 面板手动引导。

---

## 6. MOA 辩论

多模型结构化辩论：预设若干辩手（各自绑定不同模型槽位），围绕一个主题分轮次发言，支持 `signoff` 一致提前收束，归档在 `~/.moamcp/logs/<task_id>/`。

- 内置辩论 profile：`critic`（对抗审查）、`debater`（正反/魔鬼代言人，中文）、`orchestrator`（编排）、`synthesizer`（收敛）。
- 发起：对主代理说「用 MOA 辩论一下 <主题>，辩手用 <模型A>/<模型B>/…」，它会调 `moa_init` 建局并按 dispatch map 派遣。
- 面板：`/` MOA Debate 卡片实时看各辩手轮次与状态。

---

## 7. moawerewolf 狼人杀彩蛋

12–16 人多模型狼人杀：每个座位一个子代理（可分别绑模型），引擎驱动夜晚行动/白天发言投票，屠边规则判胜。

- 建局：`/moawerewolf:ww-new`，按提示确认人数、每座位槽位、`task_id`。
- 观战：Web 面板 `/werewolf?task_id=<id>`，发言流、夜晚/投票公告、终局角色矩阵 + 战绩统计。

---

## 8. 配置示例汇总

**工作区 `.kimi-code/local.toml`**（类型 + 槽位混用）：

```toml
[subagent.critic]
model = "google/gemini-3.6-flash-tiered"
thinking_effort = "high"

[subagent.tower-worker]              # 对应 tower profile 的 slot: tower-worker
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot.phi3]                 # 命名槽位
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot."LongCat-2.0"]        # 槽位名也可直接用模型别名（加引号）
model = "MT/LongCat-2.0"
```

**全局 `~/.omkc/local.toml`**（兜底层 + 系统固定槽位）：

```toml
[subagent.explore]
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot.kimiforcoding]
model = "kimi-code/kimi-for-coding"

[subagent-slot.tip_save]             # /tip-save 固定读取的槽位
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"
```

**`tui.toml` 相关开关**：

```toml
[moa]
card = true        # moa-card 桌面悬浮卡片（默认开）
```

> 注意：`config.toml` 里的 provider `api_key` 属于敏感信息，不要贴进文档或 Issue。
