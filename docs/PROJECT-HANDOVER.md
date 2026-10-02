# PROJECT HANDOVER — oh-my-kimi-code 社区版全项目交接

> 2026-09-24 写就。供新 session 从零接手整个项目。读完本文 + 根 `AGENTS.md` 即可开工。
> 单任务级交接（gemini 消融）另见 `docs/HANDOVER-gemini-signature-ablation.md`。

## 1. 项目身份

| 项 | 值 |
|---|---|
| 项目 | oh-my-kimi-code（omkc）—— MoonshotAI/kimi-code 的社区 fork |
| 本地路径 | `D:\vscode\kimisubagentexplore\kimi-code-community` |
| 工作分支 | `community`（HEAD `4c4d4bca4`，工作树干净） |
| 主远端 | `omkc` = `https://github.com/Yorha9e/oh-my-kimi-code.git`（`community:main`） |
| 旧远端 | `fork` = `https://github.com/Yorha9e/kimi-code.git`（历史遗留，不再推送） |
| 上游 | `MoonshotAI/kimi-code`（基线 0.34.0 起家，其间对齐过 0.36/0.38 部分内容；上游 CLI 现已到 2.0.x，协议层仍兼容，详见 §6 对齐策略） |
| 当前版本 | **1.0.3**（已发布 release + tag，本机全局已装） |
| 呼出命令 | `omkc`，数据目录 `~/.omkc` |

## 2. 架构速览（改代码前必读）

详细规则在根 `AGENTS.md`（每个包还有自己的 AGENTS.md），这里只给地图：

- `apps/kimi-code` — CLI/TUI。只准经 `@moonshot-ai/kimi-code-sdk` 消费核心，不准直依赖 agent-core。
- `packages/agent-core`（v1）— 老引擎，处于维护态（社区版退化路径），**默认不动**。
- `packages/agent-core-v2` — DI × Scope 新引擎（四层 LifecycleScope + L3 单元 + Feature 缝）。**无注释区**：只允许导出符号 JSDoc，`pnpm lint` 有 check-no-comments 门禁。
- `packages/kosong` — LLM provider 抽象层。四个在役渠道：anthropic / openai(含 responses) / google-genai / kimi。cursor 渠道已退役封存（§5）。
- `packages/kap-server` — HTTP/WS 服务面（v2 引擎承载）。
- `packages/klient`、`packages/node-sdk`、`packages/transcript`、`packages/minidb`、`packages/protocol` 等支撑层。
- 双引擎现状：v1 是退化路径、将逐渐剥离；**新能力默认落 v2**。

关键镜像惯例：kosong 的 provider 实现与 v2 的 `src/kosong/provider/bases/<name>/` 是**逐语义镜像**——改一处必须同步另一处（这是历史翻车第一名）。

## 3. 发版与安装流程（每次更新都走这条）

1. 改代码 → 测试（kosong 全量 + v2 after-only）→ changeset（`.changeset/`，规范见 `.agents/skills/gen-changesets/`；**major 不得自作主张**）→ commit（conventional、无 Co-Authored-By）。
2. `apps/kimi-code/package.json` bump 版本号 → `pnpm -C apps/kimi-code run build`（**必须先 build 再 pack**，产物随 dist 走）→ 验证 `node apps/kimi-code/dist/main.mjs --version`。
3. `cd apps/kimi-code && npm pack --pack-destination ../../.tmp/`。
4. 提交 bump → `git push omkc community:main` → 打 tag `oh-my-kimi-code@<ver>` 并推（自动触发 Release Native + CI workflow）。
5. 本机安装：确认无 omkc 实例占用（`Get-CimInstance Win32_Process ... main.mjs`），有则用独立计划任务看门狗（`Register-ScheduledTask` + 等待进程清零 + `npm install -g .tmp/*.tgz` + 冒烟——成熟模式，1.0.2/1.0.3 两次验证；脚本模板在 `.tmp/install-10*-detached.ps1`）。
6. 冒烟：`omkc --version` / `omkc doctor config` / `omkc doctor tui` / 真实对话。

**Windows 环境固有噪音**（判回归用 after-only，别被吓到）：
- v2 全量测试约 134 个环境性失败（路径分隔符/stdio 类，`git stash` 对照可证）；
- `test/wire/wireManifest.test.ts` Windows 恒红（生成器路径 bug，pre-existing）；
- `minidb test/cluster/concurrent.test.ts` 在 CI 偶发 flaky（本地 7/7 绿）；
- `configManifest.test.ts` 是 `it.skip`（backlog：去 skip）。

## 4. 项目当前状态（截至 2026-09-24）

### 4.1 已发布的社区能力（相对上游的差异化清单）

