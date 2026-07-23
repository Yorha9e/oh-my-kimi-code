# oh-my-kimi-code（omkc）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) · **Upstream**: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) · [Issues](https://github.com/Yorha9e/oh-my-kimi-code/issues)

> English readers: this fork is documented primarily in Chinese. For the official English docs, see the upstream [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).

## 这是什么

**oh-my-kimi-code** 是 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 的社区 fork，呼出命令为 `omkc`。它用来先行落地一批「多代理编排」相关的特性，成熟的功能会以 PR 形式回馈上游。

社区版与官方版**完全并存**，互不污染：

- **独立命令**：官方是 `kimi`，社区版是 `omkc`，全局安装不会互相覆盖
- **独立数据目录**：官方是 `~/.kimi-code`，社区版是 `~/.omkc`（env 优先级：`OMKC_HOME` > `KIMI_CODE_HOME` > 默认）
- **首次启动自动迁移**：从官方目录复制配置、凭据、会话、技能、输入历史等（复制不移动），**无需重新登录**
- 两个版本可以同机安装、同时使用；出问题随时切回官方 `kimi` 排查

## 特性

1. **子代理模型绑定全家桶（默认开启）** — 按子代理类型（`coder` / `explore` / `plan` 等）或命名槽位（slot）绑定模型与思考强度。绑定是用户配置而非 LLM 决策，在 spawn 时机械生效。工作区层（`.kimi-code/local.toml`）与全局层两级存储；中断恢复的子代理保持原绑定（sticky resume）；`AgentSwarm` 支持槽位；绑定显示带模型能力标识。详见 [SUBAGENT-MODEL-BINDING.md](SUBAGENT-MODEL-BINDING.md)。
2. **MOA 多代理辩论 profiles** — 内置 `orchestrator` / `critic` / `synthesizer` 等角色化子代理配置（`packages/agent-core` 的 MOA profiles），让多代理协作以结构化辩论的形式展开。
3. **桌面悬浮卡片 moa-card** — `omkc` 交互启动时自动拉起（`tui.toml` 的 `[moa] card` 开关，默认开），实时显示 MOA 辩论进度与各 agent 状态。
4. **内嵌状态导出** — CLI 进程内建 loopback SSE 服务（`127.0.0.1:39631` 起，只绑环回、零写盘），供外部工具订阅 agent 状态；开关为 `tui.toml` 的 `[moa] status_export`（默认开）。
5. **omkc-status 独立状态服务（伴生项目）** — 只读监听会话持久化文件，折叠出 agent 状态，对外提供 HTTP `/state` 与 SSE `/events`（39627 端口）。不依赖 CLI 进程存活，也不向会话目录写入任何东西。
6. **kosong Anthropic 兼容端点加固** — `max_tokens` 保守兜底 + 400 错误自动解析并重试，兼容更多第三方 Anthropic 风格端点（已提上游 [PR #2066](https://github.com/MoonshotAI/kimi-code/pull/2066)）。
7. **Windows 平台测试兼容性修复** — 修复一批在 Windows 上跑测试的兼容性问题。

## 安装

### 单文件可执行文件（推荐）

从 [GitHub Releases](https://github.com/Yorha9e/oh-my-kimi-code/releases) 下载对应平台的压缩包，解压即用，**无需 Node.js 或构建步骤**：

| 平台 | Release 产物 |
| --- | --- |
| Windows x64 / ARM64 | `omkc-win32-x64.zip` / `omkc-win32-arm64.zip` |
| macOS Intel / Apple Silicon | `omkc-darwin-x64.zip` / `omkc-darwin-arm64.zip` |
| Linux x64 / ARM64 | `omkc-linux-x64.zip` / `omkc-linux-arm64.zip` |

```powershell
# Windows 示例
Expand-Archive .\omkc-win32-x64.zip -DestinationPath C:\tools\omkc
C:\tools\omkc\omkc.exe --version
```

```bash
# macOS / Linux 示例
unzip omkc-linux-x64.zip -d ~/tools/omkc && chmod +x ~/tools/omkc/omkc
```

把解压目录加入 `PATH`（或起个别名），在任意项目文件夹敲 `omkc` 启动。每个 zip 附带 `.sha256` 校验文件，Release 中的 `manifest.json` 汇总了全部平台的校验和。macOS / Linux 产物未经代码签名，首次运行被系统拦截时：macOS 右键打开，或 `xattr -d com.apple.quarantine omkc`。

首次启动检测到官方 `kimi` 的数据目录时会自动完成迁移（复制不移动、无需重新登录），见[首次启动与迁移](#首次启动与迁移)。

### 更新

omkc 启动时会在后台检查社区 [GitHub Releases](https://github.com/Yorha9e/oh-my-kimi-code/releases) 的最新版本（检查失败/限流时静默跳过，不影响使用）。发现新版本时会提示当前版本 → 目标版本、检测到的安装形态和对应动作：

- **macOS / Linux（SEA 单文件）**：`tui.toml` 里 `[upgrade] auto_install = true` 时自动下载、SHA-256 校验并替换，下次启动生效；为 `false` 时显示手动指引
- **Windows（SEA 单文件）**：运行中的 exe 无法被覆盖，显示手动指引，按下面的「Windows 手动更新」操作（约 1 分钟）
- **任意形态**：TUI 里随时可敲 `/upgrade` 手动触发检查与更新

更新源默认为 `Yorha9e/oh-my-kimi-code`，可用环境变量 `OMKC_UPDATE_REPO` 覆盖（例如指向 fork 测试仓）。

#### Windows 手动更新

利用「Windows 允许重命名运行中的 exe」的特性，**无需关闭 omkc**：

```powershell
# 1. 从 Release 下载 omkc-win32-x64.zip 并解压（浏览器或 gh CLI 均可）
gh release download oh-my-kimi-code@<新版本> --repo Yorha9e/oh-my-kimi-code -p "omkc-win32-x64.zip" --clobber
Expand-Archive .\omkc-win32-x64.zip -DestinationPath .\omkc-new -Force

# 2.（可选）校验：certutil -hashfile omkc-win32-x64.zip SHA256 与 .sha256 文件比对

# 3. 旧 exe 改名留作回滚备份，新 exe 放入原位（路径换成你的 omkc.exe 所在目录）
mv "$env:APPDATA\npm\omkc.exe" "$env:APPDATA\npm\omkc.exe.bak"
cp .\omkc-new\omkc.exe "$env:APPDATA\npm\omkc.exe"

# 4. 新开一个终端验证
omkc --version
```

回滚：删掉新 `omkc.exe`，把 `omkc.exe.bak` 改回 `omkc.exe` 即可；确认无误后 `.bak` 可删。

### 前置要求（仅源码构建）

- Node.js **>= 24.15**（版本不够时 `pnpm install` 会被 `engine-strict` 拦截；临时绕过可把仓库根目录 `.npmrc` 里的 `engine-strict=true` 改为 `false`，用完改回）
- pnpm（`corepack enable` 即可）

#### 升级 Node.js（Windows）

先用 `node -v` 确认当前版本，低于 24.15 时按下面任一方式升级：

**方式 1：官方安装包（推荐，留在 24 线）**

从 [nodejs.org](https://nodejs.org/dist/latest-v24.x/) 下载 24 线最新的 Windows 安装包（`node-v24.x.x-x64.msi`），直接运行即可**覆盖升级**，全局已装的 pnpm、npm 全局包都会保留。

**方式 2：winget（只能跟 Current 线，慎选）**

```powershell
winget install OpenJS.NodeJS          # 装的是 Current 线（如 26.x），主版本跨越大
```

注意：winget 源**没有 24 线的包**（按大版本拆分的 id 只到 `OpenJS.NodeJS.23`，通用的 `OpenJS.NodeJS` 是 Current 线）。另外 `winget upgrade` 可能报"找不到与输入条件匹配的已安装程序包"——这说明现有 Node 的注册 id 与实际版本不一致（例如注册为 `OpenJS.NodeJS.22` 实际已是 24.x），这时别用 winget，走方式 1。

**方式 3：版本管理器（需要在多个 Node 版本间切换时）**

用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 或 [fnm](https://github.com/Schniz/fnm) 安装管理多个版本，例如 fnm：`fnm install 24 && fnm use 24`。

升级后重开终端，确认：

```bash
node -v          # 应 >= 24.15.0
corepack enable  # 如 pnpm 失效，重新启用
```

之后 `pnpm install` 就不再需要绕过 `engine-strict` 了。

### 构建并全局安装（源码方式）

```bash
git clone https://github.com/Yorha9e/oh-my-kimi-code.git
cd oh-my-kimi-code

pnpm install
pnpm -C apps/kimi-code run build

cd apps/kimi-code
npm pack                                    # 生成 oh-my-kimi-code-<version>.tgz
npm install -g ./oh-my-kimi-code-0.29.0-omkc.1.tgz

omkc --version
```

之后在任意项目文件夹敲 `omkc` 启动。升级：`git pull --ff-only` 后重跑上面的构建与安装步骤。卸载：`npm rm -g oh-my-kimi-code`。

> Kimi Code 的工作目录跟随**启动时所在的文件夹**：在哪个项目里启动 `omkc`，就操作哪个项目。

### 免安装直接跑（试用 / 开发）

```bash
cd /path/to/你的项目
node /path/to/oh-my-kimi-code/apps/kimi-code/dist/main.mjs
```

可以起个别名（Git Bash 写进 `~/.bashrc`）：

```bash
alias omkc-dev='node /path/to/oh-my-kimi-code/apps/kimi-code/dist/main.mjs'
```

更新时重新构建即可，所有项目立刻用上新构建：

```bash
git pull --ff-only && pnpm install && pnpm -C apps/kimi-code run build
```

注意：`git pull` 拉取的是**本社区仓库的更新**；官方发布新版后不会自动出现在这里，需要先走[开发说明](#开发说明)里的上游同步流程。

## 首次启动与迁移

首次启动 `omkc` 时，如果检测到官方目录 `~/.kimi-code` 存在，会自动把用户数据**复制**进 `~/.omkc`：

- **复制的内容**：`config.toml`、`tui.toml`、`mcp.json` 等配置；`credentials`（OAuth 凭据为明文文件，复制后**免登录**）；会话数据与索引；`skills`、`plugins`、`themes`；输入历史；托管工具（`rg` / `fd` / `moa-card`）
- **复制不移动**：官方目录原封不动，官方版 `kimi` 照常使用；迁移也从不覆盖 `~/.omkc` 里已存在的文件，不阻塞启动
- **自动调整**：`session_index` 中的路径前缀自动重写指向新目录；`device_id` 重新生成（社区版使用独立设备身份）
- **跳过迁移**：在 `~/.kimi-code` 下放一个 `.skip-migration-to-omkc` 文件即可；迁移完成后目标目录会出现 `.migrated-from-kimi-code` 标记，不会重复迁移
- **增量同步**：首启迁移只做一次。之后随时可以在 TUI 里运行 `/sync-from-kimi`，把官方目录里新增或更新的数据增量同步过来——文件按 mtime 新者覆盖（omkc 里更新的文件不会被盖掉），`session_index` 按 `sessionId` 去重合并。同步期间建议先退出官方 `kimi`，避免复制到写入一半的文件

## 与官方版并存的注意事项

- **refresh_token 轮换**：两边的凭据源自同一份 OAuth 文件，共用同一个 `refresh_token`。任一方触发 token 刷新后，另一方持有的旧 token 可能失效，届时需要在失效的一方重新 `/login`。
- **项目级 `.kimi-code/` 目录仍然共享**：工作区配置（含子代理绑定所在的 `.kimi-code/local.toml`）放在项目目录里，官方与社区版读取同一份。这是有意为之——绑定配置在两个版本间通用。
- **home 目录互不影响**：`~/.kimi-code` 与 `~/.omkc` 迁移后即分家，此后各自的会话、配置修改互不可见。

## 常用命令对照

| 场景 | 官方版 | 社区版 |
| --- | --- | --- |
| 启动 | `kimi` | `omkc` |
| 数据目录 | `~/.kimi-code` | `~/.omkc`（`OMKC_HOME` > `KIMI_CODE_HOME`） |
| 版本 | `kimi --version` | `omkc --version` |
| Web UI | `kimi web` | `omkc web` |
| IDE / ACP | `kimi acp` | `omkc acp` |
| 诊断 | `kimi doctor` | `omkc doctor` |
| 会话导出 | `kimi export` | `omkc export` |

TUI 内的 slash 命令与官方版一致，另加社区版新增命令。

## Slash 命令速查

在 TUI 输入框敲 `/` 即弹出命令补全，随输入实时过滤；`Enter` 执行。部分命令仅在空闲状态可用（流式输出中先按 `Esc` 中断）。

| 分类 | 命令 | 作用 |
| --- | --- | --- |
| 账号与模型 | `/login` `/logout` | 登录 / 清除凭据 |
| | `/model` | 切换当前会话模型 |
| | `/provider` | 管理供应商 |
| | `/settings`（`/config`） | 设置面板（含子代理绑定批量编辑） |
| | `/experiments` | 实验功能开关面板 |
| | `/permission` | 切换权限模式 |
| 会话管理 | `/new`（`/clear`） | 开新会话 |
| | `/sessions`（`/resume`） | 浏览/恢复历史会话 |
| | `/fork` | 复制当前会话开分支 |
| | `/tasks` | 后台任务列表面板 |
| | `/compact [指令]` | 压缩上下文 |
| | `/undo [条数]` | 撤销最近的提示词 |
| | `/export-md [路径]` | 导出会话为 Markdown |
| | `/init` | 分析代码库生成 `AGENTS.md` |
| | `/web` | 在 Web UI 打开当前会话 |
| 运行模式 | `/plan on\|off` | Plan 模式 |
| | `/yolo on\|off` | 跳过工具审批（慎用） |
| | `/auto on\|off` | 自动权限模式 |
| | `/swarm <任务>` | swarm 模式执行批量子代理任务 |
| | `/goal <目标>` | 目标模式（自动续跑直至完成） |
| 信息查询 | `/help` | 全部命令与快捷键 |
| | `/usage` | token 用量与配额 |
| | `/status` | 版本、模型、工作目录等 |
| | `/mcp` | MCP server 连接状态 |
| | `/exit`（`/q`） | 退出 |
| 社区版新增 | `/subagent-model [list]` | 查看子代理模型绑定（Types / Slots 两节） |
| | `/subagent-model set <type>` / `set slot <name>` | 为类型或命名槽位绑定模型与思考强度 |
| | `/subagent-model clear <type>` / `clear slot <name>` | 移除绑定 |
| | `/sync-from-kimi` | 从官方 `~/.kimi-code` 增量同步数据到 `~/.omkc`（可反复执行） |

类型绑定示例（写入工作区 `.kimi-code/local.toml`）：

```toml
[subagent.explore]
model = "kimi-code/kimi-for-coding"
thinking_effort = "high"
```

Skill 命令：外部 Skill 自动注册为 `/skill:<name>`（或未占用时可直接 `/<name>`）；内置 Skill 命令开箱即用（`/update-config`、`/check-kimi-code-docs` 等）。

完整命令表见上游文档 [Slash 命令参考](https://moonshotai.github.io/kimi-code/zh/reference/slash-commands)（官方文档以 `kimi` 命令为例，行为与 `omkc` 一致）。

## 开发说明

环境要求：Node.js ≥ 24.15.0，pnpm 10.33.0。

- **分支结构**：`main` 即社区版本身（旧的「`main` 与官方一致 + 实验特性放 `feat/subagent-model-binding` 分支」结构已废弃，全部特性已并入 `main` 且默认开启）
- 本地开发常用命令：

```sh
pnpm dev:cli    # 以开发模式运行 CLI
pnpm test       # 运行测试
pnpm typecheck  # TypeScript 检查
pnpm lint       # 运行 oxlint
pnpm build      # 构建所有包
```

### 上游同步流程

```bash
git remote add upstream https://github.com/MoonshotAI/kimi-code.git   # 只需一次
git fetch upstream --tags
git rebase upstream/main       # main 跟进官方
pnpm install && pnpm run typecheck && pnpm test
```

完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License 与致谢

- **License**：[MIT](LICENSE)，与上游一致
- **Upstream**：本 fork 的全部基础能力来自 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)，感谢 Moonshot AI 团队的开源工作
- TUI 构建在 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上，感谢 `pi-tui` 作者的工作
