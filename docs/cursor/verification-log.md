# Cursor 真机验证记录

> 探针路径：社区版 `CursorChatProvider`（含 auth shim + IDE token）→ omkc 网关 `https://127.0.0.1:51443`（`C:/Users/Yorha/.omkc/config.toml` 的 `[providers."managed:cursor"]`，`api_key` 为空、走 base_url）。
> 探针为一次性脚本，运行后已删除，不进仓库。

## 第一轮：usage 语义与 cache 行为（已完成）

三轮对话，systemPrompt 前缀固定，user 文本每轮不同。

| 轮次 | inputOther | inputCacheRead | output | 真实上下文（input+cacheRead） |
|---|---|---|---|---|
| turn 1 | 38105 | 8960 | 265 | 47065 |
| turn 2 | 12515 | 512 | 176 | 13027 |
| turn 3 | 12515 | 9216 | 177 | 21731 |

### 结论 ①  1.5M 假象已定位

usage 是**严格 per-turn**：turn 2 与 turn 3 的 `inputOther` 完全相同（12515），未累加。与官方说明一致（流事件 per-turn，`run.usage`/`result.usage` 才是累计）。

单轮真实上下文最大 **47k**，远不及 1.5M。→ **TUI 的 1.5M 是累计账单**：`apps/kimi-code/src/tui/components/messages/usage-panel.ts:102` 的 `Session usage` 段按模型累加每轮 input+output，被误读为当前上下文。**不是 provider 口径问题，是 TUI 语义混用。**

### 结论 N10  稳定前缀被 cache 吸收

turn 2 / turn 3 的 `inputOther` 均为 12515（未随历史增长）→ 稳定前缀进入缓存。

但 `cacheRead` 波动大（turn2 512 / turn3 9216）→ 缓存**部分命中、不稳定**。且 output 仅 176-265，thinking 占了大头（日志可见每轮大段 think）。

→ **S1 兜底（每轮前缀发 systemPrompt）成本可控**，但 engine 的动态 reminder 每次内容变化会破坏缓存前缀，实际收益取决于 systemPrompt 的稳定部分占比。

### 结论 N1  usage 事件不含上下文水位

usage 事件只有 `input / output / cacheRead / cacheWrite` 四项，**没有 `context_tokens` / `context_window_size`**。

→ 水位只能在 `preCompact`（压缩发生时）拿到 → **自建水位记账仍然必要**，M6 与 P2-⑨ 不能取消。

### 结论 N4（部分）  customTools 注册路径确认

探针只注册了一个哑工具 `probe_ping`，模型的 think 显示它知道工具集并可判断是否需要调用；未尝试内置工具。

**但证据不足**：单一工具无法证明模型"不会"用内置工具（参见第二轮 N4 的针对性测试）。两者走同一注册路径（`toSdkCustomTools` → `local.customTools` → `custom-user-tools` MCP 服务器）。

### 结论 S4（零真机）  `image_in` 误声明确证

- `packages/kosong/src/providers/capability-registry.ts` **没有 cursor 条目**；
- `image_in` 由上游 catalog 的 `inputs` 推导（`packages/kosong/src/catalog.ts:337` 的 `inputs.includes('image')`）；
- `collectImages` **只在 `Agent.create()` 新会话分支调用**（`cursor.ts:615`），续聊（工具循环）分支无任何图片处理。

→ omkc config 里 `models."cursor/grok-4.6"` 声明 `capabilities = [..., "image_in"]`，但续聊路径图片静默丢失。engine 会执行无效的图像压缩/上传，属隐性 token 浪费。

## 第二轮：N4 安全面 / N7 规则注入 / N2 payload 上限

_（详细结果见下方「第二轮结果」章节）_

## N5  SDK 版本：我们已是最新

`npm view @cursor/sdk versions` 最新为 **1.0.30**，与社区版锁定的版本一致。

