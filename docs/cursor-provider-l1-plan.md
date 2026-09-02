# Cursor Provider L1 接入计划（oh-my-kimi-code 社区版）

> 交接自 gemini-shim 主 session（ho_cursor_v2_l1，2026-08-31）
> 级别：L1 胶水级 | 预计 0.5-1 人日 | 仓库：`D:/vscode/kimisubagentexplore/kimi-code-community`
> 本文为开工前审核稿；审核通过后按此执行。

## 0. 一句话任务

在社区版 kosong 的 provider 协议栈里新增与 openai/anthropic **并列的 cursor 协议**：进程内嵌 `@cursor/sdk@1.0.30`，用 `setConnectTransportFactory` 注入本机 Cursor IDE SQLite 的 accessToken（绕过 crsr_ 付费门槛），把 Cursor agent 的事件流转成 `ChatProvider` 契约的流式输出。

## 1. 协议栈定位（并列协议，零侵入上层）
```
apps/kimi-code (TUI/CLI)                ← 不动
packages/agent-core-v2 (modelCatalog)   ← 不动（alias → Model 通用）
packages/kosong/src/providers/
  ├─ openai.ts / anthropic.ts / ...     ← 已有 5 个 wire
  └─ cursor.ts                          ← 新增（唯一新文件）
  └─ index.ts                           ← 接线 3 处：
      1. ProviderConfig 加 ({ type: 'cursor' } & CursorOptions)
      2. createProvider 加 case 'cursor'
      3. getModelCapability 加 case（返回 UNKNOWN_CAPABILITY，非致命）
```

上层 agent-core-v2 的 catalog、请求路由、遥测零改动；未来 `git merge upstream` 冲突面收敛在 index.ts 三行。

## 1.5 双上游模式（2026-08-31 定稿）

cursor 协议 provider 只负责"讲 Cursor 原生协议"（AgentService/Run bidi、流映射、工具桥接）；**上游可插拔**，账号池/额度/选路全部推给网关（sub2api 侧职责）：

- **direct（默认）**：直连官方 `api2.cursor.sh`。token 来源 `tokenSource: ide`（本机 Cursor IDE SQLite 寄生，已验证零配置）| `sdk-login`（SDK 自带 `Cursor.auth.login` OAuth 流程，浏览器登录铸 apiKey 存 `~/.cursor/sdk/auth.json`，正规军路径）。
- **gateway**：`baseURL` 指向自建网关，由网关做账号选择与转发。**已验证可行性**：SDK bundle 三处端点默认值均为 `process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh"`，模块加载时求值——provider 在动态 import SDK 前按 config 设置该 env 即可，两种模式共用同一条 SDK 代码路径。`apiKey` 传网关签发的 key。

边界与纪律：
- `CURSOR_BACKEND_URL` 是**进程级全局**：同一进程同时配 direct + gateway 两个 cursor 上游会冲突，L1 检测到直接报错，不硬解。
- 网关侧必须讲 Cursor 原生 ConnectRPC（`agent.v1.AgentService/Run` bidi）——这是 sub2api 网关的活（L2，参考 `tmp/Cursor2API` bridge 范式）。若网关只出 OpenAI 兼容口，本 provider 无存在意义（用现有 openai provider 即可）。
- 配置形态：`[providers.cursor] type="cursor"`（direct）；`type="cursor" baseURL=... apiKey=...`（gateway）。model 一律建议 `default`（=Auto）。

## 2. 已核查的硬事实（勿重复验证）

