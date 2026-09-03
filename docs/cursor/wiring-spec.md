# Cursor Provider 官方接线：施工规格（供 tower 拆 mission）

> 依据：`docs/cursor/official/` 下 5 份官方权威文档。规则：**有官方出处的按官方做，无出处的标注为自研推断**。
> 目标：社区版跑通后整理 PR/issue 反馈上游 MoonshotAI/kimi-code（官方无 cursor 适配，全量自研）。
> 状态：设计已定，未施工（`resolveWireModel` 的编辑尚未落盘）。

## M1. 参数解析统一（接线 1）

**文件**：`packages/kosong/src/providers/cursor.ts`（核心）、`packages/kosong/test/provider.test.ts`（测试）
**依据**：`docs/cursor/official/model-parameters.md` 全文 + `official/subagents-and-bridge.md` 的方括号语法
**依赖**：无。可最先做，改动集中在一个函数。

### 1a. 方括号语法解析（新函数 `parseModelRequest`）

官方语法 `model[k=v,...]`（`claude-opus-5[effort=high,context=300k]`），空 `[]` = 钉基础模型。

- 拆分为 `{ id, inline: [{id, value}] }`；
- 无括号 → 原样透传；
- 括号不匹配 / 空 base id → 视为整体 id（不猜）；
- 畸形 pair（无 `=` 或空 key/value）→ 丢弃该项，**不发送无文档含义的值**。

### 1b. 重写 `resolveWireModel`（按官方"按能力解析"范式）

优先级：**内联方括号 > config `modelParams` > effort 解析结果**。

逐项校验：每项都用 catalog 声明的 `values` 校验，**不在集合内则回退裸 id**（沿用既有策略）。

| 参数 | 处理 | 现状 |
|:---|:---|:---|
| `effort` / `reasoning` | 查 catalog 实际声明的 id（`effort` 多数模型，`reasoning` GPT 系）；`xhigh`→`extra-high` 仅对 `reasoning` | ✅ 已有，保留 |
| `thinking` | 模型声明了 boolean `thinking` 才加 `true` | ✅ 已有，保留 |
| **`fast`** | 新增。值 `"true"`/`"false"`，官方 composer-2.5 示例一级公民 | ❌ 新增 |
| **`context`** | 新增。窗口大小，如 `"300k"` | ❌ 新增 |
| **`optimize_for`** | 新增。**仅 `auto-smart`（Router）**，`cost`/`balanced`/`intelligence`；官方要求"始终显式传入" | ❌ 新增 |
| 其他声明参数 | 透传内联/配置值（校验值域） | 新增（通用化） |

**不硬编码任何参数 id 或值域**——全部依据 catalog 声明（官方最佳实践第 1、3 条）。

### 1c. 三层回退链（官方原文）

> "当目标模型不可用时，优先显式选择 Router（`auto-smart` + `optimize_for`）。只有在希望由服务器选择 Auto，且不指定 Cost、Balance 或 Intelligence 时，才回退到 `{ id: "auto" }`。"

1. 请求模型在 catalog → 用它；
2. 不在 → `auto-smart` + `optimize_for: balanced`；
3. 再不行 → `{ id: "auto" }`。

**注意**：现有 `DEFAULT_MODEL_ID = 'default'`（免费档 Auto）。官方回退链第二层是 `auto-smart`、第三层 `auto`，与 `default` 的关系需确认（`default` 是 SDK/免费档的 Auto id，`auto` 是服务器选择 Auto）。**保留 `default` 作为最终兜底**，不要破坏已通过的 auto-smart 冒烟（`af2c3b329`）。

### 1d. 测试

现有测试（`provider.test.ts` 约 8 个 effort 用例）必须全绿。新增：
- 方括号解析（含 `[]`、畸形、多参数）；
- `fast` / `context` / `optimize_for` 解析与值域校验；
- 优先级：内联 > modelParams > effort；
- 三层回退链。

---

## M2. per-send 覆盖（接线 2）

**文件**：`cursor.ts` 的 `generate()`（约 597-636 行）
**依据**：`official/sdk-typescript.md` §6-7（model/mode 覆盖）、`official/model-parameters.md` §1（`SendOptions` 结构）

### 2a. model 覆盖

现状：model 只在 `Agent.create({model})` 传（cursor.ts:610）。
官方：`send(prompt, { model })` 覆盖**持续生效**（"后续发送时若未指定覆盖，将继续使用新模型"）。

