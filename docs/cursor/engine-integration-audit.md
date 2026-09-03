# Cursor Provider ↔ Engine 嵌合审查清单

> 记录 cursor provider（`packages/kosong/src/providers/cursor.ts`）与 engine（agent-core / agent-core-v2 / acp-server）之间的所有已知嵌合问题与打磨方向。随调研持续更新。

## 背景（已验证事实）

- TUI 右下角 1.5M 是统计假象：真实上下文 ~85k → 压缩后 60k。
- SDK 用量源头是服务端 per-turn 账本 `agent.v1.TurnEndedUpdate`（input/output/cache_read/cache_write/reasoning_tokens）。
- 单轮真实上下文 = input + cache_read + cache_write；engine `step.end` 用 `totalUsage` 覆盖 `_tokenCount`（`agent-core/src/agent/context/index.ts:684-694`），该逻辑假设"usage = 本轮完整输入"，对 cursor 是否成立待真机验证。
- TUI `Context window` 的 size 来自 config 模型声明（`agent-core/src/agent/config/index.ts:259` `modelCapabilities.max_context_tokens`），与 cursor catalog 的真实窗口（`contextTokenLimit`）脱节。
- 官方 MoonshotAI/kimi-code 无 cursor 适配（upstream/main 的 providers 只有 anthropic/google-genai/kimi/openai）；cursor wire 是社区版独家。

## P0 正确性

1. **usage 口径**：真机日志验证 SDK stream usage 是 per-turn 还是 cumulative → 修 `mapUsage`（cursor.ts:384）/`step.end` 口径 + provider 维护会话真实上下文水位。
2. **压缩联动**：engine `fullCompaction` 压缩自己的 transcript，SDK `conversation_state` 未动 → fullCompaction 完成 → provider 重开 SDK 会话 + 摘要注入首条消息；压缩后的真实上下文回落需与 SDK 侧同步（engine `applyCompaction` 已把 `_tokenCount` 回落为 `result.tokensAfter`，SDK 侧不回落则下一轮 usage 又跳回）。
3. **_lastAgentId 生命周期**：实例内存态；跨进程 resume 是否可用未验证；toolResults 有但无 agentId 时降级为"塞进新会话"（语义坑：工具结果上下文不存在）。
4. **agent 容器管理**：正常流结束从不 `agent.close()`（仅错误/abort 路径），SDK sqlite 孤儿 agent 持续堆叠；`Agent.list/get/archive/delete/getUsage` 全部未用；子 agent 完成时应 close + 清理旧会话。

## P1 体验

5. **fast/effort 解析 + TUI 开关**：`resolveWireModel` 已处理 effort/reasoning/thinking；`fast` 后缀维度未解析；TUI 动态切换模型 ctx 字段（如 effort/context 参数）——ctx 语义待定，属 TUI 层，不急。
6. **错误链路**：401/429/shouldLogout 分类映射 auth_required/quota。

## P2 结构性

7. **并发语义**：`pinBackendUrl` process-global 冲突（直连+网关不可混用，已知限制）；多 subagent 并行共用同一 provider 配置的实例隔离验证。
8. **工具循环**：`trailingToolResults` 只摘尾部连续工具结果，非尾部断链场景兜底。
9. **上下文兜底**：真实上下文接近模型窗口 → 自动重开会话（依赖 ① 的水位读数）。

## S 系列：嵌合面新发现

