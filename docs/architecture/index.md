# 架构索引

从这里进入。总图只画包和块，切片图画块里面的模块。箭头一律是「谁依赖谁」。

| 先读 | 文件 | 里面有什么 |
|---|---|---|
| 总图 | [overview.md](overview.md) | 各块怎么接在一起 |
| 切块说明 | [../architecture-map.md](../architecture-map.md) | 15 个包怎么切块，以及 v1 是怎么删掉的 |
| 结构图数据 | `graphify-blocks/<切片>/graphify-out/GRAPH_REPORT.md` | 每块的 AST 图。本地目录，不进 git |

## 按块

| 块 | 切片 | 图数据 | 里面是什么 | 依赖谁 |
|---|---|---|---|---|
| 01 地基 | [01-leaves.md](slices/01-leaves.md) | `01-leaves` | `kaos`、`kosong`、`oauth`、`telemetry`、`tree-sitter-bash`、`pi-tui`。彼此没有边 | 无 |
| 02 v2 存储 | [02-v2-store.md](slices/02-v2-store.md) | `02-v2-store` | `minidb`（MiniDb、WAL、TextIndex、代）和 `transcript`（契约、操作、store）。两包互不依赖 | 无 |
| 03 旧数据面 | [03-v1.md](slices/03-v1.md) | `03-v1`（已删，仅考古） | 删除前是 `agent-core` 的 KimiCore / Session / Agent，加上 `migration-legacy`、`vis/server` | 当时：kaos、kosong、oauth、protocol |
| 04 v2 核心 | [04-v2-core.md](slices/04-v2-core.md) | `04-v2-core` | DI 内核、agent 循环、session 域、kosong 镜像 | 地基的 kosong、oauth、tree-sitter-bash，以及 minidb |
| 04 v2 外壳 | [04-v2-shell.md](slices/04-v2-shell.md) | `04-v2-shell` | App 级服务、Program、工作区实例、features。没有 Workspace 这一层 DI | 04 核心，外加 oauth、minidb |
| 05 v2 外沿 | [05-v2-edge.md](slices/05-v2-edge.md) | `05-v2-edge` | `klient`、`kap-server`、`acp-server`、`kimi-inspect`。web 预构建包只进 kap-server | 整个 agent-core-v2，再加 oauth、minidb、transcript |
| 06 宿主层 | [06-knot.md](slices/06-knot.md) | `06-knot`（已删 v1，仅考古） | CLI、VS Code 扩展、`kimi-code-sdk`、当时的 `acp-adapter` | 当时：两台引擎、外沿、地基、存储 |

04 的两张切片合成总图里的一块「v2 引擎」。外沿和 SDK 依赖的是整包，不是其中某一个服务。

## v1

引擎包 `agent-core`、`acp-adapter`、`protocol` 已删除。不要从官方树把它们抄回来。`migration-legacy` 和 `vis/server` 现在只依赖 v2。

## 重构时的阅读顺序

1. 总图，确认要动的块。
2. 该块的切片，看内部模块。
3. 该块的 `GRAPH_REPORT.md`，只看 God Nodes 和 Import Cycles。社区名还是 `Community N`，不要按社区名导航。
4. 地基默认不动。第 3 块和第 4 块不要同一次改。第 6 块最后动。