改动：`agent.send(outgoing, { model: selection, ... })`。注意 **resume 路径也要传**（官方：resume 后 `model` 为 `undefined` 直到设置）。

**收益**：TUI 动态切换模型/参数不必重建会话。

### 2b. mode 覆盖（**跨包改动，需单独评估**）

官方：`send(prompt, { mode: "plan" | "agent" })` 逐轮切换；省略则保留当前模式。
另：ACP 侧有三种模式 `agent`/`plan`/`ask`，但 **SDK `SendOptions` 只声明 `plan`|`agent`** —— **不要用 `ask`**。

**已探明的两处约束**（影响实现方式）：

1. **`withThinking` 是 clone 范式**：`agent-core/src/agent/config/index.ts:212` 每次访问 `provider` 都 `withThinking()` clone 出新实例，engine 每轮拿到的是新 clone。新增 `withMode()` **必须沿用此范式**，否则状态串。
2. **`ChatProvider` 接口无 mode 通道**：`kosong/src/provider.ts` 只有 `withThinking`。加 mode 需改公共接口 → **kimi/anthropic/openai/google 四个 provider 都要实现或给默认实现**。

因此 mode 接线有两个可选方案，需先定：

- **方案 A（跨包）**：给 `ChatProvider` 加 `withMode(mode)`，对所有 provider 提供默认实现（no-op），cursor 实现真实行为。面大但符合 engine 架构。
- **方案 B（局限）**：cursor provider 内部从 config 读静态 mode（不走 engine plan 状态）。面小但**拿不到 engine 的 `PlanMode._isActive`**（`agent-core/src/agent/plan/index.ts:13`），plan 切换无法自动联动。

**建议 M2 拆成 M2a（model 覆盖，纯 cursor 内）与 M2b（mode 覆盖，需先定 A/B）**，M2b 可后置。

---

## M3. agent 容器管理（P0-④）

**依据**：`official/sdk-typescript.md` §3（local.store 可注入）+ §10-11
**依赖**：无

- **问题**：正常流结束从不 `agent.close()`（仅错误/abort 路径，cursor.ts:641/649）→ SDK sqlite 孤儿持续堆叠。
- **官方手段**：`local.store` 可注入（`SqliteLocalAgentStore` / `JsonlLocalAgentStore` / 自定义 `LocalAgentStore`），`Agent.list/get/listRuns/getRun` 需与 `resume` 用**同一 store 实例**。
- **可做**：① 为 engine session 注入独立 store（同时解 S5 多会话交错）；② 生命周期挂钩：子 agent 完成/主会话结束 → `close()`；③ 用 `Agent.list` 做旧会话归档策略。

## M4. agentId 持久化（P0-③）

**依据**：`official/sdk-typescript.md` §2 + `official/subagents-and-bridge.md`
**依赖**：M3（store 注入）

- 官方确认跨进程 resume 支持（SQLite 检查点持久化）；官方调度器范式 = 维护 `agentId → SDKAgent` 映射，重启后从磁盘恢复并 `resume`。
- 实现：session↔agentId 映射持久化 + 恢复时 `Agent.resume(agentId)`。
- 连带修正：无 agentId 时的降级语义（现在是"把工具结果塞进新会话"，语义错）。

## M5. 错误链路（P1-⑥）

**依据**：`official/hooks-and-changelog.md` §2（1.0.23+）
**依赖**：无，改动小

- 1.0.23+ 失败运行暴露结构化错误 `{ message, code }` → 用 `error.code` 分类，不解析消息文本。
- 映射目标：`RequestError.authRequired`（401）、配额/429、`shouldLogout`。

## M6. 压缩联动重定位（P0-②）

**依据**：`official/hooks-and-changelog.md` §1（`preCompact`）
**依赖**：N1 真机结论

- **已推翻**：原以为 SDK 无压缩 → 官方 `preCompact` 证实**上游有自动压缩**，但明确 "cannot block or modify"。
- 重定位：从"我们触发重建"改为"**观测上游压缩 → 同步 engine 侧状态**"。
- `preCompact` 输入含 `context_tokens` / `context_window_size` / `context_usage_percent` —— 但**只在压缩发生时才有**。

## 真机验证任务（可与 M1 并行）

