# Cursor Provider 接线文档

社区版独家增量（官方 MoonshotAI/kimi-code 无 cursor 适配）。存放 cursor provider（`packages/kosong/src/providers/cursor.ts`）与 engine 嵌合相关的内部工程文档。

> 内部工程文档，不进 VitePress（`docs/en|zh`），不做中英同步。

## official/ — 官方权威依据

**接线实现的唯一依据。凡有官方出处的结论，一律以此目录为准，不自创解法。**

| 文档 | 内容 |
|---|---|
| [model-parameters](official/model-parameters.md) | **参数体系权威解码**：`ModelListItem` 结构、参数 id 全集（effort/reasoning/thinking/fast/context/optimize_for）、方括号语法 `model[k=v]`、官方三条最佳实践与按能力解析范式、回退链 |
| [sdk-typescript](official/sdk-typescript.md) | SDK 文档 8 组结论：usage 语义（流事件 per-turn）、跨进程 resume、`local.store` 可注入、customTools 权限边界、`reload()`、配置优先级、`run.conversation()` |
| [acp](official/acp.md) | `agent acp` 原生 ACP server（stdio + JSON-RPC）：会话/模式/权限、Cursor 扩展方法（`cursor/task` 的 agentId 恢复、`ask_question`、`create_plan`）、多 harness 对接面 |
| [subagents-and-bridge](official/subagents-and-bridge.md) | subagent frontmatter 字段与生命周期（agent ID 恢复、嵌套两层限制、上下文隔离）、模型参数方括号语法、SDK Bridge 定位（我们不需要） |
| [hooks-and-changelog](official/hooks-and-changelog.md) | `preCompact` 完整输入定义（证伪"SDK 无压缩"）、hook 全集、SDK changelog 版本能力边界（1.0.22~1.0.27） |

原始素材：官方 `llms.txt` 索引的全部 243 篇 `.md` 原文（2.9MB，2026-09-03 经代理拉取于 `/tmp/cursor_md/`）。

## 自研分析

| 文档 | 内容 |
|---|---|
| [engine-integration-audit](engine-integration-audit.md) | 嵌合审查清单：P0/P1/P2 打磨项 + S1–S8 嵌合面接缝（随接线推进持续更新） |
| [proto-schema-map](proto-schema-map.md) | **自建客户端字段权威依据**：AgentClientMessage/AgentRunRequest/RequestedModel/ConversationStateStructure 完整字段 + exec 通道 42 种工具 args/result + 错误形态汇总（SDK bundle 官方生成代码提取，探针实测验证） |
| [exploration-api-client-feasibility](exploration-api-client-feasibility.md) | 自建纯 API 客户端可行性评估（四项前提实证 + 与网关两轮 handoff 交叉验证） |
| [exploration-rules-injection](exploration-rules-injection.md) | S1 规则文件注入方向探索（可行但侵入用户仓库） |
| [verification-log](verification-log.md) | 真机验证记录：探针①②③全部通过（协议→oneof→权威首帧） |
| [stateless-contract-mismatch](stateless-contract-mismatch.md) | engine 无状态契约 vs cursor 有状态会话的错配分析、「全量重建窗口」方案、官方 SDK 文档 14 项定性结论 |

## 约定

- 结论优先引官方出处；官方无覆盖的，在此明确标注为自研推断，便于后续向上游反馈时区分。
- 社区版跑通后，整理的 PR/issue 反馈上游 MoonshotAI/kimi-code（官方无 cursor 适配，全量自研）。
