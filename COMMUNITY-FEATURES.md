# omkc 社区版使用文档 · 素材盘点清单

> 基础事实：社区 fork 仓库 `kimi-code-community`，当前版本 `0.34.0-omkc.1`（`apps/kimi-code/package.json`），呼出命令 `omkc`，数据目录 `~/.omkc`。上游基线为 MoonshotAI/kimi-code `0.34.0`（merge 提交 `8825a15c2` 的上游父提交 `0b2e803d5`，已逐文件核对差异）。

## 一、内置 slash 命令（官方 0.34.0 自带，社区未改动）

来源：`apps/kimi-code/src/tui/commands/registry.ts` 的 `BUILTIN_SLASH_COMMANDS`（经 `git diff 0b2e803d5..HEAD` 核对，以下均为上游既有命令，含别名/优先级/可用态）。共 40 条：

| 命令 | 别名 | 用途 |
| --- | --- | --- |
| `/yolo` | `yes` | 切换 YOLO 模式：自动批准工具调用，但代理仍可能提问 |
| `/auto` | | 切换 Auto 模式：全自主，代理自行决策不询问 |
| `/permission` | | 选择权限模式 |
| `/settings` | `config` | 打开 TUI 设置（社区版在其中新增了 Subagent models 面板，见第四节） |
| `/plan` | | 切换计划模式（`/plan clear` 仅空闲态可用） |
| `/swarm` | | 切换 swarm 模式或让一个任务以 swarm 模式运行，语法 `[on\|off] \| <task>` |
| `/model` | | 切换 LLM 模型 |
| `/secondary_model` | | 配置子代理的 secondary model（实验项 `secondary-model`） |
| `/effort` | `thinking` | 切换思考强度 |
| `/provider` | `providers` | 管理 AI provider（增删/刷新） |
| `/btw` | | fork 一个旁路子代理问问题（官方 0.34.0 已有，非社区新增） |
| `/help` | `h`、`?` | 显示可用命令与快捷键 |
| `/new` | `clear` | 在当前工作区开新会话 |
| `/sessions` | `resume` | 浏览并恢复会话 |
| `/tasks` | `task` | 浏览后台任务 |
| `/mcp` | | 查看 MCP server 状态 |
| `/plugins` | | 管理插件（社区版配套安装 moamcp/moawerewolf 即走这里） |
| `/add-dir` | | 添加/列出额外工作区目录，语法 `[list] \| <path>` |
| `/experiments` | `experimental` | 管理实验特性 |
| `/reload` | | 重载会话并应用 config.toml 与 tui.toml |
| `/reload-tui` | | 仅重载 tui.toml UI 偏好 |
| `/compact` | | 压缩对话上下文，语法 `<instruction>` |
| `/goal` | | 启动/管理自主目标，子命令 `status/pause/resume/cancel/replace/next` |
| `/init` | | 分析代码库生成 AGENTS.md |
| `/fork` | | 复制当前会话为副本但不切换 |
| `/title` | `rename` | 设置/显示会话标题 |
| `/usage` | | 显示会话 token + 上下文窗口 + 计划配额 |
| `/status` | | 显示当前会话与运行时状态 |
| `/feedback` | `bug` | 反馈（社区版已改指社区仓库 Issues） |
| `/undo` | | 撤回上一条提示词 |
| `/editor` | | 设置 Ctrl-G 外部编辑器 |
| `/theme` | | 设置终端主题 |
| `/logout` | `disconnect` | 登出 provider |
| `/login` | | 选择平台并认证 |
| `/export-md` | `export` | 导出会话为 Markdown |
| `/export-debug-zip` | | 导出会话调试 ZIP |
| `/copy` | | 复制上一条助手消息到剪贴板 |
| `/web` | | 起服务在 Web UI 打开当前会话 |
| `/exit` | `quit`、`q` | 退出 |
| `/version` | | 显示版本信息 |

## 二、社区新增命令（相对官方 0.34.0，registry.ts 差异仅 3 条）

