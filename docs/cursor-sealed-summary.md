# Cursor 渠道封存总结（2026-09-19）

> cursor AI 渠道正式封存。本文是渠道从立项到退役的完整总结，后续如需重启渠道，以本文为入口。

## 1. 封存状态

| 资产 | 位置 | 状态 |
|---|---|---|
| 全部实现代码 | `attic/cursor/`（23 文件） | 逐字节保真归档，不参与构建/测试/lint |
| 逆向研究成果 | `docs/cursor/`（19 篇）+ `docs/cursor-provider-l1-plan.md` | 原位保留，是资产不是垃圾 |
| 决定与剥离记录 | `docs/cursor-retirement.md` | 含恢复方式 |
| 恢复锚点 | tag `baseline-cursor-p1p2`（95270e597，全能力态）/ `baseline-pre-cursor`（e630799ef，纯净态） | 已推送远端 |
| 终态版本 | `oh-my-kimi-code@1.0.2`（38410d0ad） | 首个无 cursor 正式版，本机已装 |

## 2. 渠道一生（简史）

- **SDK 路线**（@cursor/sdk 1.0.30 嵌入）→ **native 路线**（自写 Connect bidi 客户端，427 行 frame/conversation/run-stream/exec-tools）→ **P0 状态持久化**（v2 replayable state + durable checkpoint 事件，重启不失忆）→ **P0 修复**（critic 抓出 bridge 单槽被子 agent 击穿的 p1，tower 改栈式）→ **P1 compact 联动**（本地压缩模仿官方服务端压缩后形态：`[Previous conversation summary]` user blob + blobStore GC）→ **P2 跨模型注入**（切回 cursor 时非 cursor 段落 user blob 注入 + 水位幂等）。
- 全部 P0-P2 经过完整审查链（coder → critic → tower reviewer），kosong 全量 1509 用例绿，但**从未推送远端**——这是本次退役零成本的唯一原因。
- 真机验证最高战绩：续聊 round2 精准答出会话前事实（7F-204），gets 全命中。

## 3. 退役原因

逆向渠道的固有风险（指纹对抗、账号池熔断、上游随时变更）> 维护收益。决定：
- 代码进 attic 而非删除——保留复活能力；
- 文档保留——协议研究成果是资产；
- 未发布 changesets 删除——不留幽灵 changelog。

## 4. 重启渠道的步骤（如未来需要）

1. `git diff baseline-cursor-p1p2..HEAD -- packages/ | head` 确认现状；
2. 从 attic 取回代码（或直接 `git checkout baseline-cursor-p1p2 -- packages/kosong/src/providers/cursor-native packages/agent-core-v2/src/agent/cursor ...`）；
3. 对照 `docs/cursor/continuation-protocol.md` 与 proto 字段图核对上游协议是否已变；
4. 重接 4 处断线（providers/index、catalogService、modelRequester、protocol 枚举）+ manifest 重生成；
5. 全量测试 + 真机探针。

## 5. 遗留注意事项

- 用户 config 中 cursor 段已清理（备份：`~/.omkc/config.toml.bak-pre-cursor-strip`）；
- 旧会话 wire.jsonl 中的 cursor 记录：实测**记录类型层面零存在**（三审扫 3163 文件确认），无恢复风险；
- backlog：configManifest 新鲜度测试去 skip、doctor 感知 salvage 丢弃项（非 cursor 专属）。
