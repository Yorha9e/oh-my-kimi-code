# oh-my-kimi-code

> The Starting Point for Next-Gen Agents

[![Release](https://img.shields.io/github/v/release/Yorha9e/oh-my-kimi-code)](https://github.com/Yorha9e/oh-my-kimi-code/releases) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)  [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/)

`oh-my-kimi-code` is a community fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code): the command is `omkc`, it runs from its own data home (`~/.omkc`), and it coexists with the official `kimi` install. See the [repository README](../../README.md) for the full picture (install options, migration, community features).

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

### Native executables (recommended)

Download the archive for your platform from [GitHub Releases](https://github.com/Yorha9e/oh-my-kimi-code/releases) and extract it — no Node.js or build step required:

- Windows: `omkc-win32-x64.zip` / `omkc-win32-arm64.zip`
- macOS: `omkc-darwin-x64.zip` / `omkc-darwin-arm64.zip`
- Linux: `omkc-linux-x64.zip` / `omkc-linux-arm64.zip`

Put the extracted directory on your `PATH`, then in a new terminal:

```sh
omkc --version
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because the CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

### Build from source

Requires Node.js >= 24.15 and pnpm:

```sh
git clone https://github.com/Yorha9e/oh-my-kimi-code.git
cd oh-my-kimi-code
pnpm install
pnpm -C apps/kimi-code run build
node apps/kimi-code/dist/main.mjs
```

The repository README covers global install from the built tarball and upgrades. The community fork is **not published to npm** — `npm install -g @moonshot-ai/kimi-code` installs the official `kimi` CLI, not this fork.

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
omkc
```

On first launch, run `/login` inside the CLI and choose either Kimi Code OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Single-binary distribution.** Download and extract — no Node.js setup, no PATH gymnastics, no global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

Upstream documentation (the command there is `kimi`; behavior matches `omkc` unless noted as a community feature):

- Full docs: https://moonshotai.github.io/kimi-code/en/
- 中文文档: https://moonshotai.github.io/kimi-code/zh/
- Getting Started: https://moonshotai.github.io/kimi-code/en/guides/getting-started

## Repository & Issues

- Source: https://github.com/Yorha9e/oh-my-kimi-code (community fork of https://github.com/MoonshotAI/kimi-code)
- Issues: https://github.com/Yorha9e/oh-my-kimi-code/issues
- Security: see SECURITY.md in the main repository

## License

MIT