- **Subagent 模型绑定体系**：per-type slot 绑定（`/subagent-model` 命令 + settings 面板）、全局层绑定、swarm 作用域、resume 保模型。相关文档 `SUBAGENT_*.md` 在 `D:\vscode\kimisubagentexplore\` 父目录（历史 PR 讨论稿）。
- **swarm/塔台工作流**：v2 `features/tower/` 全套（protocol store、rate limit、tower-mode service、11 个 Tower 工具、tower-worker profile）。
- **goal mode**（v1+goal 拆分文档 `GOAL.md`）、moa-card-launcher 等集成。
- 完整用户面清单见 `COMMUNITY-FEATURES.md` 与 `COMMUNITY-CHANGELOG.md`（含 40 条内置 slash 命令盘点）。

### 4.2 cursor 渠道——已退役封存

完整过程见 `docs/cursor-sealed-summary.md` 与 `docs/cursor-retirement.md`。要点：
- 全部实现（P0 持久化 + P1 compact 联动 + P2 跨模型注入，含修复）在 **attic/cursor/**（23 文件逐字节保真）+ tags `baseline-cursor-p1p2`（全能力态）/`baseline-pre-cursor`（纯净态）；
- 逆向研究 16 篇文档保留在 `docs/cursor/`（**是资产**，VitePress 已 srcExclude 不进 docs 站构建）；
- 远端从未有过 cursor 代码；1.0.2 起为无 cursor 版本。

### 4.3 gemini 渠道签名线（最新战役，刚收尾）

- 调查结论：`@google/genai` 1.49.0 与 2.23.0 签名行为**字节级一致**，SDK 从不校验签名（哨兵是民间手段），**锁 1.49.0 不升级**；400 真因是客户端拆分并行 FC 的 Content（js-genai #1275）+ text part 丢签名（#1116）。
- 已修两个缺口并发布（1.0.3）：text part 签名保留（`TextPart.signature` 字段）+ 签名 400 进恢复通道。
- **待办（下一仗）**：签名链路消融实验——任务书 `docs/HANDOVER-gemini-signature-ablation.md`（S1-S5 骨架切分、A-E 消融矩阵、三阶段施工）。
- 网关联动：gemini shim 网关（`D:\vscode\sub2api\gemini-shim`，端口 51143 系）按 CPA 格式重写签名处理中（我方需求 ho_19f2ac1ca810，我方实测报告 ho_8a6a63e4c8d3 已回复）。**若消融改变回传结构，须发 handoff 同步网关**（moamcp handoff，toProject=user-global）。

### 4.4 待办/backlog（优先级序）

1. **gemini 签名消融实验**（任务书就绪，正是本次交接的启动任务）；
2. TUI ①：Session usage 面板语义分离；
3. 上游 PR/issue 整理反馈（社区自有功能中可上游化的部分，**cursor 相关永远不提**）；
4. T6：过期 token 刷新 + 401/429 呈现；
5. DSH 移植四批次：①轨迹可视化（`D:/vscode/dsh/extracted-modules` 源料，已有 ui-trajectory tips）②CoT 优化器 ③workflow 引擎 ④ACP 多 harness；
6. 小修：configManifest 测试去 skip、doctor 感知 salvage 丢弃项、search worker OOM 排查、minidb CI 重试配置、S4（image_in 续聊丢图——随 cursor 退役已降级，评估是否取消）。

## 5. 环境与工具链

- Node `>=24.15.0`、pnpm `10.33.0`（engine-strict，版本不对 `pnpm install` 直接失败）。
- 常用命令：`pnpm -C apps/kimi-code run build`（构建）；`npx vitest run --project kosong`（kosong 全量）；`pnpm --filter @moonshot-ai/agent-core-v2 run test`（v2）；`pnpm --filter @moonshot-ai/kosong run typecheck`；`pnpm lint`（含无注释门禁）。
- `gh` CLI 已配置（查 workflow/release 用它）；moamcp 插件在跑（handoff/blackboard/tips/Tower 工作流可用，tower 用于多任务施工，注意 mission scope 两两不相交）。
- 用户环境：Windows + Git Bash（bash 调用一律显式传 cwd）；本机有代理/网络波动史（远端操作失败先怀疑网络）。
- 网关联调渠道：moamcp handoff（user-global）。gemini 网关生产实例 `127.0.0.1:51142/51443` 系。

## 6. 对齐上游的策略（既定，不要重开讨论）

- **不盲目跟版本**：四客户端 SDK 例行核对结论（2026-09-19）全部"观察"——anthropic 0.95.2 / openai 6.34.0 / google-genai 1.49.0 / kimi 协议兼容。跟进触发条件：新模型依赖新 SDK 范式、或 CVE。
- 官方 kimi-code 的 provider/协议层变更值得对齐（用最小改动），桌面端/架构类变更不跟。
- 上游对齐走 `docs/upstream-0.38-merge-plan.md` 的模式：逐文件核对差异，防止上游 PR 混入。

## 7. 新 session 开工清单

1. 读根 `AGENTS.md`（全仓规则）+ 本文；
2. 按任务读对应 `docs/` 文档与最近 git log（`git log --oneline -20`）；
3. 接手 gemini 消融：读 `docs/HANDOVER-gemini-signature-ablation.md` → 按阶段一开工；
4. 一切 git 变更（push/reset/tag）先问用户；发版走 §3 流程；
5. 遇"上游模型无响应"类 subagent 挂起：先查模型渠道是否下线（本仓 subagent 绑定槽机制可换模型），别死等。