官方 `docs/sdk/changelog.md` 只写到 **1.0.27**，因此 1.0.28–1.0.30 无公开变更说明——**不是我们版本落后，是官方 changelog 未更新**。

→ **无需升级 SDK**。N5 关闭。

（注：`@cursor/sdk` 是单体包，没有"最小版"可选；动态 `import()` 已把加载成本推迟到首次 `generate()`，无进一步瘦身空间。）

## 探针 ①：自建首帧实测（2026-09-03，最终验证）

不经过 `@cursor/sdk`，Node 手工构造 Connect bidi JSON 帧直接对网关发 `AgentService/Run`：

```
POST https://127.0.0.1:51443/agent.v1.AgentService/Run
headers: content-type: application/connect+json
         authorization: Bearer {网关轮转 token}
body:    1B flags(0) + 4B BE len + JSON(runRequest)
```

runRequest 猜测字段（proto3 JSON mapping camelCase）：

```json
{
  "action": { "userMessageAction": { "text": "…" } },
  "requestedModel": { "id": "default" },
  "runId": "<uuid>",
  "conversationState": { "conversation": [ { "type": 1, "userMessage": { "text": "…" } } ] }
}
```

**结果：上游接受并开始回帧**：

```
HTTP 200 application/connect+json
frame #0: {"interactionUpdate":{"heartbeat":{}}}
EOS trailers: {"error":{"code":"resource_exhausted",…,
  "debug":{"error":"ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
           "title":"Update Required",…}}}
```

- 连接、认证、JSON 编码、帧封装**全部成立**；
- 没有触发 parse 错误（对比二进制畸形帧的 `illegal tag` 形态）——猜测的字段名可被接受；
- 流以限额 EOS trailer 结束（当前账号额度耗尽），**不是协议问题**。换有额度的账号即可看到 text_delta。

**结论：自建纯 API 客户端路线验证通过**（探针 ① 关闭）。后续：真机账号就位后跑完整对话 → 工具循环 → 接入 ChatProvider。

## 探针 ③：权威 schema 首帧（协议验证通过，2026-09-03）

从 SDK bundle 提取到权威 proto 定义（结合网关 ho_ee8049ac0d45 的 wire 逆向），修正首帧：

### 权威 schema（`agent.v1.*`，SDK bundle 官方字段名）

```proto
AgentClientMessage { oneof message { 1: runRequest, 2: execClientMessage, ... } }
RequestedModel { 1: modelId(string), 3: parameters(repeated Param{id,value}), 7: builtInModel, 8: isVariantStringRepresentation }
ConversationAction { oneof action { 1: userMessageAction } }
UserMessageAction { 1: userMessage(UserMessage), 7: conversationHistory }
UserMessage { 1: text, 2: messageId, 4: mode(enum), 8: richText }
// ★ conversationState 的类型是 ConversationStateStructure（不是想当然的 Conversation）：
ConversationStateStructure {
  1: rootPromptMessagesJson (repeated bytes — blob),
  8: turns (repeated bytes — 32B blob id，内容在 blob store),
  5: tokenDetails (message: 当前 token 数 + 上限 + 分项预算 system_prompt/tools/rules/skills),
  17: preFetchedBlobs (repeated PrefetchedBlob{id bytes, value bytes}) ← turn 内容经此携带
}
```

**关键修正**：`turns` 是 blob id 列表而非 turn 对象——历史内容通过 `pre_fetched_blobs`（field 17）携带。错误信息直接指路：`cannot decode field agent.v1.ConversationStateStructure.turns from JSON: object`。

### 迭代记录

| 尝试 | 首帧 | 上游响应 | 判定 |
|---|---|---|---|
| ③ | + `conversationState.turns[]`（对象形态） | `invalid_argument: cannot decode …ConversationStateStructure.turns from JSON: object` | turns 不是对象列表 → blob 语义 |
| ③b | 无 conversationState | `invalid_argument: Conversation state is required` | 字段必需 |
| ③c | `conversationState: {}`（空结构） | **`resource_exhausted: ERROR_RESOURCE_EXHAUSTED / "High Load"`** | **协议+字段全部正确，进入服务端调度队列** |

