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

见「第二轮结果」章节（探针运行中，结果回填）。

## N5  SDK 版本：我们已是最新

`npm view @cursor/sdk versions` 最新为 **1.0.30**，与社区版锁定的版本一致。

官方 `docs/sdk/changelog.md` 只写到 **1.0.27**，因此 1.0.28–1.0.30 无公开变更说明——**不是我们版本落后，是官方 changelog 未更新**。

→ **无需升级 SDK**。N5 关闭。

### 关于"是否要跟官方用最小 SDK"

`@cursor/sdk` 是单体包（含 11MB bundle + 原生二进制），**没有"最小版"可选**。我们已经用动态 `import()` 把加载成本推迟到首次 `generate()`，是官方推荐的规避方式（见 `cursor.ts` 顶部 L1 设计注释）。无进一步瘦身空间。

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