- **S1 system prompt 只在首轮生效**：`buildFreshPrompt` 把 systemPrompt 拼进首条 user 消息；续聊（工具循环/压缩重开）无 system prompt 注入；engine 动态约束（system-reminder/plan/goal）对 cursor 会话不持续；重开时 systemPrompt 混入 user 文本累积。
- **S2 多模态丢包**：image/audio/video 直接丢弃（新会话图片有 `collectImages` 支持，续聊无）。
- **S3 真实窗口未接入**：catalog `contextTokenLimit` 未进 `maxContextSize`，TUI size 失真；`fetchModelCatalog` 顺手可带。
- **S4 能力声明一致性**：`capability-registry` 对 cursor 的声明（thinking/vision/max_input_tokens）与实际能力（无多模态、effort 参数化）不一致，engine 会按错误能力行事。
- **S5 session↔agentId 无持久映射**：同 cwd 多会话交错；engine 会话恢复找不到自己的 SDK agent；P0-③ 连带做。
- **S6 SDK 本地 executor 能力边界（安全）**：未验证 customTools 是否完全接管 SDK local agent 内置工具（bash/read）；潜在自动执行/权限泄漏面。
- **S7 prompt 格式适配**：engine 的 XML 提示体系（`<system-reminder>`、工具结果格式）对 cursor 模型的适配性；`serializeToolResults` 是自造格式。
- **S8 双层重试（额度敏感）**：engine 侧重试 × SDK 内部重试未验证；Team 双池每次交互计 1 次，双层重试直接放大请求。

## 内存/验证约束

- 不轻易发真机模型请求（Team 双池 min($80, 2000次)，每次交互计 1）。
- 零 token 验证用 stub catalog / `resolveWireModel`。
- repo AGENTS.md：agent-core-v2/kap-server/transcript 注释禁区；不新建测试文件；提交不带 co-author。

## 调研：三家无状态 provider 的 engine 接线模式（对比基准）

| 维度 | anthropic.ts | google-genai.ts | openai-responses.ts | cursor.ts |
|---|---|---|---|---|
| system prompt | 每轮传完整 `system`（带 cache_control） | 每轮传 `systemInstruction` | 每轮传 `instructions` | **只在新会话首条**拼进 user 文本（`buildFreshPrompt`），续聊不携带 |
| history | 每轮全量转换发送（merge 连续 user） | 每轮全量 `contents` | 每轮全量 `input`（`store:false`） | **增量**：尾部工具结果 / 最新 user；全量在 SDK conversation_state |
| 会话状态 | 无状态 | 无状态 | 无状态 | **有状态**（SDK agent + sqlite checkpoint） |
| usage | API per-request 透传 | 同上 | 同上 | SDK usage 事件透传（per-turn/cumulative 待验证） |
| 工具 id/合并 | `normalizeToolCallIdsForProvider` + merge helper | 同左 | 同左 | 自己的 serializeToolResults + toolNameLookup |

**核心结论**：engine 隐式假设 provider 是"无状态 + 每轮全量"（每轮传入新鲜 systemPrompt 与完整 history，期待如实转发）。cursor 是唯一天然违背该假设的 wire，造成三个错配：

1. **system prompt 失忆（S1 升级为已确认）**：engine 每轮都传新鲜 systemPrompt（含动态 reminder/plan/goal），cursor 只消费首轮 → 动态上下文对模型持续失效，且重开会话时 systemPrompt 混进 user 文本累积。
2. **engine 历史对上游无感（P0-② 根源）**：engine 每轮把完整 history 当"要发的上下文"传入，cursor 只摘尾部 → 压缩/注入/回滚在 SDK 侧全部无感。
3. **重试语义差异（S8）**：无状态 provider 重试 = 重发全量（幂等）；cursor resume 续聊有顺序依赖，engine 层重试进入 cursor 时行为不同。

**可借鉴方向**：引入"全量重建窗口"策略——在关键事件（压缩完成、动态注入、plan 模式切换、重试边界）用 engine 全量 history 重建 SDK 会话（新 agent + 首条携带完整上下文），中间轮次继续走增量续聊。同时保留既有增量效率。此为 P0-② 的完整形态（含 system prompt 重新注入）。

## 开放问题

- TUI ctx 切换中"ctx"的语义（effort / 上下文预算 / 窗口档位）待用户确认。
- SDK stream usage 事件 per-turn vs cumulative 待真机日志定性。
- `agent.resume` 跨进程可用性待验证。