| 命令 | 别名 | 用途 | 位置 |
| --- | --- | --- | --- |
| `/tip-save` | `tip` | fork 主代理为后台总结子代理，把本次讨论中最有价值的 1–3 个功能想法/设计结论写入 moamcp Project Tips（`moa_tip_create`）；语法 `/tip-save [补充说明]`；模型走 `[subagent-slot.tip_save]` 槽位 → 全局 secondary → 继承主模型链 | `apps/kimi-code/src/tui/commands/tip-save.ts`；v2 引擎侧 `packages/agent-core-v2/src/session/tipSave/tipSaveService.ts`、`tipSave.ts`（fork 主代理，保留全部工具） |
| `/subagent-model` | | 管理每工作区子代理模型绑定：`[list] \| set [slot] <name> \| clear [slot] <name>`；类型目标有 `coder/explore/plan` 补全；挂在实验 flag `subagent-model-selection`（**社区版默认开启**） | `apps/kimi-code/src/tui/commands/subagent-model.ts`；参数补全在 `registry.ts` |
| `/sync-from-kimi` | | 从官方 `~/.kimi-code` 主目录增量同步数据到 omkc 主目录（社区首启自动迁移之外的按需同步） | `apps/kimi-code/src/tui/commands/sync-from-kimi.ts` |

分辨结论：`/btw`、`/swarm`、`/goal`、`/add-dir`、`/secondary_model` 均为官方 0.34.0 已有（`git cat-file -e 0b2e803d5:<file>` 验证），不是社区新增。

## 三、插件注入命令

机制：`apps/kimi-code/src/tui/commands/plugin-commands.ts` — 插件 `commands/` 目录下的每个 `.md` 文件注册为一条命令，名称按 `pluginId:command` 命名空间（`pluginId` 取自插件 `kimi.plugin.json` 的 `name`），`$ARGUMENTS` 传参、正文即执行步骤。

**moamcp 注入（`pluginId = moamcp`）：** 命令目录 `moamcp/commands/`（已安装实例 `C:/Users/Yorha/.omkc/plugins/managed/moamcp/commands/` 同构）：

- `/moamcp:tips` — 列出当前工作区未归档 Tips，可带 `status=...`、`tags=...`、`module=...` 过滤
- `/moamcp:tip-new` — 从当前讨论起草并新建 Tip（先给用户确认草案，确认后才 `moa_tip_create` 保存）
- `/moamcp:tip-show <id>` — 读取一个 Tip 完整内容（按需附带 `documentRefs` 文档）
- `/moamcp:tip-archive <id>` — 归档一个 Tip（默认列表隐藏、历史保留）
- `/moamcp:tip-promote <id>` — 把一个 Tip 提升为当前 Session 的执行 Todo（`moa_tip_read` → 用户确认 → 宿主 `TodoList` 建 todo → `moa_tip_update status=planned`）

另有会话级注入：`sessionStart.skill = using-moamcp`（`skills/using-moamcp/SKILL.md`，约定 workspace 传参铁律、先草案后确认、启动不自动扫描）。

**moawerewolf 注入（`pluginId = moawerewolf`）：**

- `/moawerewolf:ww-new` — 创建一局新的狼人杀对局（先确认配置：12–16 人、每座位 `binding_slot`、`task_id`，确认后建局）

## 四、社区独有功能（相对官方 0.34.0）

### 1. subagent 模型槽位/绑定机制（`[subagent-slot.*]`）
- 配置：工作区 `.kimi-code/local.toml` 的 `[subagent.<type>]`（按类型）与 `[subagent-slot.<name>]`（命名槽位），字段 `model` / `thinking_effort` / `inherit`；全局层在 `~/.omkc/local.toml` 同构。
- 解析优先级：显式 dispatch 覆盖 → 工作区槽位 > 全局槽位 > 工作区类型 > 全局类型 > 继承（`packages/agent-core/src/agent/tool/subagent-binding.ts` 注释明载）；不存在绑定或 `inherit: true` 或模型别名已失效时整层跳过。
- v1 实现：`packages/agent-core/src/config/workspace-local.ts`（TOML schema + 读写、槽位/类型/全局四套 API）、`agent/tool/subagent-binding.ts`（回调工厂：机械生效 + 首次 spawn 交互询问并持久化到工作区文件）、`session/subagent-host.ts`、`tools/builtin/collaboration/agent.ts` + `agent-swarm.ts`（`binding_slot` 参数）。
- v2 实现：`packages/agent-core-v2/src/session/subagent/configSection.ts`（`[subagent]` 区 + secondary model 解析链、`subagentDisplayModel`）、`session/subagent/slotBinding.ts`（槽位读取）、`agent/tools/agent/agentTool.ts` + `agent/tools/agent-swarm/agentSwarmTool.ts`（spawn 绑定接入）。
- 槽位可通过 Agent 工具参数 `binding_slot=<name>` 显式指定；`Agent(resume=<id>, binding_slot=<slot>)` 支持换模型续跑（resume 时槽位覆盖原模型，429/安全拒绝时的兜底）。
- `/subagent-model` 是命令入口，`/settings` 里有图形化面板（见下）。

