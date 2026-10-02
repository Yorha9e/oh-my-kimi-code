# Cursor 模型参数体系：官方权威解码

> 来源：`https://cursor.com/docs/sdk/typescript`（Model selection / 模型参数章节，约 1011、1780-1900 行）、`https://cursor.com/docs/subagents.md`（Model parameters 方括号语法）、各模型文档 `docs/models/*.md`。2026-09-03 从官方 `llms.txt` 索引拉取的 `.md` 原文。
>
> 用途：作为「统一参数解析 + per-send 覆盖」接线的**唯一依据**，替代自研推测。

## 1. 官方数据结构

```ts
interface ModelListItem {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: ModelParameterDefinition[];
  variants?: ModelVariant[];
}

interface ModelParameterDefinition {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;   // ← 顶层 values
}

interface ModelVariant {
  params: ModelParameterValue[];   // 预设组合，可直接复制到 ModelSelection
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}
```

## 2. 已知参数 id（官方明列）

| 参数 id | 语义 | 值域 | 出现位置 |
|:---|:---|:---|:---|
| `effort` | 推理强度 | `low` / `medium` / `high` / `xhigh`（视模型） | 多数模型 |
| `reasoning` | 推理强度（GPT 系用此 id） | `none`/`low`/`medium`/`high`/`extra-high` | GPT 家族 |
| `thinking` | 布尔思考开关 | `"true"` / `"false"` | 部分模型 |
| `fast` | 速度档 | `"false"` / `"true"` | composer-2.5 等，**官方示例明确** |
| `context` | 上下文窗口大小 | `"300k"` 等 | subagent frontmatter 方括号语法 |
| `optimize_for` | Cursor Router 路由偏好 | `cost` / `balanced` / `intelligence` | **仅 `auto-smart`** |

官方 composer-2.5 的 `parameters` 实际返回：

```js
[
  {
    id: "fast",
    displayName: "快速",
    values: [
      { value: "false" },
      { value: "true", displayName: "快速" },
    ],
  },
]
```

## 3. 方括号语法（subagent frontmatter）= 同一套 `id=value`

| 示例 | 等价 ModelSelection |
|:---|:---|
| `composer-2.5[]` | `{id:"composer-2.5"}`（空括号 = 钉基础模型，选标准变体而非 fast） |
| `composer-2.5[fast=false]` | `{id:"composer-2.5", params:[{id:"fast",value:"false"}]}` |
| `claude-opus-5[effort=high]` | `{id:"claude-opus-5", params:[{id:"effort",value:"high"}]}` |
| `claude-opus-5[context=300k]` | `{id:"claude-opus-5", params:[{id:"context",value:"300k"}]}` |
| `claude-opus-5[effort=high,context=300k]` | 两参数组合 |

官方："Available options depend on the model, and use the same `id=value` pairs as the SDK's model parameters."

## 4. 官方最佳实践（三条，直接决定我们的实现）

> 原文标题「最佳实践」，逐条照做：

1. **动态获取，不要硬编码**："在启动时（或每个进程启动一次）调用 `Cursor.models.list()`，并缓存结果。随着新模型上线，模型 ID 和参数结构可能发生变化。"
2. **模型需要参数时，务必显式传入**："`parameters` 数组非空的模型属于参数化模型。请传入所需参数；否则，**运行时会使用每个参数允许的第一个值**，这可能不符合你的预期。对于 Cursor Router，始终显式传入 `optimize_for`。"
3. **按能力而非 ID 解析**：给出按能力查找的范式（见下方接线设计）。

**回退链**（官方原文）："当目标模型不可用时，优先显式选择 Router（`auto-smart` + `optimize_for`）。只有在希望由服务器选择 Auto，且不指定 Cost、Balance 或 Intelligence 时，才回退到 `{ id: "auto" }`。"

## 5. 官方"按能力解析"范式（可直接照搬）

```ts
const models = await Cursor.models.list();
const composer = models.find((m) => m.id === "composer-2.5");
const fast = composer?.parameters?.find((p) => p.id === "fast");
const fastValue = fast?.values.find((v) => v.value === "true")?.value;
const model = composer
  ? {
      id: composer.id,
      params: fastValue ? [{ id: "fast", value: fastValue }] : undefined,
    }
  : {
      id: "auto-smart",
      params: [{ id: "optimize_for", value: "balanced" }],
    };
```

## 6. 与现有实现的差距

| 维度 | 官方要求/范式 | 我们现状（`cursor.ts:757` `resolveWireModel`） |
|:---|:---|:---|
| 参数发现 | `Cursor.models.list()` 动态获取并缓存 | ✅ 等价：`fetchModelCatalog()` + 5min TTL（见观察项：刷新策略待定） |
| effort 参数 | 查声明的 `effort` 或 `reasoning` | ✅ 已实现（双体系，`ddb42c07f`） |
| `thinking` 布尔 | 模型声明了才传 | ✅ 已实现（条件化） |
| **`fast` 参数** | 官方示例一级公民 | ❌ **完全未解析**，只能靠 config `modelParams` 硬配 |
| **`context` 参数** | 方括号语法 `context=300k` | ❌ **未解析** |
| **方括号语法** | `model[k=v,...]` | ❌ **未支持**，`-fast` 后缀也不识别 |
| **`optimize_for`（Router）** | auto-smart 必须显式传 | ❌ **未支持**（我们已识别 auto-smart，但未传此参数） |
| 值域校验 | 用声明的 `values` | ✅ 已实现（且修正过读取位置） |
| 参数化模型未传参 | 官方警告会用第一个值 | ⚠️ 与「6 条无 parameters 模型兜底」待办相关 |
| 回退链 | 目标不可用 → `auto-smart`+`optimize_for` → `{id:"auto"}` | ⚠️ 我们有 DEFAULT_MODEL_ID 回退，但未按官方三层链设计 |

## 7. 接线设计（按官方范式）

```
resolveWireModel(requested: string):
  1. 解析请求串：拆分方括号语法  model[k=v,...]  →  { baseId, inlineParams }
     （同时保留裸 id 与既有后缀形态的兼容）
  2. catalog 查 baseId（含 aliases）
  3. 参数逐项解析（每项都用 catalog 声明的 values 校验）：
     - effort（id 为 effort 或 reasoning，按模型实际声明）
     - fast（布尔值字符串 "true"/"false"）
     - context（窗口大小，如 "300k"）
     - optimize_for（仅 auto-smart：cost/balanced/intelligence）
     - thinking（布尔，模型声明了才加）
  4. 优先级：内联方括号 > config modelParams > effort 解析结果
  5. 值不在声明集合内 → 回退裸 id（沿用既有策略）
  6. 目标模型不在 catalog → 官方回退链：auto-smart+optimize_for → {id:"auto"}
```

关键：全部依据 catalog 声明，**不硬编码任何参数 id 或值域**（官方最佳实践第 1、3 条）。
