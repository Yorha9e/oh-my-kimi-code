# 评估：自建 cursor 纯 API 客户端（替代 `@cursor/sdk` 内置工具运行时）

> 日期：2026-09-03。结论先行：**可行，且基础设施已全部就绪**。与网关侧（gemini-shim）已完成两轮 handoff 交叉验证，关键事实均有实证。
> 配套：`verification-log.md`（N4 实测）、`exploration-api-only-client.md`（初版评估，部分结论被本轮修正）、网关 `docs/cursor-run-stream.md`。

## 一、动机（不变）

N4 实测确认：`@cursor/sdk` 的内置工具（Shell/Read/Write/Delete/Grep/Glob/Task/WebSearch/WebFetch…）在**本机执行**、不经过 engine 权限门（我们的 `toolExecutor` 从未被触发），且工具词汇表由服务端 proto 下发（平台可新增，客户端无感知）。

**网关侧独立实证（122 份 dump 全量扫描）**：在 `1788437846659-…-up.bin` frame #44 解出明文 tool-call：

```json
{"type":"tool-call","toolCallId":"call-e0b17456-…","toolName":"Read",
 "args":{"path":"C:/Users/Yorha/.kimi-code/config.toml", …}}
```

服务端经流直接下发工具名 + 完整参数，客户端侧直接执行——与我们的 N4 判断完全一致。

## 二、可行性：四项关键前提全部被实证

| 前提 | 结论 | 证据 |
|:---|:---|:---|
| **协议结构** | ✅ 完全已知 | 网关 `docs/cursor-run-stream.md` + `decode_cursor_stream.py` + 122 份 dump；我们本地解码成功 |
| **JSON 编码** | ✅ **bidi 本来就是 JSON** | 网关 `cursor_proxy.go:98` 对 Run 流下游直接设 `Content-Type: application/json`，生产一直跑。连帧内 payload 都是明文 JSON（frame #44） |
| **TLS 指纹** | ✅ **不存在问题** | `fingerprint-cursor.md:153`："SDK 与 CLI 同为 Node 实现（connect-es/1.6.1），TLS 指纹同源"。464 拒绝是 Go/curl 指纹问题，与 Node 无关 |
| **认证** | ✅ 简单 Bearer | IDE accessToken，无签名/证书/checksum；我们的 `fetchModelCatalog` 手写 fetch 已验证 |

### 初版评估的三个顾虑全部被推翻

| 初版顾虑（exploration-api-only-client.md） | 修正 |
|:---|:---|
| 需逆向二进制 protobuf | ❌ 不需要——bidi 走 JSON，payload 明文 |
| 无文档无样本 | ❌ 有解码文档 + 122 份真实样本 + 解码器 |
| Node 指纹风险 | ❌ 不存在——官方 SDK 就是 Node 实现 |

## 三、协议核心结构（已验证）

### 帧格式

Connect bidi envelope：`1B flags + 4B BE length + payload`。flags bit0=gzip，bit1=EOS（JSON trailers，含错误）。

### client → server（`AgentClientMessage` oneof 8 case）

| no | case | 用途 |
|----|------|------|
| 1 | run_request | **首帧，内嵌全量会话历史**（实测 165KB+） |
| 2 | exec_client_message | 工具结果回传（实测单帧 432KB） |
| 4 | conversation_action | user_message / resume / cancel / summarize 等 15 种 |
| 6 | interaction_response | 应答服务端提问/许可 |
| 7 | client_heartbeat | 心跳 |

### server → client（`AgentServerMessage` oneof 8 case）

| no | case | 用途 |
|----|------|------|
| 1 | interaction_update | **主内容**（25 种 case：text_delta / tool_call_* / thinking_delta / turn_ended 等） |
| 2 | exec_server_message | 工具调用请求 |
| 3 | conversation_checkpoint_update | 全量快照（gzip） |
| 7 | interaction_query | **提问/许可（14 种）——样本零出现** |

### 工具循环（帧级已验证）

```
server → client: exec_server_message（工具调用，语义内容在 InteractionUpdate 的
                 partial_tool_call(7)/tool_call_started(2)/completed(3)，明文 JSON）
client → server: exec_client_message（结果回传，实测单次往返）
```

实测样本：4 份含工具调用（推荐先看 `1788437846659-…` frame #44），11 份完整往返（最短 1.4KB：`1788410014094-c9d1cadb-…`）。