### 2. per-type 模型绑定
- 即上条的 `[subagent.<type>]` 区（`coder`/`explore`/`plan` 及一切自定义 profile 名）；v2 侧另有 `[agent_types]` derived entries 的 per-type patch（commit `a843bac68`/`cd1c37f9d`，`agent-core-v2` 的派生条目模型解析）。

### 3. 自定义 subagent profile / agent.md
- 文件格式（`<home>/agents/<name>.md` 与项目 `.kimi-code/agents/`、`.agents/agents/` 下任意 `.md`）：YAML frontmatter + 正文即角色提示词；字段 `name`（缺省取文件名，`^[a-z0-9][a-z0-9-]*$`）、`description`（缺省取正文首行）、`whenToUse`（兼容旧 `when_to_use`）、`tools`（缺省继承内置 `coder` 工具集）、`disallowedTools`、`subagents`、`model_preference`（上游字段），**`slot`（OMKC 扩展**：frontmatter 声明槽位，spawn 自动跟随 `[subagent-slot.<name>]`，适合"一个角色多模型"）。
- 加载链：`packages/agent-core/src/profile/user.ts`（home 目录加载，懒缓存、容错、与内置合并）、`profile/agentfile/{catalog,parser,types}.ts`（会话级 Agent Catalog 统一发现，作用域优先级 **Explicit(`--agent-file`) > Project > Extra > User > Plugin > Built-in**）、`profile/resolve.ts`（extends 继承 + 模板渲染）。项目级文件放 `.kimi-code/agents/*.md` 或 `.agents/agents/*.md`；extra 目录用 `config.toml` 顶层 `extra_agent_dirs`。
- 同名冲突内置类型时跳过并告警；坏文件跳过不阻塞启动；进程内缓存，需新会话生效。
- 内置技能 `create-subagent-profile`（`packages/agent-core/src/skill/builtin/create-subagent-profile.md`，commit `b7b3f6c69`）：教主代理如何创建自定义 profile（何时该建、格式、避让规则、建后绑定）。

### 4. 设置页 subagent model UI 与来源徽章
- `/settings` 的「Subagent models」面板：`apps/kimi-code/src/tui/components/dialogs/subagent-model-settings.ts`。Tab 在工作区/全局两层间切换，两层各自独立草稿；Slots 区 `+ Add slot…` 内联建槽，选中槽位行按 `D` 删除（带确认），类型行 `D` 为清除/恢复绑定。
- 来源徽章：非内置 profile 显示 `(project)`/`(plugin)`/`(user)`/`(extra)`/`(explicit)` 来源标记（RPC `listSubagentProfiles` 透传 `source` 与可选 `slot`）；profile 声明 `slot` 且无 type 绑定覆盖时显示 `follows slot: <name>`；全局层不展示项目/显式 profile 的新增绑定（历史/悬空绑定仍可查看清除）。列表数据来自 `/subagent-model list` 与 RPC，失败回退内置列表。

### 5. 嵌套子代理 status 隶属树（状态面板）
- omkc 内嵌 loopback SSE 状态服务：`apps/kimi-code/src/cli/status-export.ts`，监听 `127.0.0.1:39631..39731` 探测 `/health`（`status-protocol-v1`，`protocolVersion: 1`），订阅 `/events` SSE；事件含 `subagent.spawned/started/completed/failed/suspended`；只绑环回、零写盘。
- moamcp 消费侧：`mcpexplore/moamcp/src/modules/status/`（`watcher.ts` 只读扫描 CLI 会话树 `wire.jsonl/state.json/tasks/*.json`，`state.ts` 折叠 `parentAgentId` 血缘，O(1) 索引），`moa_status_agents` 工具返回按 `lastSeen` 排序的 agent 快照；web `/status-board` 页按 session 分组展示 agent 树（`status-board.ts` 的 group/head/sessionsBox 层级）。
- **退役项**：独立的 omkc-status 伴生服务（commit `4ba01dc21`，`moa.status_service` 配置已删，旧构建降级为 "no status source detected"）；内嵌 SSE 源保留。

