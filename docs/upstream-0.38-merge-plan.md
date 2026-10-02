# 官方 0.38.0 对齐合并计划（community 分支）

> 状态：计划稿（落盘于 2026-08-21，执行方式待用户核对后定）
> 执行目标：把官方 `MoonshotAI/kimi-code` 0.36.1 → 0.38.0 的更新合入社区版（oh-my-kimi-code / omkc）的 `community` 分支。

## 0. 执行方式（2026-08-21 讨论中）

用户倾向使用 tower 工作流分配任务（用户与我负责对齐内容决策），但存在技术限制：

- **merge 冲突状态是单一工作区状态**：冲突只在主 worktree（`kimi-code-community`），tower worker 在独立 worktree 看不到未提交的冲突现场；且 `git merge` 冲突是全仓库的，worker 只解自己组文件后其他组冲突标记仍在 → 无法编译、无法合并回。
- 因此推荐**混合流程**：
  1. 阶段 1（先做，非 tower）：主 worktree 完成全部 43 个冲突文件解决并提交 merge commit（A 组核心我自己，B 组外包并行，C/D 快解）。
  2. 阶段 2（tower）：boot tower（base = 已含 merge commit 的 community），把对齐后的验证与修复拆 missions（slot 正确性复核 / 外围 typecheck / 测试修复 / #3086 排除与 #3012 放宽确认 / 全量 diff 审查），每 mission 配 reviewer，全部 clean 后合并。
  3. 阶段 3：全量 typecheck/lint/冒烟 + release。
- 备选：全程 code 工作流（不用 tower）。纯 tower 方案技术上行不通（不推荐）。
- **当前状态：用户正在核对信息，阶段 1 未开工。**

## 1. 目标与边界

- 接受官方 0.38.0 全部更新，**唯独排除两个 PR**：
  - `#3012`（subagent 默认禁止嵌套派生的限制）
  - `#3086`（subagent_created telemetry 上报绑定模型别名）
- 保留我们社区版自有的核心机制：
  - subagent **slot 绑定**（`binding_slot` 工具参数、profile frontmatter `slot`、`[subagent-slot.<slot>]`、per-type `[agent_types]` 绑定）
  - tower 嵌套派生能力（orchestrator → worker / reviewer）
  - omkc 独有 CLI（status-export、moa-card-launcher 等）
- 用户已确认的路线：**接受官方重构骨架 + 放宽嵌套限制**（不改官方实现，让行为回到"无限制嵌套"，或自定义 profile 显式声明 `subagents: ["*"]`）。

## 2. 现状盘点（merge 已进行中）

- 命令：`git merge upstream/main` 已在 `kimi-code-community` worktree 执行，处于冲突状态，**未提交**。
- 分叉情况：`community` 自分叉点以来 116 个 commit，upstream 148 个 commit。
- 冲突文件：**43 个**，约 130+ 冲突点。

### 关键架构发现

官方 #3012 把 subagent spawn 链路整体重构为 **`planSpawn/spawn` 新链路**（`subagentService.ts`），
并引入了 allowlist 嵌套限制；**#3007 fork 参数就建在这条新链路上**（`spawn.ts`）。
而我们的 slot 绑定逻辑内联在旧版 `agentTool.ts` / `agentSwarmTool.ts` 的 `lifecycle.create` 链路上。
因此"排除 #3012 但保留 #3007"**不能靠 revert**，必须手动把 fork 功能与 slot 绑定融合进新链路。

- `subagentService.ts`（官方新版，245 行，已自动合入无冲突）：含 `planSpawn` / `spawn` / `run`
- `spawn.ts`（官方新增）：`SubagentSpawnPlan`、fork 常量、`forkIncompatibility`
- 我们的 slot 绑定：`slotBinding.ts`（readWorkspaceThenGlobalSlotBinding 等）、`configSection.ts`（resolveSubagentBinding 9 参版本）
- 官方移动了 `agentSwarmTool.ts`：`src/agent/tools/agent-swarm/` → `src/features/swarm/tools/agent-swarm/`

## 3. 冲突文件分组

### A 组 — 核心链路（我亲手解决，社区核心资产）

| 文件 | 冲突点 | 处理方式 |
|---|---|---|
| `packages/agent-core-v2/src/agent/tools/agent/agentTool.ts` | 5 | 官方 planSpawn 骨架 + 我们的 slot 解析下沉进 planSpawn；合并 strip 参数逻辑（binding_slot 与 fork 并存） |
| `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts` | 8 | 同上；接受官方文件新位置 |
| `packages/agent-core-v2/src/session/subagent/configSection.ts` | 7 | 保留我们 9 参 `resolveSubagentBinding` + agentTypes 段；接受官方 schema 变化 |
| `packages/agent-core-v2/src/session/subagent/flag.ts` | 2 | 保留我们两个 flag（secondary-model / subagent-model-selection）+ 官方 fork flag |
| `packages/agent-core-v2/src/index.ts` | 3 | 导出合并：保留 overlay/agentTypes 导出 + 官方新增 |
| `packages/agent-core-v2/src/agent/profile/profileService.ts` | 2 | 官方 AgentStatusUpdated 事件 + 我们 subagentBindingDisplayModel |
| `packages/agent-core-v2/src/app/agentProfileCatalog/agentProfileCatalog.ts` | 1 | allowlist 相关，合并后统一在 #3012 放宽步骤处理 |
| `packages/agent-core-v2/src/features/swarm/session/sessionSwarm.ts` / `sessionSwarmService.ts` / `agentRunBatch.ts` | 2/4/2 | 新链路 plan 传参适配 |
| `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/*`（types/agentFile/agentProfileFromFile/systemFile） | 1/2/1/1 | 小冲突，并入核心 |

