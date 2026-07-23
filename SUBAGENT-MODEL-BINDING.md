# 子代理模型绑定（subagent model binding）

本特性的详细参考；简介见 [README.md](README.md) 的「特性」一节。

## 现状

- 社区版（`omkc`）**默认开启**，已并入 `main`，不再是实验开关。
- 实验开关 `subagent-model-selection` 仍保留，默认值为 `true`；需要整体关闭时见文末[如何关闭](#如何关闭)。

## 它做什么

`Agent` / `AgentSwarm` 工具派生的子代理默认继承主代理的模型。本功能允许为子代理预先绑定**模型别名与思考强度**，在 spawn 时机械生效：

- 两种绑定粒度：
  - **类型绑定**：按子代理类型绑定（`coder` / `explore` / `plan` 等内置类型，以及 MOA 角色 `orchestrator` / `critic` / `synthesizer`）
  - **命名槽位（slot）**：实例级绑定。调用方通过 `Agent` / `AgentSwarm` 工具的 `binding_slot` 参数指名槽位——调用方只知道槽位名，接触不到模型名
- 绑定是**用户配置，不是 LLM 决策**：模型看不到绑定配置，也没有选择模型的参数，无法覆盖
- 未绑定的类型 / 槽位首次 spawn 时会交互式询问一次（可选「保持继承」），选择被记录后不再重复询问
- 中断后恢复的子代理保持出生时的绑定（sticky resume），不随主代理切换模型
- 生效的模型 / 强度显示在工具结果（`model: <alias>` 行）、审批标签与 `subagent.spawned` 事件中；`/subagent-model list` 与 `/settings` 面板中的绑定显示还带模型能力标识

## 存储与优先级

两级存储，TOML 结构相同：

| 层 | 文件 | 写入途径 |
| --- | --- | --- |
| 工作区层 | `<projectRoot>/.kimi-code/local.toml` | 交互式询问、`/subagent-model`、`/settings`（工作区页签）。该文件在项目目录里，官方 `kimi` 与社区版 `omkc` 读取同一份（见 README「与官方版并存的注意事项」） |
| 全局层 | `~/.omkc/local.toml` | 仅 `/settings` 面板的全局页签。交互式询问**从不**写全局层 |

类型绑定示例（工作区层）：

```toml
[subagent.explore]
model = "kimi-code/kimi-for-coding"
thinking_effort = "high"

[subagent.coder]
inherit = true        # 显式记录「保持继承」，不再询问
```

命名槽位示例（全局层）：

```toml
[subagent-slot.review]
model = "kimi-code/kimi-for-coding"
thinking_effort = "medium"
```

spawn 时的解析优先级（靠前者优先）：

1. 命名槽位绑定：工作区层 > 全局层
2. 类型绑定：工作区层 > 全局层
3. profile 自带的默认模型 / 思考强度（随内置 profile 发布的那部分）
4. 继承主代理

绑定引用的模型别名已从你的模型配置中消失时，spawn 会带警告回退到下一级；交互环境下会重新询问，让你重选并修复该绑定。

## 管理绑定

### `/subagent-model` 命令

```text
/subagent-model [list]             # 列出工作区的全部类型绑定与槽位绑定（Types / Slots 两节）
/subagent-model set <type>         # 为类型挑选模型与思考强度
/subagent-model set slot <name>    # 为命名槽位挑选模型与思考强度
/subagent-model clear <type>       # 移除类型绑定
/subagent-model clear slot <name>  # 移除槽位绑定
```

`set` 弹出两步选择器：先选模型，再选该模型支持的思考强度（可保持继承）。结果写入工作区层。

### `/settings` 批量编辑面板

`/settings`（或 `/config`）中选择 **Subagent models**：

- 逐行浏览全部类型与槽位绑定，改动先暂存为草稿，确认后一步应用
- `Tab` / `Shift+Tab` 在**工作区层 / 全局层**两个页签间切换，两层草稿互相独立；保存只写入当前页签所在层
- Slots 一节可用 `+ Add slot…` 内联新建槽位（先取名，再选模型与思考强度）

## Sticky resume

中断后恢复（resume）与重试（retry）的子代理保持出生时配置的模型与思考强度，不与主代理当前模型重新对齐，避免同一子代理在对话中途切换模型。关闭本功能后恢复旧行为：resume 时子代理重新对齐主代理当前模型。

## 如何关闭

默认开启。若要整体回到「一切继承主代理」的旧行为：

- 环境变量：`KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION=0`
- 或 `config.toml`：

  ```toml
  [experimental]
  subagent-model-selection = false
  ```

关闭只停止读取绑定，不会改动任何配置文件；重新开启后绑定依旧生效。

## 背景

本功能源自向上游提交的实验性提案 [MoonshotAI/kimi-code#1928](https://github.com/MoonshotAI/kimi-code/pull/1928)（issue [#1927](https://github.com/MoonshotAI/kimi-code/issues/1927)），在社区版中并入 `main` 且默认开启，随后扩展了命名槽位、`AgentSwarm` 支持、全局层与 `/settings` 批量编辑面板。成熟后这些改动会以 PR 形式回馈上游。