### 6. tower worker write guard（两侧 + 插件钩子）
- v1（agent-core）：`packages/agent-core/src/agent/permission/policies/tower-worker-write-guard.ts` — `PermissionPolicy`，`profileName == 'tower-worker'` 时拦截 `Write/Edit`，任何逃出工作区（worktree）的写入 deny；`<repoRoot>/.tower-guard.json` 为守卫镜像（moamcp tower controller 写入），布局约定 `<repo>-worktrees/<slot>` 反推 repo 根；读镜像失败/路径异常一律 fail-open。
- v2（agent-core-v2）：`packages/agent-core-v2/src/agent/permissionPolicy/policies/tower-worker-write-guard.ts` — 同名策略（DI 注入 profile/scope/workspace/env），`win32` 大小写不敏感路径比较。
- 插件钩子：`moamcp/hooks/tower-write-guard.mjs` — v2 引擎侧外部 `PreToolUse` 钩子（`Write|Edit`，超时 10s），只拦"逃出注册区（repo 根 + 全部已注册 worktree）落到同级 zone"的写入，`exit 2` deny + stderr 原因；v1 无外部钩子支持，走 omkc 策略兜底。
- 测试：`packages/agent-core/test/agent/permission/tower-worker-write-guard.test.ts`、`packages/agent-core-v2/test/agent/permissionPolicy/policies/tower-worker-write-guard.test.ts`。

### 7. 其他社区独有改动（git log `0b2e803d5..HEAD` 摘要）
- **品牌与数据目录**：CLI 改名 `omkc`、目录改 `~/.omkc`（`OMKC_HOME` > `KIMI_CODE_HOME` > 默认），与官方并存不互污染；首启自动迁移 `~/.kimi-code`（复制不移动、`.skip-migration-to-omkc` 可跳过）；托管 OAuth provider 显示名固定为 "Kimi Code"。
- **自更新**：更新源改指社区 GitHub Releases（`OMKC_UPDATE_REPO` 可覆盖，`apps/kimi-code/src/cli/update/source.ts`）；原生 SEA 单文件发行。
- **moa-card 桌面悬浮卡片**：交互启动自动拉起（`apps/kimi-code/src/cli/moa-card.ts`，开关 `tui.toml [moa] card`，社区版默认开）。
- **内置 MOA 辩论 profiles**：`packages/agent-core/src/profile/default/` 新增 `orchestrator.yaml`、`critic.yaml`、`synthesizer.yaml`（+`agent.yaml` 子代理表）。
- **tip-save 链**（见第二节）+ `TIP_SAVE_SLOT = 'tip_save'` 固定槽位名。
- **实验开关默认开启**：`subagent-model-selection` 社区默认 on（commit `8c3ddf914`）；上游文档写的 `[experimental] subagent-model-selection = true` 在社区版可省略。

## 五、moamcp 插件（`mcpexplore/moamcp`，已装实例 v0.13.0）

**kimi.plugin.json 声明**：`name: moamcp`；`agents` → `./agents`；`skills` → `./skills`（会话注入 `using-moamcp`）；`commands` → `./commands`；`hooks`：`PreToolUse` × `Write|Edit` → `node ./hooks/tower-write-guard.mjs`（timeout 10s）；`mcpServers.moamcp` → `node ./dist/server.js`（toolTimeoutMs 1800000）。

**工具族（MCP，前缀 `mcp__moamcp__`，共 37 个）**：

