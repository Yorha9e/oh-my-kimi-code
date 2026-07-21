# kimi-code 个人 fork · 使用教程

这是 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 的个人 fork。

- `main` 与官方版本完全一致（当前为 **0.28.0**），仅额外包含本说明文档
- 实验功能「子代理模型绑定」在 [`feat/subagent-model-binding`](https://github.com/Yorha9e/kimi-code/tree/feat/subagent-model-binding) 分支，对应上游 [PR #1928](https://github.com/MoonshotAI/kimi-code/pull/1928) / [Issue #1927](https://github.com/MoonshotAI/kimi-code/issues/1927)，功能说明见 [SUBAGENT-MODEL-BINDING.md](./SUBAGENT-MODEL-BINDING.md)

## 前置要求

- Node.js **>= 24.15**（版本不够时 `pnpm install` 会被 `engine-strict` 拦截；临时绕过可把仓库根目录 `.npmrc` 里的 `engine-strict=true` 改为 `false`，用完改回）
- pnpm（`corepack enable` 即可）

### 升级 Node.js（Windows）

先用 `node -v` 确认当前版本，低于 24.15 时按下面任一方式升级：

**方式 1：winget（推荐，一条命令）**

```powershell
winget upgrade OpenJS.NodeJS          # Current 线
# 或装 LTS 线：
winget upgrade OpenJS.NodeJS.LTS
```

**方式 2：官方安装包**

从 [nodejs.org](https://nodejs.org/) 下载 >= 24.15 的 Windows 安装包（.msi），直接运行即可**覆盖升级**，全局已装的 pnpm、npm 全局包都会保留。

**方式 3：版本管理器（需要在多个 Node 版本间切换时）**

用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 或 [fnm](https://github.com/Schniz/fnm) 安装管理多个版本，例如 fnm：`fnm install 24 && fnm use 24`。

升级后重开终端，确认：

```bash
node -v          # 应 >= 24.15.0
corepack enable  # 如 pnpm 失效，重新启用
```

之后 `pnpm install` 就不再需要绕过 `engine-strict` 了。

## 一、构建临时产物

```bash
git clone https://github.com/Yorha9e/kimi-code.git
cd kimi-code

# 二选一：
#   官方原版：停在 main 即可
#   实验版（子代理模型绑定）：
git checkout feat/subagent-model-binding

pnpm install
pnpm -C apps/kimi-code run build
```

产物只有一样东西：`apps/kimi-code/dist/main.mjs`（入口文件，外加同目录的配套资源）。它是纯文件，不污染系统，删掉目录即完成"卸载"。

## 二、在其他项目文件夹使用

Kimi Code 的工作目录跟随**启动时所在的文件夹**，所以在哪个项目里启动，就操作哪个项目。

### 方式 A：免安装直接跑（推荐，真正的"临时"产物）

```bash
cd /path/to/你的项目
node /path/to/kimi-code/apps/kimi-code/dist/main.mjs
```

更新时重新构建即可，所有项目立刻用上新构建：

```bash
git pull --ff-only && pnpm install && pnpm -C apps/kimi-code run build
```

注意：`git pull` 拉取的是**你的 fork（社区版）的更新**。官方发布新版后不会自动出现在这里——需要先按[第四节](#四与官方保持同步维护流程)把官方更新同步进 fork 并推送，然后 `git pull` 才能拿到。（如果刚对当前分支做过 force-push，`git pull --ff-only` 失败时用 `git fetch && git reset --hard origin/$(git branch --show-current)` 对齐。）

可以给自己起个别名（Git Bash 写进 `~/.bashrc`）：

```bash
alias kimi-dev='node /d/vscode/kimisubagentexplore/kimi-code/apps/kimi-code/dist/main.mjs'
```

### 方式 B：打包后全局安装

```bash
cd /path/to/kimi-code/apps/kimi-code
npm pack                          # 生成 moonshot-ai-kimi-code-0.28.0.tgz
npm install -g ./moonshot-ai-kimi-code-0.28.0.tgz
```

之后在任意项目文件夹直接 `kimi` 启动。注意：

- 它和官方包 `npm i -g @moonshot-ai/kimi-code` 共用 `kimi` 命令，**后装的覆盖先装的**；想切回官方版就 `npm i -g @moonshot-ai/kimi-code@latest`
- 更新：重新 build + pack + `npm install -g` 新 tgz
- 卸载：`npm rm -g @moonshot-ai/kimi-code`

### 方式 C：`npm link` 直接接管 `kimi` 命令（⛔ 非常非常不建议）

> **注意：本方式是过渡形态，随时会变。** 后续计划给 fork 改用**独立的呼出命令名**（不再占用官方 `kimi`）和**与官方区分的版本号**（如 `0.28.0-fork.1` 之类），届时本节的做法会整个作废。在改动落地之前，请把 `npm link` 视为临时 hack，**非常非常不建议使用**。

```bash
cd /path/to/kimi-code/apps/kimi-code
npm run build        # 确保 dist/main.mjs 已构建
npm link             # 把全局 kimi 软链到本仓库的产物
```

之后任何文件夹敲 `kimi` 走的就是这个 fork 的构建，且每次重新 build 后自动生效，无需重装。撤销：`npm rm -g @moonshot-ai/kimi-code`，再装回官方版。

**为什么不建议：**

- 它会**静默顶掉官方 `kimi`**——之后你根本无法从命令本身分辨跑的是官方版还是 fork 版，`kimi --version` 显示的版本号还和官方一样（都是 0.28.0），出问题时极易误判（这正是后续要改独立命令名和独立版本号的原因）
- 官方发新版后 `npm i -g @moonshot-ai/kimi-code@latest` 升级的是官方包，但 `kimi` 仍指向你的仓库——你以为升级了，实际没有
- 仓库目录一旦被移动、重命名或删除，全局 `kimi` 直接变成死链
- 排查官方 bug / 给上游提 issue 时，必须在官方产物上复现，链接状态下很容易拿错环境
- 它是**即将被替换的临时方案**——等独立命令名落地后你还得再改一次习惯，不如一开始就不用

日常请用方式 A（免安装）或方式 B（明确安装/卸载）。

### 启用本 fork 的实验功能（子代理模型绑定）

仅 `feat/subagent-model-binding` 分支的构建有效，且默认关闭，任选一种方式开启：

```bash
# 方式 1：环境变量
KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION=1 node .../dist/main.mjs

# 方式 2：启动后在 TUI 里输入 /experiments，打开 "Subagent model selection"
```

然后在项目根的 `.kimi-code/local.toml` 里按子代理类型绑定模型/思考强度：

```toml
[subagent.explore]
model = "kimi-code/kimi-for-coding"
thinking_effort = "high"
```

TUI 内可随时用 `/subagent-model list|set <type>|clear <type>` 管理绑定。

> 两种运行方式都与正式版 CLI 共享 `~/.kimi-code`（登录、配置、会话互通）。想完全隔离：`KIMI_CODE_HOME=/tmp/kimi-exp node .../dist/main.mjs`（需重新登录）。

## 三、Slash 命令

在 TUI 输入框敲 `/` 即弹出命令补全，随输入实时过滤；`Enter` 执行。输入不匹配任何命令时会按普通消息发给 Agent。部分命令仅在空闲状态可用（流式输出中先按 `Esc` 中断）。

### 常用速查

| 分类 | 命令 | 作用 |
| --- | --- | --- |
| 账号与模型 | `/login` `/logout` | 登录 / 清除凭据 |
| | `/model` | 切换当前会话模型 |
| | `/provider` | 管理供应商 |
| | `/settings`（`/config`） | 设置面板 |
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
| 本 fork 新增 | `/subagent-model` | 管理子代理模型绑定（实验开关打开时） |

### Skill 命令

- 外部 Skill 自动注册为 `/skill:<name>`（或未占用时可直接 `/<name>`），如 `/skill:pdf`
- 内置 Skill 命令开箱即用：`/update-config`、`/custom-theme`、`/mcp-config`、`/check-kimi-code-docs`、`/import-from-cc-codex` 等

完整命令表（含 `/goal` 全部子命令、"流式输出中可用"标注）见 [docs/zh/reference/slash-commands.md](./docs/zh/reference/slash-commands.md)；命令行参数与子命令（`kimi web`、`kimi doctor`、`kimi export` 等）见 [docs/zh/reference/kimi-command.md](./docs/zh/reference/kimi-command.md)。

## 四、与官方保持同步（维护流程）

官方发新版后：

```bash
git fetch origin --tags          # origin = MoonshotAI/kimi-code
git rebase origin/main main      # main 跟进官方
git checkout feat/subagent-model-binding
git rebase origin/main           # 功能分支跟进官方
pnpm install && pnpm run typecheck && pnpm test
git push fork main --force-with-lease
git push fork feat/subagent-model-binding --force-with-lease
```

---

**Upstream**: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) · **License**: Apache-2.0（与上游一致）
