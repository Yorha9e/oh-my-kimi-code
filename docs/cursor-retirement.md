# CURSOR 渠道退役决定与剥离记录

> 日期：2026-09-10。决策人：用户。
> 本文档记录 cursor AI 渠道从 oh-my-kimi-code 社区版的退役决定、剥离范围与恢复方式。

## 1. 决定

- **放弃 cursor 渠道**（逆向风险 + 账号池维护成本，不再投入）。
- P0-P2 全部成果（持久化/修复/compact 联动/跨模型注入）已完成并通过 review，但**从未推送到远端**——远端（omkc/main）与用户已安装版本本就无 cursor。
- 处置：源码/测试剥离至 `attic/cursor/` 归档保留（不参与构建/测试/lint）；`docs/cursor/` 全部逆向文档**原位保留**（资产沉淀）；未发布的 10 个 `cursor-*.md` changesets 删除（防幽灵 changelog）。

## 2. 锚点（恢复入口）

| tag | 指向 | 含义 |
|---|---|---|
| `baseline-pre-cursor` | `e630799ef` | 无任何 cursor 的纯净态 |
| `baseline-cursor-p1p2` | `95270e597` | P0 闭环 + P1/P2 开工前（完整 cursor 能力态） |

恢复方式：`git diff baseline-cursor-p1p2` 可取回全部 cursor 实现；或 cherry-pick 对应 mission 分支（feat/M1-cursor-*、feat/M2-*）。

## 3. 剥离范围（施工单，coder agent-445 执行）

- **kosong**：11 个 cursor 源文件（SDK 路线 cursor.ts/cursor-auth-shim/cursor-token + native 全家桶）+ 5 测试 → attic；`providers/index.ts` 4 处断线；`src/index.ts` 桶导出删除；`package.json` 删 `@cursor/sdk`。
- **agent-core-v2**：cursorState.ts + bases/cursor/ 4 文件 + 2 测试 → attic；catalogService/modelRequester*/protocol/index 断线；wire/state manifest 重生成（cursorNative 键与 cursor.checkpoint_updated 事件消失）。
- **apps**：copy-native-assets.mjs 的 @cursor/sdk 段删除。
- **保留不动**：fsOpenInApp/fileLaunch 的 'cursor' 枚举（Cursor 编辑器 OS 集成，非 AI 渠道）；分页游标/cron.cursor 等全部假阳性；v1 引擎。

## 4. 验收标准

- `grep -Rni "\bcursor\b"` 在 kosong/agent-core-v2 的 src 零命中；
- kosong 全量测试绿；v2 after-only 零新增失败；typecheck/lint 零新增；
- manifest 重生成后 diff 仅表现为 cursor 条目消失。

## 5. 备注

- cursor 协议研究成果全部沉淀在 `docs/cursor/`（协议记录、官方对齐、proto 字段图、逆向探索），渠道若未来重启，从本文档 §2 锚点 + attic 即可复原。
- 依赖项：`@bufbuild/protobuf` 保留（connect 共享依赖）；lockfile 中 @cursor/sdk 及 5 个平台包随 pnpm install 自动消失。