| 项 | 结论 |
|---|---|
| 逆向报告 | `D:/vscode/sub2api/tmp/cursor-sdk-rev/INTELLIGENCE.md`（200 行）+ `extracted/{agent_v1,aiserver_v1}.proto` |
| 实际通道 | `agent.v1.AgentService/Run` bidi（19 方法），端点 `https://api2.cursor.sh`，SDK 不走 StreamUnifiedChatWithTools |
| 鉴权 | 唯一校验头 `authorization: Bearer <JWT accessToken>`（小写）；IDE SQLite 现成 JWT 可直接注入 |
| 头指纹 | `x-cursor-client-version: sdk-1.0.30`、`x-cursor-client-type: sdk`、`x-ghost-mode`、`x-request-id`(randomUUID)；无 checksum |
| token 刷新 | `POST api2.cursor.sh/oauth/token`，body `{grant_type:"refresh_token", client_id:"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token}` → `{access_token, id_token, shouldLogout}`；`shouldLogout:true` 必须停用 |
| SQLite 路径 | Windows `%APPDATA%\Cursor\User\globalStorage\state.vscdb`，表 `ItemTable`，key `cursorAuth/accessToken`（JWT）/`cursorAuth/refreshToken` |
| SQLite 依赖 | **零新增**：Node 24 内置 `node:sqlite`（DatabaseSync 本机验证通过），只读 `mode=ro&immutable=1`（规避 IDE 运行时 WAL 锁） |
| provider 契约 | `packages/kosong/src/provider.ts:220` `ChatProvider.generate(systemPrompt, tools, history, options) → StreamedMessage`，无状态单向流 |
| SDK 托管面 | agent loop / proto 编解码 / 一轮一 tool_call 截断（服务端行为）/ checkpoint 会话，全部由 SDK 处理 |

## 3. 核心架构鸿沟与映射策略

现有 5 个 provider 是**无状态单向流**（每次 generate 带全量 history）；cursor 是**有状态 bidi**（上下文在服务端 checkpointStore，工具结果须回写同一流）。映射策略：

1. **会话桥接**：provider 实例挂 `lastAgentId`。每次 `generate()` 看 history 末尾：
   - 末尾是 tool result → `Agent.resume(lastAgentId)` 回写结果续流；
   - 否则 → `Agent.create({local:{cwd}, model, tools})` 新会话 `send(prompt)`，记录 agentId。
   - 安全前提：host 顺序 loop + 每 agent scope 独立 provider 实例（并行 subagent 不串线）。
2. **工具循环**：Kimi `Tool[]` → SDK `customTools`；工具回调转发 Kimi Code 工具执行路径，同步等结果。L1 先通 bash/read/edit 之一。
3. **鉴权（T1 实测修正）**：`setConnectTransportFactory` **不可用**——主入口未导出且运行时被 webpack 内联（无 transport.js 实体文件，深引不可达）；`apiKey: JWT` 被 cloud REST 拒（"Invalid User API Key"，crsr_ 窄权体系）。**最终方案 = 全局 fetch 双 shim**：①拦截 `POST */auth/exchange_user_api_key` 直接返回 `{accessToken: IDE JWT}`（跳过一次无效 RTT）；②拦截 `GET api.cursor.com/v1/models` 返回合成列表（本地模型校验是客户端行为，仅查 id 存在性）。JWT 经 SDK 原生 interceptor 注入 `authorization`，指纹保持 SDK 原生。
4. **流映射（T1 实测）**：`run.stream()` 事件形态 = `status` / `assistant`(message.content[].text) / `usage`(inputTokens/outputTokens/reasoningTokens) → kosong `StreamedMessage`。`run.wait()` 返回 `{status, result, usage, durationMs}`。
5. **模型 id（T1 实测关键）**：免费号唯一可用 = Auto，**runtime modelId 是 `"default"`**（`auto`/`auto-smart` 只是 alias/displayModelId，run 校验不解析 alias，直接报 "Model name is not valid"）。权威列表可走 `POST api2.cursor.sh/aiserver.v1.AiService/GetUsableModels`（unary，JSON 直连可用）。
6. **进程清理（T1 实测坑）**：`process.exit` 时若 SDK http2 session 未关闭会触发 libuv `UV_HANDLE_CLOSING` assertion。provider 必须妥善处理 `agent.close()` 与生命周期。

## 4. 施工步骤（每步验证后再进下一步）

