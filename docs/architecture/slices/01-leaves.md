# 01 · 地基切片：叶子包

这一层是整个仓库的地基：`kosong`、`kaos`、`oauth`、`telemetry`、`tree-sitter-bash`、`pi-tui` 六个叶子包（`protocol` 已删除）彼此之间没有任何仓内依赖，报告的 Import Cycles 一节也给出 None，因此图中不存在叶子之间的横向边，所有边都由上层消费者指向叶子。报告的 God Nodes 同样落在这层——`Parser`（`tree-sitter-bash`）、`Editor` / `TuiAltScreen` / `TuiBase` / `ScrollView`（`pi-tui`）、`LocalKaos`（`kaos`）、`refreshProviderModels()`（`oauth`）——说明复杂度沉淀在叶子内部，而不是被上层摊薄；社区划分也印证了这一点，例如 Community 25 是 `kaos` 的 `chdir()` / `exec()` / `glob()`，Community 61 是 `oauth` 的 token 刷新事务。图中箭头方向统一为「消费者 → 依赖」。

```mermaid
flowchart TB
  cli[Kimi Code CLI]
  sdk[kimi-code-sdk]
  v1["agent-core (v1)"]
  v2[agent-core-v2]
  vis[vis/server]

  kaos[kaos 执行环境]
  kosong[kosong LLM 供应商抽象]
  oauth[oauth 认证]
  tsb[tree-sitter-bash 解析器]
  telemetry[telemetry 遥测]
  tui[pi-tui 终端 UI]

  cli --> oauth
  cli --> telemetry
  cli --> tui
  sdk --> kaos
  sdk --> oauth
  sdk --> kosong
  v1 --> kaos
  v1 --> kosong
  v1 --> oauth
  v1 --> protocol
  v2 --> kosong
  v2 --> oauth
  v2 --> protocol
  v2 --> tsb
  vis --> kosong
```

## 对外

这层对外只暴露下面这些出边，除此之外不声称任何依赖关系：

- **agent-core（v1）**：`kaos`、`kosong`、`oauth`、`protocol`
- **agent-core-v2**：`kosong`、`oauth`、`protocol`、`tree-sitter-bash`
- **kimi-code-sdk**：`kaos`、`oauth`、`kosong`
- **Kimi Code CLI**：`oauth`、`telemetry`、`pi-tui`
- **vis/server**：`kosong`