**一次请求打日志**（`mapUsage` 处，cursor.ts:384-394），同时定位：
1. **1.5M 假象**：官方已确认 usage 流事件是 per-turn，需查 cache 计数叠加与 TUI `Session usage` 面板（`usage-panel.ts:102` 按模型累加每轮 input+output）的累计账单；
2. **N1**：`preCompact` 的 `context_tokens`/`context_window_size` **能否不经压缩事件也读到**——决定 M6 与 P2-⑨ 走向。

---

## 补充：S1 system prompt 失忆的分层处理（探索结论）

**依据**：`docs/cursor/exploration-rules-injection.md` 全文。

### 关键事实：`LocalAgentOptions` 无 systemPrompt 字段

实测 `options.d.ts` 字段全集：`cwd`、`dirs`、`autoReview`、`store`、`settingSources`、`sandboxOptions`、`customTools`、`enableAgentRetries`。
文档里的 `AgentDefinition.prompt`（"子智能体的系统提示词"）属于 Cloud Agent / 子智能体路径，**本地 agent 用不上**。
→ engine 的 systemPrompt **无法通过 SDK 参数传入**，只能走文件系统（rules / AGENTS.md）。

### 官方规则机制

- `rules.md`：规则内容 "included at the start of the model context"；`alwaysApply: true` 每轮都在；`.mdc` 扩展名必需（纯 `.md` 会被忽略）；也支持 `AGENTS.md`。
- `local.settingSources`：`"project" | "user" | "team" | "mdm" | "plugins" | "all"`；**默认不读磁盘**（"未设置时只会加载内联服务器"）；不适用于云端代理。
- `agent.reload()`：不释放资源重读文件系统配置 → 规则更新**不必重建会话**。

### 结论：规则文件方向**可行但有代价**

- ✅ 机制支持，注入位置正确，每轮都在，`reload()` 可热更新；
- ⚠️ **侵入用户仓库**（写 `.cursor/rules/` 或 `AGENTS.md`，后者可能与用户/其他工具已有文件冲突）；
- ⚠️ 高频动态约束（plan/goal/临时 reminder）不适合走文件（开销与原子性都不如传参）；
- ⚠️ **自研推断**：官方 rules 是给用户在 Cursor 产品里用的，无"嵌入方写规则文件注入自身约束"的用法说明。

### 分层方案（建议）

| 约束类型 | 方案 |
|:---|:---|
| 静态项目规范 | 可选写 `.cursor/rules/*.mdc`（**需用户明确同意**，侵入式） |
| 高频动态（plan/goal/reminder） | 重建窗口注入，或**每轮 user 消息前缀** |
| 多 harness 复用 | `.claude/` / `.codex/` 兼容目录单独评估（对 DSH④ 有价值） |

**最低成本兜底**：每轮把当前 systemPrompt 作为 user 消息前缀发送（而非只在首轮）。代价是多发重复 token，但**前缀稳定 → cache 命中 → `cacheReadTokens` 吸收**。不侵入用户仓库、不改架构，建议优先验证（N10）。

### "窗口注入"不是新包一层壳（概念澄清）

`cursor.ts` 这 789 行**本身就是**包住 SDK 的那层壳（`buildFreshPrompt` / `trailingToolResults` / `toSdkCustomTools` 都在做 engine→SDK 语义翻译）。窗口注入是在**这层已有的壳里换分支**（丢弃旧会话 → create 新的 → 完整上下文打包成首条消息），不是再加一层。

**且随官方探索推进，需要走这个分支的场景正在减少**：
- 切模型/参数 → `send({model})` 覆盖后持续生效（原生）；
- 切 plan mode → `send({mode})` 逐轮可切（原生）；
- 压缩不同步 → 官方证实上游自动压缩（M6 已改为"观测同步"，可能不需重建）。

### 2c. `local.force` 与 `idempotencyKey`（并入 M2a，同为 `send()` 参数）

**`local.force`**（`options.d.ts` + 官方 3154 行附近）：

- 语义："仅限智能体。默认 `false`。开始发送此消息前，使卡住的活跃运行过期。"
- 官方原文：**"本地智能体不会返回 `agent_busy`"** → 卡住的本地 run **不会报错，会一直卡着**；云端才返回 `agent_busy`（409）。
- 我们现状：`generate()` 只有 abort / error 两条路径调 `agent.close()`（cursor.ts:641/649），**卡住的 run 无任何检测或恢复手段** → 长会话挂死风险。
- 建议：`send({ local: { force: true } })`，或加"上次 run 未结束才 force"的判断避免无谓终止。