- **T0 装依赖** ✅：`pnpm --filter @moonshot-ai/kosong add @cursor/sdk@1.0.30` 已装（版本锁死无 `^`；win32-x64 原生平台包随 optionalDependencies 落盘，**无运行时下载**——T1 预判的最大风险排除）。
- **T1 最小连通验证** ✅（2026-08-31 通过，探针 `packages/kosong/spike-cursor.mjs` 临时的，提交前删）：`Agent.create({local:{cwd}, model:{id:'default'}, tools:[]})` + `send("ping")` 全链路出文本 pong + usage。确认：①local executor 纯进程内；②鉴权双 shim 有效；③模型 id 用 `default`。**遗留未验**：customTools 是否受服务端一轮一 tool_call 截断约束（tools:[] 跑的，T4 验收时测）。
- **T2 token 供给层**：`cursor-token.ts`——`node:sqlite` 只读读 token；JWT exp 解析（base64url payload，客户端不验签）；`getToken()`（exp-5min 直用 / 过期刷新 / 单飞锁 / shouldLogout 处理）。**纪律：token/refreshToken 不写日志、不进提交。**
- **T3 auth  shim 模块（替代原 transport 注入）**：`cursor-auth-shim.ts`——幂等安装全局 fetch 包装（只拦 `*/auth/exchange_user_api_key` 与 `api.cursor.com/v1/models` 两个 URL，其余透传原生 fetch）；models 合成列表从 config 的模型映射生成（含 `default`）。记录"已安装"标记防重复包装；**token 只从 token 供给层取，不写日志**。
- **T4 provider 壳**：`providers/cursor.ts` 实现 `ChatProvider`（会话桥接 + 工具映射 + 流映射）。**SDK 必须动态 import**（`createProvider` 的 `case 'cursor'` 内 `await import('@cursor/sdk')`），防止静态 import 让全部用户在 CLI 启动时白付 11MB + 原生包加载成本。
- **T5 接线**：`index.ts` 三处 + config.toml cursor 段（enabled / workspace cwd / model 映射 / token 来源=sqlite|shim 预留）。
- **T6 验收五项**：①免费号流式对话出文本；②工具闭环（≥bash/read/edit 一个，同会话回写、任务完成）；③手工换过期 token 能自动刷新；④其他 provider 不受影响（跑 kosong 现有测试 + 冒烟 openai）；⑤401/429/shouldLogout 错误清晰呈现不静默。

## 4.5 token 供给三层定稿（2026-09-01）

不往 kimi-code 里造 OAuth 子系统；token 获取按上游模式分层，`CursorTokenStore` 接口是唯一接缝：

| 模式 | token 来源 | 我们要写的代码 |
|---|---|---|
| 直连（现在，默认） | IDE SQLite 寄生（`state.vscdb` → `cursorAuth/accessToken`）+ refreshToken 重放官方刷新端点（单飞锁、shouldLogout 停用）——**不是 OAuth，是 50 行重放** | 已完成（T2），不动 |
| 直连（无 IDE 的用户） | `tokenSource = "sdk"`：SDK 自带 `Cursor.auth.login()` 浏览器流程 + `~/.cursor/sdk/auth.json` 托管，刷新/存储全归 SDK；真 crsr_ 系 key 走原生 exchange，**连 auth shim 都不用装** | 一个小 store + 配置选择器（待做） |
| 网关（主航线） | 网关全权管理（账号池/刷新/停用），kimi-code 只持网关 apiKey，无 OAuth 概念 | 零（exchange 放行已实现） |

纪律：给 cursor 做"正式登录体验"时复用 SDK 的 OAuth 机制，**不复刻 packages/oauth**（那是 kimi 官方账号的托管体系）；网关模式下 IDE token 不参与。

### 4.6.1 参数面三问答（2026-09-01 实测）

