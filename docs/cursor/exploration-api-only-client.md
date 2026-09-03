# 探索：能否绕开 `@cursor/sdk` 内置工具运行时，改用纯 API 客户端

> 日期：2026-09-03。动机：N4 实测确认 SDK 内置工具（Shell/Read/Write/Delete…）在本机执行且不经过 engine 权限门，且工具词汇表由服务端 proto 下发（平台可新增，客户端无感知）。需要评估是否存在"纯 API 客户端"形态的替代路径。

## 一、对比：cursor SDK 与另外三家不是同类东西

| | anthropic | google-genai | openai | **cursor** |
|---|---|---|---|---|
| import | `@anthropic-ai/sdk` | `@google/genai` | `openai` | `@cursor/sdk`（动态 import） |
| SDK 性质 | 纯 API 客户端 | 纯 API 客户端 | 纯 API 客户端 | **完整 agent 运行时** |
| 包体积 | 7.0M | 14M | 12M | **25M** |
| 原生 `.node` | 0 | 0 | 0 | 有（平台包内，含 tree-sitter 等） |
| **谁执行工具** | engine | engine | engine | **SDK 自己** |
| 工具来源 | 我们传什么发什么 | 同左 | 同左 | **服务端 proto 下发** |
| 权限门 | engine 全权 | engine 全权 | engine 全权 | **被绕过**（N4 实测） |

**根本区别**：三家 SDK 只做"序列化请求 + 解析响应"，模型返回 `tool_call` 后由 **engine** 执行（走权限门/hooks/yolo 判定）。cursor SDK 内含 agent 运行时，自己实现并执行 Shell/Read/Write/Delete——我们的 `toolExecutor` 从未被调用。

## 二、官方文档里的三条"官方路径"及其适用度

| 路径 | 形态 | 是否适用 |
|:---|:---|:---|
| **TypeScript SDK**（当前用） | 本地 agent 运行时 | ❌ 就是问题本身 |
| **Cloud Agents API** | HTTP `/v1/agents`，在 **Cursor 的 VM** 上跑 | ❌ 不在本机，无法访问本地文件/工具 |
| **SDK Bridge** | 本地 server，**内部仍嵌入 `@cursor/sdk`** | ❌ 同样的运行时，多一层 IPC，更重 |
| **ACP**（`agent acp`） | stdio + JSON-RPC，Cursor 自己做 agent 循环 | 🔶 见下 |

**ACP 的定位**：它是给"客户端"（编辑器/Neovim/Zed）对接用的——客户端发 prompt，Cursor 侧跑完整 agent 循环（含工具执行）。**工具仍由 Cursor 侧执行**，权限通过 `session/request_permission` 询问客户端。

→ ACP **不能**把工具执行权交回 engine，但**提供了权限门**（对比：SDK 的 customTools "无需交互式批准"）。这是 ACP 相对 SDK 的安全优势，却也要接受"工具由对方执行"。

## 三、解包路径的可行性（`StreamUnifiedChat`）

### 已提取的事实

SDK bundle 内存在的 proto 服务（grep `aiserver.v1.*`）：

```
aiserver.v1.StreamUnifiedChatRequest      ← 聊天补全流（IDE 用的就是这个）
aiserver.v1.StreamUnifiedChatRequestWithTools
   字段 1: stream_unified_chat_request
   字段 2: client_side_tool_v2_result   ← 客户端侧工具结果回传
aiserver.v1.AvailableModels               ← 我们已在用（fetchModelCatalog）
aiserver.v1.ConversationMessage / ContextItem / ContextIntent …
```

`StreamUnifiedChatRequest` 的字段（节选）：

```
1  conversation (repeated)         ← 完整会话历史
5  model_details                   ← 模型选择（含 params）
22 is_chat
23 conversation_id
30 full_conversation_headers_only
…（另有 linter_errors / current_file / repository_info / environment_info 等 IDE 上下文字段）
```

**`client_side_tool_v2_result` 的存在是关键**：它说明协议本身支持"服务端请求工具 → 客户端执行 → 回传结果"的模式。这正是三家 provider 的形态（模型要调工具 → 我们执行 → 回传），**意味着协议层并不强制 SDK 自己执行工具**。

### 认证

`cursor-auth-shim.ts:204`：

```ts
function exchangeUserApiKey(state: ShimState): Promise<Response> {
  return resolveToken(state).then((accessToken) => jsonResponse({ accessToken }));
}
```

即 SDK 只是把 **IDE accessToken** 交给后端换取会话凭据，业务请求用 `Bearer {accessToken}`（与 `fetchModelCatalog` 里我们手写的请求一致）。**没有客户端证书、没有请求签名、没有 obfuscated checksum**（未见此类字段）。

→ **认证不绑定 SDK 实现，可独立复现。**

### 结论：技术上可行，但代价高

**可行的部分**：
- 认证是简单 Bearer token；
- 协议是 protobuf over HTTP/2（Connect），proto 定义可从 bundle 提取（`StreamUnifiedChatRequest` 等）；
- 工具回传有专门的字段，协议支持"我们执行"；
- 我们已有先例：`fetchModelCatalog` 就是**手写 fetch 调 `AvailableModels`**（没走 SDK），证明这条路走得通。

**代价与风险**：

| 风险 | 说明 |
|:---|:---|
| **协议无文档、无兼容承诺** | proto 从 bundle 提取，字段号/语义随时可变；官方不保证稳定 |
| **proto 体量巨大** | 仅 `StreamUnifiedChatRequest` 就有数十字段，含 IDE 专有上下文（linter、repo、environment），需挑出必需子集 |
| **指纹/反作弊** | IDE 客户端有特定 header 组合（`x-cursor-client-version` 等）与请求序列，自实现可能被识别为异常客户端 |
| **功能倒退** | 上下文压缩（`preCompact`）、rules/skills 加载、workspace 解析——这些目前由 SDK 提供，自实现要全部重建 |
| **维护成本** | cursor 更新协议就要跟着逆向，无 changelog 可依 |
| **授权/合规** | SDK 许可证为 `SEE LICENSE IN LICENSE.md`（非标准开源），解包复用协议可能违反条款 |

**规模估计**：从零实现一个可用的 `StreamUnifiedChat` 客户端（含流式解析、工具回传、错误处理、多模态），保守估计数百小时；且要持续跟进协议变更。

## 四、建议

**不推荐全量自研协议客户端**，性价比过低且不可持续。优先级排序：

1. **短期（3 行代码）**：`tools: ["mcp"]` 白名单 + `disallowedTools: ["task"]`，把内置工具与 subagent 派生关掉。官方原生支持、默认拒绝模型、传错名直接抛错。**已作为备用方案记录**。
2. **中期（若需更强隔离）**：叠加 `sandboxOptions: { enabled: true }`；或评估改用 **ACP**（`agent acp`）路径——工具仍由对方执行，但有 `session/request_permission` 权限门，且是官方支持的宿主协议。
3. **长期（仅当上述均不可接受）**：才考虑自研 `StreamUnifiedChat` 客户端。建议先做**可行性探针**（用提取的 proto 发一次请求，确认能被接受再投入），不要直接全量实现。

## 五、与既有记录的关系

- N4 安全漏洞的确证与处置：见 `verification-log.md`「第二轮结果」。
- `tools`/`disallowedTools` 的官方依据：见 `official/hooks-and-changelog.md` §2（1.0.27 changelog）与 `official/sdk-typescript.md`。
- ACP 路径的完整评估：见 `official/acp.md`。