- `moa_status` — Bus 状态（端口/模式 own-reuse/活跃任务）；`moa_status_agents` — 折叠的 agent/session 实时状态（含 parentAgentId 血缘、local/remote 来源标记）。
- `moa_tip_*`（5）：`moa_tip_create` 建项目级 Tip；`moa_tip_read` 读完整 Tip；`moa_tip_list` 轻量列表（status/module/tag 过滤，默认隐藏归档）；`moa_tip_update` 原子更新；`moa_tip_archive` 归档。
- `moa_board_*`（6）：`moa_board_write` 写黑板（markdown ≤96KB、键级 last-write-wins）；`moa_board_read` 读（按 key/tag）；`moa_board_list` 浏览元数据；`moa_board_wait` 长轮询等值/等新版本（默认 25min 安全上限）；`moa_board_delete` 墓碑删除；`moa_projects_list` 跨 harness 项目发现（MOAMCP_HOME 必须同目录）。
- `moa_handoff_*`（5）：`moa_handoff_send` 定向交接（toProject 或 user-global，v2 支持 `toAgent/fromAgent` 形如 `<label>:<sessionId>:<agentId>`）；`moa_handoff_inbox` 收件箱（state/agent 过滤）；`moa_handoff_read` 读一条；`moa_handoff_consume` 消费；`moa_handoff_archive` 归档。handoff 不参与 recall/索引，按需拉取。
- 辩论（5）：`moa_init`（agent 列表 + 参数，返回 dispatch map 含 `binding_slot`）、`moa_start_debate`、`moa_wait_turn`、`moa_submit_turn`（支持 `signoff` 一致提前收束）、`moa_complete`（归档到 `~/.moamcp/logs/<task_id>/`）。
- `moa_tower_*`（14）：`moa_tower_boot` 引导 tower 工作区（校验 repo、写状态与身份文档、注册 tower 花名册）；`moa_tower_plan` 目标拆分为 mission（`M<n>` id + `feat/M<n>-<slug>` 分支 + `wt-<n>` worktree 槽）；`moa_tower_spawn` 两阶段 spawn 的 bookkeeping 阶段；`moa_tower_register` 回填真实 agent id 并做 B2 身份交叉校验；`moa_tower_mission` 读/改 mission（worker 只能改自己的）；`moa_tower_send` / `moa_tower_inbox` 花名册消息（≤96KB）；`moa_tower_finding` 提交结构化 finding（bug/improve/vuln/idea）；`moa_tower_review` 提交审查裁决（自动记轮次与分支 tip）；`moa_tower_merge` 硬性合并门（依赖/审查干净/tip 未变等固定顺序）；`moa_tower_teardown` 拆除（脏 worktree 保留除非 force）；`moa_tower_status` 共享仪表盘；`moa_tower_ci` 跑配置的 CI 命令；`moa_tower_progress` 发进度注记。

**slash 命令**：见第三节（5 条 `/moamcp:*`）。

**Web 页面**（`src/web/`，nav 在 `app-header.ts`）：
- `/` — MOA Debate（`debate-card.ts`）：辩论卡片，展示各 agent 轮次、状态、卡片 URL。
- `/control-plane?section=memory` — Workspace Memory（`control-plane-page.ts` + `pages/` 分片）：`agents.ts` Agents & Profiles（agent 档案）；`board.ts` 共享黑板（workspace/global 双 scope、条目 modal）；`inbox.ts` Handoff 收件箱（state 过滤、详情展开、consume/archive、outbox 切换）；`projects.ts` Projects（项目身份列表 + 合并迁移动作）；`tips.ts` Project Tips（status 过滤、新建/编辑）。
- `/control-plane?section=runs` — MoA Runs（`pages/runs.ts`）：实时 runs + archives（Bus 重启后以 Archives 为准）。
- `/status-board` — Agent Status（`status-board.ts`）：按 session 分组折叠 agent 树（隶属树展示，见第四节 5）。
- `/tower` — Tower Workflow（`pages/tower.ts`）：repo 选择、mission 表（status + CI 徽章 + review gate）、roster（B2 校验标记）、近 100 条活动日志。
- `/control-plane?section=system` — System Health（`pages/system.ts`）。

**hooks**：`tower-write-guard.mjs` — 插件级 PreToolUse 守卫（详见第四节 6）：纯路径检查、profile 无关、只拦逃入 sibling zone 的 Write/Edit、mirror 两候选（`-worktrees` 反推 + cwd）、fail-open 设计。

**agents/ 三个 tower profile**（frontmatter 均声明 `slot: tower-orchestrator / tower-worker / tower-reviewer`，即守卫的匹配键）：
- `tower-orchestrator.md` — 控制塔：独占 tower 协议杠杆（boot/plan/spawn/register/mission/merge/teardown/ci），用 Agent 工具派 worker/reviewer，执行合并门；禁 `AskUserQuestion`。
- `tower-worker.md` — 在分配的工作树内执行单一 mission：读 mission、在 mission 范围内写代码、汇报进度、最终消息交回 handoff；`disallowedTools: Agent/AgentSwarm/AskUserQuestion`，工具白名单含 `mcp__moamcp__moa_tower_mission/send/inbox/finding/progress/status`。
- `tower-reviewer.md` — 只读审查一条分配分支：核 diff、跑检查、提交 `clean | p1-N | p2-N` 裁决与合并决定；禁 Write/Edit/Agent/AgentSwarm/AskUserQuestion。
- 另有 4 个辩论 profile：`critic.md`（对抗性审查）、`debater.md`（正反/魔鬼代言人，中文）、`orchestrator.md`（验证编排 + mailbox playbook）、`synthesizer.md`（收敛多方结论）。