| 参数 | 结论 | 依据 |
|---|---|---|
| maxOutputToken 透传 | **放弃**。SDK 无独立 maxTokens 字段，唯一机制是 ModelSelection.params，而 `default`(Auto) 无任何 parameters/variants 定义，传了没入口；输出长度服务端自管 | GetUsableModels 实测（206 模型，Auto 条目无参数面） |
| effort | **对 Auto 不存在**（服务端自决）。named 模型的 effort 编码在 **模型 id 后缀**（`-low/-medium/-high/-xhigh` × 可选 `-fast`，部分带 `-thinking-`）| GetUsableModels 全列表形态 + CLI `[effort=high]` 语法 |
| image_in / video_in | **均不生效**：`buildFreshPrompt` 只抽文本，图片 part 被静默丢弃；v2 capability=UNKNOWN 不开放多模态路由；uploadVideo 未实现（明确报不支持）。SDK 层支持图片（`SDKUserMessage.images`），**image 支持是几行的小尾巴，video SDK 侧无对应能力，放弃** | cursor.ts buildFreshPrompt + options.d.ts |

### 4.6.2 named 模型 effort 映射设计（2026-09-01 实测定稿）

**关键实测：参数 id 是 `reasoning`，不是 `effort`。** `effort` 只是 CLI 括号语法的别名；线上参数化模型的 `parameters[].id` 为 `reasoning`，值集 `low / medium / high / extra-high`（`gpt-5.1` 无 extra-high），部分模型另有 `fast`（true/false）参数。带参数化定义的实测有 4 个（`gpt-5.3-codex`、`gpt-5.2`、`composer-2.5`、`gpt-5.1`），9 个带 variants，variant 形如 `gpt-5.2[reasoning=high,fast=true]`。

映射策略（provider `resolveWireModel`）：
1. config 写**基础名**；catalog 条目含 `reasoning` 参数且值集匹配 → 结构化 `{id: 基础名, params: [{id:'reasoning', value}]}`（走 run 请求的 `model_params`）
2. 无参数定义但有**后缀变体** → 解析 `基础名-effort` / `基础名-thinking-effort`
3. 都没有 → 原样用基础名（服务端自决）
4. `xhigh` → `extra-high`（kosong 与 Cursor 词汇对齐）；`off`/`on` 一律不加旋钮
5. 值集不含该 effort 时**回落基础名**，不发送会被拒的值

数据来源：provider 内建 catalog 缓存（5 分钟，单飞），网关模式经网关投影拿池 entitlement，直连模式带 IDE JWT 直打官方。

**验收现状（免费号）**：named 模型一律停在第 1 步之后的 entitlement 拒绝（"Free plans can only use Auto"）——即客户端校验已全通、结构化参数成立，`reasoning` 值集匹配正确（含 extra-high 映射）。真实效果待 Pro 号。

## 5. 风险与纪律

- **ToS 灰色**：指纹与官方 SDK 1:1，禁额外花哨头；仅本机内网自用。
- **免费号额度小**：验收只跑轻任务；记录 429 形态（供 shim 额度展示用）。
- **不做的事**：不改 gemini-shim；不动 tmp 逆向产出（只读）；token 不落日志/提交。
- **SDK public beta**：1.0.30 锁死，升级需回归。
- **上游对齐**：改动收敛在 `providers/cursor.ts` + `index.ts` 三行 + config 接线；不碰 agent-core-v2。

## 6. 索引

- 交接文档：`D:/vscode/sub2api/tmp/ho_cursor_v2_l1.md`
- 立项 Tip：`tip_8192e709-900b-4841-9d21-9fee89956039`（workspace D:/vscode/sub2api/sub2api）
- 逆向情报：`tmp/cursor-sdk-rev/INTELLIGENCE.md`；proto：`extracted/{agent_v1,aiserver_v1}.proto`
- 参考实现：`tmp/Cursor2API/`（bridge 范式）、`tmp/opencode-cursor/`、`tmp/cursor-tap/`（Go proto，L2 备用）
- 网关侧只读参考：`gemini-shim/internal/xai/`（刷新模式）