**`idempotencyKey`**：客户端生成的幂等键，用于单次 send。关系到重试去重（见下）。

### 2d. 重试语义（N3 已定性：双层重试确实存在）

**`enableAgentRetries`（`options.d.ts:162-167`）**：

> "Enable transport and stall auto-retry for local agent runs. **Defaults to true for headless embedders**; set false to surface transport errors on the first failure (legacy SDK behavior)."

- 我们是 headless embedder → **SDK 内部重试默认开启**；
- 但范围是 **"transport and stall"**（传输层失败与卡住），非"请求失败就重试"——对我们其实有益（不用自己处理网络抖动）；
- **建议保持默认 `true`**，关掉反而要自己处理传输抖动。

**配套：`CursorSdkError.isRetryable`**（官方："可使用 `isRetryable` 控制重试逻辑，并通过 `code`/`status`/`requestId` 进行诊断"）：

- `RateLimitError`（突发限流）→ `isRetryable: true`，官方建议指数退避；
- `AgentBusyError`（`agent_busy`）→ **`isRetryable: false`**，"立即重试会一直失败，直到正在运行的任务结束或您将其取消"；
- 其他 409（如 `agent_archived`）→ 抛 `ConfigurationError`。

**接线动作**：
1. `send()` 传 `idempotencyKey`（防跨层重复请求产生重复计费）；
2. **engine 侧重试判据改用 `error.isRetryable`**（比自猜错误类型靠谱），避免在 SDK 已自动重试的场景下重复重试；
3. M5（错误链路）一并纳入 `isRetryable` 字段。

## worker 进程模型（已确认：独立进程）

依据：`agent-core/src/agent/permission/policies/tower-worker-write-guard.ts` 注释 —— "TowerSpawn sets the agent's **cwd** to the worktree"、worker cwd 为 `<repoName>-worktrees/<slot>`；guard mirror `<repoRoot>/.tower-guard.json` 由 moamcp tower controller 写、omkc policy **读文件**（`tower-guard-mirror.ts`），且 policy 按 **agentId** 匹配身份。

→ 跨 worker 只能靠**文件通信**与 agentId 匹配 = **独立进程**。

**对 `pinBackendUrl` 的意义**：

- worker 之间**不会**触发 process-global 冲突（各进程独立）；
- 残余风险：**主 agent 与其 engine 侧 spawn 的 subagent 若同进程**、且配置了不同模式（一直连一网关）→ 冲突。概率低（配置通常一致），但接线时应记录。

## 待定项（影响上述任务设计，尽量先验证）

| 编号 | 内容 | 影响 |
|:---|:---|:---|
| N1 | `context_tokens` 平时能否读到 | M6、P2-⑨ |
| N2 | `send()` payload 上限 | 重建包体积权衡（若 M2a 落地，重建需求下降） |
| N3 | SDK 内部是否有自动重试 | 双层重试吃额度（Team 双池每次交互计 1） |
| N4 | `customTools` 是否完全接管 SDK 内置工具（bash/read） | 权限泄漏面 S6 |
| N5 | 1.0.28~1.0.30 变更未知（changelog 只到 1.0.27） | 全部 |
| N6 | subagent 嵌套两层限制是否影响我们 | cursor 侧派生受限于两层；engine 侧派生不受限 |
| **N11** | **额度模型：2000 是次数还是金额？** | 用户推论：2000 次实际代表约 $20 额度而非交互次数（待实测确认）。**直接影响并发策略**：若为次数，tower 并行派 N 个 worker 线性吃掉次数，需控制并发或给 reviewer/critic 走便宜渠道；若为金额，则无"次数硬墙"，只是花钱快慢。官方 subagents 文档另注"Running five subagents in parallel uses roughly five times the tokens"。 |

## 建议 mission 拆分顺序

```
M1（参数解析）─┬─ 真机验证（并行）
               └─ M5（错误链路，小改动）
M2a（model 覆盖）→ M3（容器）→ M4（持久化）
M2b（mode 覆盖，待 A/B 决策）
M6 / P2-⑨（待 N1 结论）
```

M1、M5 无依赖可并行；M2a→M3→M4 有依赖需串行。文件作用域基本都在 `packages/kosong/src/providers/cursor.ts` + 其测试，**M2b 若走方案 A 会触及 kosong 公共接口与其他四个 provider**，需单独隔离。