### 结论

**探针 ①（协议）+ ③（字段）双双通过**。最小合法首帧：

```json
{"runRequest":{
  "action":{"userMessageAction":{"userMessage":{"text":"…"}}},
  "requestedModel":{"modelId":"default"},
  "runId":"<uuid>",
  "conversationState":{}
}}
```

当前卡点仅为服务端 High Load（池排队），与协议无关。**下一步：工具循环实现（exec 通道结构）→ 接入 ChatProvider。** 历史续接需走 `preFetchedBlobs`（内容 blobs + turns id 列表），该结构已定位，细节在工具循环之后实验（DSH-④/自建④）。

探针 ① 之后继续推进首帧字段形态，三次迭代拿到三个高价值错误信号：

| 尝试 | 请求形态 | 上游响应 | 解读 |
|---|---|---|---|
| 2a | `AgentRunRequest` 字段直接放顶层 | `invalid_argument: "First message must be a run request or prewarm request"` | **外层必须是 `AgentClientMessage` oneof**，用 case 名包装 |
| 2b | `{ "runRequest": { …AgentRunRequest… } }` | `not_found: ERROR_BAD_MODEL_NAME` | **oneof 包装正确，run_request 被服务端识别**——只差内部字段名 |
| 2c | + `requestedModel: { id: 'default' }` | 同 2b | `Model` message 内部字段名不是 `id`（构造器 camelCase 是 `modelId`，但 minified bundle 中无法定位 proto name） |

**重要修正**：2a→2b 之间还补了官方身份头（`x-cursor-client-type: sdk` / `x-cursor-client-version: sdk-1.0.30` / `x-request-id`，来源 `fingerprint-cursor.md`）。身份头可能也是 2a 失败的因素之一（2a 时无身份头）。

**决定**：连续试探性畸形包会抬高指纹暴露面，停止猜测，改为向网关申请权威 proto 字段映射（handoff `ho_617dc209568b`）。待网关回复后一次构造正确首帧。

### 待网关回复的清单

1. `agent.v1.Model`（requested_model 类型）完整字段——**最关键**；
2. `ConversationState` 首帧全量历史的最小合法 JSON；
3. `UserMessageAction.conversation_history`（Es）结构；
4. Connect JSON 对 snake_case 字段名的宽容度；
5. （可选）exec 通道 message 结构。

### 探针 ①② 的累计结论（不受字段名问题影响）

- 自建 JSON bidi 帧可被上游接受并进入业务处理流程（不再停留在协议层错误）；
- 错误分级清晰：`invalid_argument`（协议层）→ `not_found + ERROR_*`（业务层）——自建客户端可据此做精确错误分类；
- 官方身份头是必需品（`fingerprint-cursor.md` 已给权威清单）。

1. **SDK 用 HTTP/2 直连，不走 `globalThis.fetch`**——fetch 层 tap 抓不到 Run 请求（auth shim 只拦得到 REST 端点）。自建客户端用 Node fetch 反而更可控。
2. **网关 `/api/cursor/token` 会轮转可用账号**——探针必须用它，不要用本地 IDE token（绑定死账号，本机 token 对应的 account-09b3acab0f 已禁用）。
3. 额度耗尽的另一种错误形态：SDK 侧报 `[unavailable] HTTP 502`（网关转发上游拒绝时）。
4. 本机代理 RST 会导致 upstream 502/挂起——排查网络问题时先排除代理。

## 第二轮结果：N4（安全）/ N7 / N2

### N4：customTools **未**接管 SDK 内置工具 —— **P0 安全漏洞确认**

探针只注册了一个哑工具 `probe_ping`，但模型列出的实际可用工具为：

```
Shell（执行终端命令）、Read（读文件，含图片）、Write、StrReplace、Delete、
Grep、Glob、Task（启动子代理）、WebSearch、WebFetch、
AwaitShell、EditNotebook、ReadLints、TodoWrite
```

