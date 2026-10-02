# 开始使用

## Kimi Code CLI 是什么

Kimi Code CLI 是一个运行在终端中的 AI Agent，帮助你完成软件开发任务和日常的终端操作——阅读和修改代码、执行 Shell 命令、搜索文件、抓取网页，并在执行过程中根据反馈自主规划和调整下一步行动。

它适用于以下场景：

- **编写和修改代码**：实现新功能、修复 bug、完成重构
- **理解项目**：探索陌生的代码库，解答架构和实现层面的问题
- **自动化任务**：批量处理文件、运行构建与测试、串联多个脚本

本社区版（`oh-my-kimi-code`）的呼出命令是 `omkc`。它使用独立数据目录（`~/.omkc`），可以和官方 `kimi` 同机并存。

## 安装

从 GitHub Releases 下载原生可执行文件（推荐，无需 Node.js），或从源码构建。

::: tip 安装之前
Oh My Kimi Code 为全交互式 TUI 应用，推荐在支持真彩色与连字的现代终端中运行以获得最佳体验，例如 [Kitty](https://sw.kovidgoyal.net/kitty/) 或 [Ghostty](https://ghostty.org/)。
:::

### 原生可执行文件（推荐）

从 [GitHub Releases](https://github.com/Yorha9e/oh-my-kimi-code/releases) 下载对应平台的压缩包并解压：

- Windows：`omkc-win32-x64.zip` / `omkc-win32-arm64.zip`
- macOS：`omkc-darwin-x64.zip` / `omkc-darwin-arm64.zip`
- Linux：`omkc-linux-x64.zip` / `omkc-linux-arm64.zip`

把解压目录加入 `PATH`，然后在新终端中运行：

```sh
omkc --version
```

> Windows 用户首次启动前还需要安装 [Git for Windows](https://gitforwindows.org/)，CLI 会使用其中的 Git Bash 作为 Shell 环境。如果 Git Bash 安装在非标准路径，请把 `KIMI_SHELL_PATH` 设为 `bash.exe` 的绝对路径。

社区版**不会发布到 npm**。`npm install -g @moonshot-ai/kimi-code` 装的是官方 `kimi` CLI，不是本 fork。

### 从源码构建

需要 Node.js `>=24.15.0` 和 pnpm：

```sh
git clone https://github.com/Yorha9e/oh-my-kimi-code.git
cd oh-my-kimi-code
pnpm install
pnpm -C apps/kimi-code run build
node apps/kimi-code/dist/main.mjs
```

## 升级与卸载

安装完成后，验证可执行文件是否就绪：

```sh
omkc --version
```

**升级**：运行 `omkc upgrade`，CLI 会检查 GitHub Releases 并展示更新选项。原生安装可在下次启动时换上新二进制。

**卸载**：删除 `omkc` 可执行文件（若保留了解压目录，一并删除即可）。

## 第一次启动

进入项目目录后直接运行 `omkc` 启动交互界面：

```sh
cd your-project
omkc
```

只想执行一条指令而不进入交互界面时，使用 `-p`：

```sh
omkc -p "帮我看一下这个项目的目录结构"
```

继续上一次会话加 `-c`：

```sh
omkc -c
```

首次启动时需要配置模型。在交互界面中输入 `/login` 走 Kimi Code OAuth，或用 `/provider` 从目录添加其他供应商：

```
/login
/provider
```

`/login` 会弹出平台选择器，支持两种方式：

- **Kimi Code（OAuth）** — 验证码流程，在任意设备打开链接、登录并输入验证码即可授权
- **Kimi Platform API 密钥** — 输入来自 `platform.kimi.com` 或 `platform.kimi.ai` 的 API 密钥

需要退出登录时，输入 `/logout` 清除当前凭证。

::: tip 使用其他 AI 供应商
如果你想接入 Anthropic、OpenAI、Google 等其他供应商，使用 `/provider` 或编辑 `~/.omkc/config.toml` 配置 API 密钥，详见[平台与模型](../configuration/providers.md)。配置项完整说明见[配置文件](../configuration/config-files.md)、[环境变量](../configuration/env-vars.md)和[配置覆盖](../configuration/overrides.md)。
:::

## 第一个对话

配置好模型后，用自然语言描述任务即可。先让它熟悉当前项目：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

Kimi Code CLI 会自动调用文件读取、搜索等工具浏览相关内容后给出回答。只读操作默认自动执行无需确认；对于会修改文件或执行 Shell 命令的操作，默认会在执行前征求确认。

也可以直接描述更具体的任务：

```
在 src/utils 里新增一个函数，用来把任意字符串转成 kebab-case，并补一个单元测试
```

Kimi Code CLI 会规划步骤、修改代码、运行测试，并在每一步告诉你它做了什么。

::: tip 不知道能做什么？输入 `/help`
随时在输入框输入 `/help`，可以打开内置的命令和快捷键面板，按 `↑`/`↓` 翻看，`Esc` 关闭。退出时输入 `/exit`，或按 `Ctrl-C` 两次，或在输入框为空时按 `Ctrl-D`。
:::

## 常用命令与快捷键速查

第一次使用时，记住下面这些就够了：

**会话相关命令**

| 命令 | 说明 |
| --- | --- |
| `/new` | 开启新会话，清空当前上下文 |
| `/sessions` | 浏览历史会话，选择恢复 |
| `/model` | 切换当前使用的模型 |
| `/compact` | 手动压缩上下文，释放 token |
| `/fork` | 派生当前会话为保留完整历史的独立副本（仍停留在当前会话） |

**最常用快捷键**

| 快捷键 | 说明 |
| --- | --- |
| `Esc` | 中断流式输出 / 关闭弹窗 |
| `Ctrl-C` | 中断输出；空闲时连按两次退出 |
| `Shift-Tab` | 切换 Plan 模式 |
| `Ctrl-S` | 输出中途插入消息，无需等待结束 |
| `Ctrl-O` | 折叠 / 展开工具输出和压缩摘要 |

想看完整列表，输入 `/help` 或访问[斜杠命令参考](../reference/slash-commands.md)和[键盘快捷键](../reference/keyboard.md)。

## 数据存放在哪里

Oh My Kimi Code 的本地数据默认保存在 `~/.omkc/` 下，包含配置文件、会话记录、日志和更新缓存。如需迁移到别处，设置 `OMKC_HOME`（兼容 `KIMI_CODE_HOME`）。完整说明见[数据路径](../configuration/data-locations.md)和[环境变量](../configuration/env-vars.md)。

## 下一步

- [交互与输入](./interaction.md) — 输入框操作、审批流程、Plan 模式和 YOLO 模式详解
- [会话与上下文](./sessions.md) — 恢复会话、上下文压缩、导出会话
- [常见使用案例](./use-cases.md) — 典型任务的 prompt 示例