## 六、moawerewolf 插件（`mcpexplore/moawerewolf`）

- 一句话：12–16 人多模型狼人杀游戏宿主（MCP server），一轮轮驱动夜间行动/白天发言投票，归档对局。安装方式：`/plugins` 管理器中安装（已装实例 `~/.omkc/plugins/managed/moawerewolf/`）。
- 工具族（`ww_*`，6 个）：`ww_init` 建局随机分配角色返回座位 dispatch map（含 `binding_slot`）；`ww_start` 开赛（大厅 → 第一夜）；`ww_wait_phase` 长轮询等阶段；`ww_submit_action` 提交行动（`KILL/GUARD/SAVE/POISON/CHECK/SHOOT/SPEECH/VOTE/NO`）；`ww_status` 公共快照；`ww_complete` 归档并唤醒等待者。
- 命令：`/moawerewolf:ww-new`（建局，先确认 12–16 人数、每座位 `binding_slot`、`task_id`）。
- 页面：`src/web/werewolf-page.ts`（`app-header.ts` 导航）对局卡片视图。
- agents（6 个）：`host.md`（host，`slot: host`，建局+每座位 spawn 一个 player 子代理）、`player.md`、`critic/debater/orchestrator/synthesizer.md`。
- 会话注入 skill `using-moawerewolf`；`kimi.plugin.json` 无 hooks，`mcpServers.moawerewolf` → `node ./dist/server.js`。

## 七、配置示例（真实摘录，均已核对不含密钥）

**工作区级** `D:/vscode/kimisubagentexplore/.kimi-code/local.toml`（类型绑定 + 命名槽位混用，槽位名可为任意标识符或引号包裹的模型别名）：

```toml
[subagent.critic]
model = "google/gemini-3.6-flash-tiered"
thinking_effort = "high"

[subagent.tower-worker]          # 与 tower profile 的 slot: tower-worker 对应
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot.phi3]             # 命名槽位：按槽位名寻址模型
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot."LongCat-2.0"]    # 带引号的槽位名（可用模型别名）
model = "MT/LongCat-2.0"

[subagent-slot."opensquilla/deepseek-v4-flash"]
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"
```

**全局级** `C:/Users/Yorha/.omkc/local.toml`（fallback 层，含系统固定槽位名）：

```toml
[subagent.code-coder]            # 与 ~/.omkc/agents/code-coder.md profile 同名
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent.explore]
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"

[subagent-slot.longcat]
model = "MT/LongCat-2.0"
thinking_effort = "high"

[subagent-slot.kimiforcoding]
model = "kimi-code/kimi-for-coding"

[subagent-slot.tip_save]         # /tip-save 后台总结子代理固定读取的槽位
model = "opensquilla/deepseek-v4-flash"
thinking_effort = "max"
```

**相关说明**：`C:/Users/Yorha/.kimi-code/`（官方 home）下**无 `local.toml`**，只有 `config.toml`（纯 provider 配置，含 `api_key` 等敏感字段，此处不摘录明文）；`~/.omkc/config.toml` 同样含多组 provider `api_key`，不应写入使用文档示例。`tui.toml` 的 `[moa] card = false`（moa-card 桌面卡开关，默认 true，用户本地已关）；`status_export` 键已被退役提交移除。自定义 profile 实例：`~/.omkc/agents/code-coder.md`（frontmatter：name/description/whenToUse/override/tools）、项目级 `.kimi-code/agents/test.md`。

---

**主要素材来源索引**：`kimi-code-community/apps/kimi-code/src/tui/commands/registry.ts`（内置命令）、`git diff 0b2e803d5..HEAD`（社区差异）、`COMMUNITY-CHANGELOG.md`（官方社区日志）、`packages/agent-core/src/{config/workspace-local.ts, agent/tool/subagent-binding.ts, profile/user.ts, skill/builtin/create-subagent-profile.md, agent/permission/policies/tower-worker-write-guard.ts}`、`packages/agent-core-v2/src/session/subagent/{configSection,slotBinding}.ts`、`apps/kimi-code/src/tui/components/dialogs/subagent-model-settings.ts`、`apps/kimi-code/src/cli/status-export.ts`、`mcpexplore/moamcp/{kimi.plugin.json, commands/, agents/, hooks/tower-write-guard.mjs, src/modules/*, src/web/}`、`mcpexplore/moawerewolf/{kimi.plugin.json, src/server.ts, agents/host.md}`、两份 `local.toml`。