### run_request 首帧（实测最小集）

```
2  action = user_message_action
9  requested_model = {id:'default'}     （或具名+params：{id:'composer-2.5'}, param(fast=true)）
25 run_id
+  1 conversation_state（全量历史）
```

字段全集还有：5 conversation_id / 8 custom_system_prompt / 13 harness / 16 conversation_group_id / 18 dev_raw_model_slug / 26 agent_session_id / 28 client_supports_routed_model_update / **29 system_prompt_spec** / 30 client_llm_gateway_credential。

## 四、开放问题（网关侧明确标注"没有数据"）

| 问题 | 状态 | 影响 |
|:---|:---|:---|
| `interaction_query` 14 种 case 明细 | **无数据**（122 份 dump 零命中） | 权限门在 Run 通道的具体形态未知；但我们自建后**工具执行本来就在我们手里**，此问题降级 |
| `conversation_state` 能否增量 | 未测（观测均为全量） | 影响每帧体积；全量模式已实证可用 |
| `system_prompt_spec`(29) 是否每轮注入入口 | 未验证 | **若可用则同时解决 S1**（每轮 fresh system prompt） |
| `model_details`(3) vs `requested_model`(9) 分工 | 未实验 | 低优先 |
| `exec_*` 内部字段号 | 解码器只到 message 层 | 自建时需下沉解析（网关可固化 frame #44 解码） |
| 批量工具往返 | 未测（样本均 1-2 次调用） | 低优先 |

## 五、错误形态（实测，必须处理）

1. **限额错误走流内 EOS trailer**：HTTP 200 + heartbeat 后，trailer 返回 `resource_exhausted / ERROR_RATE_LIMITED_CHANGEABLE / "You've hit your usage limit"`（`isRetryable:false`）。HTTP 状态码看不见——自建客户端必须解析 EOS trailer。
2. **上游会把限额伪装成版本过旧**：`ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT` 的文案是 "Your version of Cursor is no longer supported"。错误分类不能只看表面文案，要看 `debug.error` 代码。
3. 畸形帧错误形态：`internal / parse binary: illegal tag: field no 0 wire type 1`（编码错误的服务端反馈）。

## 六、架构决策：自建客户端 + 走网关

```
kimi-code engine（权限门/hooks/yolo 全部生效）
    ↓ 自建客户端（Node fetch/undici，JSON 编码）
omkc 网关 127.0.0.1:51443（TLS 指纹已解决 + 账号池 + tap 观测）
    ↓ utls
cursor 上游 api2.cursor.sh
```

- **不再引入 `@cursor/sdk`** → 无内置工具运行时、无服务端下发工具、无 checkpoint sqlite；
- 工具循环：服务端 `exec_server_message` → **engine 权限门判定 → 我们执行** → `exec_client_message` 回传。与 anthropic/openai/google 三家 provider 同构；
- `@cursor/sdk` 降级为**可选依赖**（或直接移除）。

## 七、风险与待办

| 风险/待办 | 说明 |
|:---|:---|
| `exec_*` 内部字段解析 | 需下沉解码器到工具调用字段级（网关提出可固化 frame #44 解码） |
| system_prompt_spec 验证 | 一次真机实验（构造带 29 号字段的 run_request，看是否生效） |
| conversation_state 增量验证 | 同上（一次实验） |
| 协议漂移 | cursor 改协议需跟进；缓解：走网关后由网关侧 tap 观测率先发现 |
| 许可证 | 用户已明确：自用、号非原价、不管 |
| `tools:["mcp"]` 白名单 | **降级为备用方案**保留（若自建路线受阻，仍可回到 SDK+白名单） |

## 八、建议的实施顺序

1. **探针（1 次实验）**：用最小首帧（action + requested_model + run_id + 简单 conversation_state）经网关发一次 Run，验证能建立流并收到 text_delta —— 证伪或证实；
2. 下沉 `exec_*` 字段解析（可与网关协作）；
3. 实现 `StreamChat`-式客户端骨架（Node，JSON bidi）；
4. 接入 kosong `ChatProvider` 接口（与三家同构：generate → 流 → tool_call 交 engine → 回传）；
5. `system_prompt_spec` / 增量 conversation_state 实验；
6. SDK 移除决策（视 1-5 结果）。