### B 组 — 外围简单冲突（外包 code-coder 并行）

| 文件 | 性质 |
|---|---|
| `packages/node-sdk/src/rpc.ts` / `sdk-rpc-client-v2.ts` / `session.ts` / `kimi-harness.ts` | import 合并型 |
| `packages/node-sdk/test/sdk-rpc-client-v2.test.ts` / `v1-v2-parity.test.ts` | import 合并型 |
| `packages/kap-server/src/routes/modelCatalog.ts` | import 合并型 |
| `apps/kimi-code/src/cli/update/cdn.ts` / `preflight.ts` / `constant/app.ts` / `tui/commands/config.ts` | import + 常量合并 |
| `apps/kimi-code/test/cli/update/*.test.ts` / `run-shell.test.ts` | import 合并型 |
| `apps/kimi-code/package.json` / `package.json`（根） | 版本号保留 omkc，依赖合并官方 |

### C 组 — 测试文件（核心稳定后外包）

`swarm.test.ts`(22)、`tool.test.ts`(15)、`preflight.test.ts`(8)、`fullCompaction.test.ts`(6)、
`config.test.ts`(4)、`sessionSwarm.test.ts`(3)、`harness/agent.ts`(2)、`agentFile.test.ts`(2)、
`composition.test.ts`(1)、`loop.test.ts`(1)、`run-shell.test.ts`(3)、`sdk-rpc-client-v2.test.ts`(1)、`v1-v2-parity.test.ts`(1)

### D 组 — 文档/杂项（小）

`.agents/skills/gen-changesets/SKILL.md`(5)、`docs/zh/customization/agents.md`(1)、
`CONTRIBUTING.md`(1)、`packages/agent-core-v2/docs/config-manifest.toml`(3)

## 4. 执行步骤（todo 顺序）

1. **核心链路融合**（A 组，我自己）：
   - `configSection.ts`：确认 9 参 `resolveSubagentBinding` 签名保留，接受官方 schema/注册变化
   - `subagentService.ts`：在官方 `planSpawn` 中接入我们的 slot 解析（扩展 `SubagentSpawnPlanInput` 或注入 slotBinding/typeBinding/toolSlotBinding 数据）
   - `agentTool.ts` / `agentSwarmTool.ts`：官方骨架 + slot 数据下沉，`binding_slot` 与 `fork` 参数并存
   - `flag.ts` / `index.ts` / `profileService.ts` / swarm 系列 / workspaceLoader：合并
2. **外围冲突**（B 组，外包 code-coder，后台并行）
3. **排除 #3086**：`packages/agent-core-v2/src/app/telemetry/events.ts`（2 行）、`mirrorAgentRun.ts`（7 行改动中剔除 model 上报部分）、`tool.test.ts` 相关断言
4. **#3012 嵌套限制放宽**：官方 allowlist 骨架保留，但让行为回到无限制——
   - 优先方案：我们的自定义 profile（orchestrator/tower-worker 等）显式声明 `subagents: ["*"]`
   - 兜底：若官方默认 allowlist 仍拦截（root 非 main 时），调整 `profile-shared.ts` 的 allowlist 逻辑为无限制
5. **测试文件**（C 组，核心稳定后外包 code-coder）
6. **文档/杂项**（D 组）
7. **构建 + typecheck + 冒烟验证**
8. **提交合并**（commit message 按仓库惯例，不加 co-author）

## 5. 验证清单

- [ ] `pnpm install`（确认依赖合并无冲突）—— 注意：subagent 禁止跑 install，我自己验证
- [ ] `pnpm typecheck` 全绿
- [ ] `pnpm lint` 全绿（agent-core-v2 注释禁区）
- [ ] 核心功能冒烟：
  - `binding_slot` 工具参数生效（slot 绑定不被官方骨架丢掉）
  - per-type `[agent_types]` 绑定生效
  - `fork` 参数可用（#3007 保留）
  - tower 嵌套派生可用（#3012 限制被放宽）
  - telemetry 无 model 上报（#3086 被排除）
- [ ] omkc 特有功能（status-export、moa-card-launcher、TUI 设置页）不回归

## 6. 风险

- **核心融合风险**：slot 绑定注入官方 `planSpawn` 时，官方 `resolveSubagentBinding` 是 4 参版本，我们的是 9 参——需要小心对齐参数顺序，避免静默丢层。
- **fork 与 slot 交互**：fork 语义是"继承调用者模型"，slot 语义是"绑定指定模型"——两者并存时优先级需明确（参考现有链：explicit > tool slot > profile 偏好 > agent_types > slot > local type > secondary > caller）。
- **#3012 放宽的副作用**：如果直接改官方 allowlist 逻辑，可能与官方后续升级冲突；优先用 profile 显式 `subagents: ["*"]` 声明，少改官方源码。
- **测试耦合**：`tool.test.ts` 被 #3012（324 行新增测试）和 #3086（1 行）都动过，revert #3086 时注意不误删 #3012 测试的保留部分。

## 7. 合并路线（已确认）

**接受官方重构骨架 + 放宽 #3012 嵌套限制（行为回到现状）+ 独立移除 #3086 + slot 绑定重植到新链路。**

放弃的方案：完全排除官方重构（保留旧 lifecycle.create 链路）——与官方分叉加深，后续每次官方改动 spawn 链路都要手工跟。
