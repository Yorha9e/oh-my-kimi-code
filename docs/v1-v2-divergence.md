# v1 ↔ v2 Subagent 模型绑定差异与迁移说明

> 适用范围：社区版（oh-my-kimi-code）。行号基于 0.34.0-omkc.3 时代码，后续提交可能漂移。
> 结论先行：**v2 是默认引擎**（truthy `KIMI_CODE_LEGACY_FLAG` 才回退 v1，见 `apps/kimi-code/src/cli/experimental-v2.ts`）；**v1 冻结不补**——能用且功能完整即不修补，所有新修复只落 v2。

## 1. v2 权威解析链（从高到低）

```
args.model（显式传参）
  > binding_slot（命名槽位）
  > modelPreference（调用方偏好）
  > [agent_types]（v2 独有）
  > profile frontmatter slot
  > [subagent.<type>]（v1 式按类型绑定）
  > secondary（settings 内次模型）
  > caller（跟随父 agent 模型）
```

## 2. 已验证对齐（双引擎行为一致）

- `local.toml` / `config.toml` 双向 round-trip 逐字节兼容。
- 绑定条目 schema、`workspace > global` 回退、inherit 遮蔽、未知字段容忍：全部一致。
- 默认 flag（`subagent-model-selection`=on / `secondary`=off）下 spawn / resume 行为一致。
- resume 时 slot 覆盖的持久化语义一致。
- 超时文案逐字一致。

## 3. 有意分歧（冻结，不修）

| 主题 | v1 行为 | v2 行为 | 位置 |
|---|---|---|---|
| model + binding_slot 同传 | **slot 赢** | **显式 model 赢**（规格化） | v1 `agent.ts:470-510`、`subagent-host.ts:251-266,653-657`；v2 `agentTool.ts:349-351,527-543` |
| profile slot vs `[subagent.<type>]` | **type 赢** | **slot 赢**（v2 注释误读 v1，但链序本身被认可） | v1 `subagent-host.ts:217-240`；v2 `configSection.ts:326-410` |
| 全局绑定文件 | 硬编码 `~/.omkc/local.toml`（kaos.gethome） | 走 `resolveKimiHome()`：`OMKC_HOME` > `KIMI_CODE_HOME` > `~/.omkc` | v1 `workspace-local.ts:365-367,191-242`；v2 `slotBinding.ts:69-107,117-137`、`bootstrap.ts:180-187` |
| flag off 时 resume | 对齐父模型 | 永远 sticky（保留原模型） | v1 `subagent-host.ts:296-301,721-724`；v2 `agentTool.ts:305-323` |
| flag off 时 schema | 保留 binding_slot 字段、静默忽略 | 剥离字段并拒绝（**v2 更安全**） | — |
| binding_slot 未命中 | warn + 降级 | 硬错误（规格） | v1 `agent.ts:244-254`；v2 `agentTool.ts:534-541` |
| 交互式询问（askBinding） | 有 | 无，由 `/subagent-model` 命令替代 | v1 `subagent-binding.ts:95-193` |
| `[agent_types]` 段 | 无 | **v2 独有** | v2 `configSection.ts:134-215` |
| resume 报错文案 | "is not a subagent" | "does not exist" | — |
| resume sticky alias 前置校验 | 有 | 无 | — |
| 空 `[subagent.<type>]` 条目 | 遮蔽 profile slot | 不遮蔽 | — |
| `/dir add` 校验范围 | 全 schema | 仅 workspace | — |
| 配置解析失败 | 严格抛错 | 降级 + 诊断 | — |
| swarm 槽位 zod 校验 | `trim().min(1)` | 纯 optional（裁决：保留宽松） | — |
| `modelPreference` 与 thinking-only type 并存 | v1 type thinking 独立生效 | v2 modelPreference 短路、type thinking 被丢弃（既有设计） | v1 `subagent-host.ts:235-240`；v2 `configSection.ts:315-325`、`agentTool.ts:358-359,496` |

注意：设了 `OMKC_HOME` / `KIMI_CODE_HOME` 时，**双引擎读写的不是同一份 local.toml**——混用引擎排查绑定问题时先看这个。

## 4. 已修复 / 本批修复（全部只动 v2）

**已随 0.34.0-omkc.3 发布：**
- v2 完整 binding_slot 链路（spawn/resume/swarm）移植，经两轮双 critic 盲审 + reviewer 修复，本机冒烟通过（同 profile 双槽位并行派遣实证）。

**本批（v1-v2-diff 批次）：**
1. `KIMI_SUBAGENT_TIMEOUT_MS=0` 被忽略：v2 `configSection.ts:107-110` `parseTimeoutMsEnv` 要求 ≥1，env=0 静默回退 2h；v1 `subagent-host.ts:50-60` 接受 0=不限时。修：放宽 `>=0` + 测试。
2. thinking-only `[subagent.<type>]` 绑定被 v2 丢弃：`configSection.ts:394-410` 只有 `typeBinding?.model !== undefined` 分支；v1 `subagent-host.ts:228-240` 生效。修：`resolveSubagentBinding` 加 thinking-only 分支（仿 slot 分支）。
3. 429 恢复指引文案缺失：v1 `agent.ts:87-92` resume 描述含 "May be combined with binding_slot to switch the resumed agent to that slot's model — use it to recover progress when the original model is rate-limited (429) or refused by safety policy"，v2 `agent-core-v2/src/agent/tools/agent/agent.ts:46-51` 没有；v1 resume_hints（`agent.ts:637` 后台、`:668` 前台）尾部 "If its model is rate-limited (429)...add binding_slot=..."，v2 `agentTool.ts:838`、`:870-872` 没有。修：补回文案。
4. flag 不门控补测试背书：v2 对 profile slot / type 绑定不门控 `subagent-model-selection`（v1 在 `subagent-host.ts:505,533` 门控且有测试 `subagent-host.test.ts:1822`），v2 只有 `flag.ts:11-17` 注释宣称"有意"。修：加测试钉住 "flag off 时 slot/type 仍生效" + 修注释措辞。**`description` 字段逐字不动**（parity 测试 `2c79555f6` 与 node-sdk `config.test.ts:352` 依赖）。

## 5. 迁移建议

- 从 v1 带配置过来的用户：**model+binding_slot 同传**和**空 type 条目遮蔽**两处语义变了，依赖旧行为的派单提示词要改。
- 排查绑定不生效：先确认引擎（默认 v2），再确认读的哪份 `local.toml`（第 3 节 env 问题）。
- v1 的 askBinding 交互询问没有了，改用 `/subagent-model` 或在派单参数里显式给 `binding_slot`。