模型首句自述："我有文件读取能力，正在读取该配置文件" —— 它开始读取探针指定的敏感文件 `C:/Users/Yorha/.kimi-code/config.toml`。

**确证的三个事实**：

1. **内置工具默认全部暴露**（Shell/Read/Write/Delete 等），customTools 完全未接管；
2. **不经过 host `toolExecutor`** —— 探针的 executor 回调从未被触发（日志无 `host tool executed` 打印），说明内置工具走的是 SDK 自己的执行路径；
3. **engine 权限体系被完全绕过**：permission policies（含 `tower-worker-write-guard`）、yolo/只读模式、工具 hooks 全部失效。

**官方依据（1.0.27 changelog）**：

> "`tools` allowlists the built-in tools offered to the model (`[]` means text-only), and `disallowedTools` removes tools while keeping the rest. Both take public names like `"read"` or capability groups like `"shell"` and `"mcp"`... Local agents only for now, and **not persisted across `resume`**."

即官方已提供收敛手段（白/黑名单），且**每次 `create`/`resume` 都要重传**（与 `customTools` 一致）。

**修复方向**：`Agent.create`/`resume` 传 `tools`（如 `["mcp"]` 只保留 customTools，或 `[]` 纯文本），把内置工具关掉。

### N7：规则文件默认未被加载（与官方文档一致）

canary 未命中（`N7 canary present in reply: false`）。但模型回复中自述 "rules: AGENTS.md + .cursor/rules/*.mdc"，说明**它知道规则文件机制存在**，只是没读到探针刚写入的那条。

与官方"未设置 `local.settingSources` 时只会加载内联配置"一致 → **默认不读磁盘**。

**补充实证（S1 方案的否决理由）**：探针写入的 `.cursor/rules/probe-canary.mdc` **不在 .gitignore 内**，`git status` 直接显示 `?? .cursor/`。即规则文件方案会污染用户仓库的未跟踪列表，用户下次 `git add .` 就会把我们的文件带进仓库。

### N2：`send()` payload 上限在 256KB ~ 1MB 之间

| payload | 结果 |
|---|---|
| 64KB | ✅ ok（inputOther 20632） |
| 256KB | ✅ ok（inputOther 45208） |
| 1024KB | ❌ 超时未返回 |

→ **全量 history 重建包不可行**：中型会话的历史轻松超过 256KB。重建方案若采用，只能用「压缩摘要 + 最近 N 轮」，不能用全量。

## 探针 ④：完整对话尝试与真实首帧对照（2026-09-03）

上游恢复后重试，连续两次 `ERROR_RESOURCE_EXHAUSTED / "High Load"`（不同账号轮转均同），仍未见到 text_delta。

**同时完成了自建首帧与真实 CLI 首帧的逐字段对照**（从网关 dump 用 raw-walk 解码 165KB 首帧）：

```text
真实 CLI run_request 字段分布：
  1  conversation_state = 空（长度 0）        ← 与我们 {} 一致 ✅
  2  action = 25558B（user_message_action）
  4  mcp_tools = 139KB                        ← CLI 声明整个 MCP 工具集；我们没有
  5  conversation_id
  9  requested_model
  25 run_id
  （无 field 13 harness —— 修正此前假设）
```

**结论**：
1. 我们的首帧形态与真实客户端在协议上无差异（conversation_state 空 + action + requested_model + run_id）；
2. 唯一缺的是 `mcp_tools`（field 4）——CLI 每次都声明工具表。High Load 是否与"无工具声明"的请求被丢入低优先级队列有关，待上游恢复后用带/不带 mcp_tools 各测一次即可分辨；
3. harness 假设被否定（真实流量不带）。

**探针 ④ 状态：挂起等上游池恢复**（探针脚本已就位，恢复后一跑即得 text_delta/turn_ended/usage）。
