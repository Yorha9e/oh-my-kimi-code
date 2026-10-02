# 社区版（oh-my-kimi-code）本地构建与更新流程

> 适用范围：本仓库 `kimi-code-community` 的社区版 CLI `oh-my-kimi-code`。
> 本文是**本地更新**的标准流程——修改源码后让全局安装的 `omkc` 生效。

## 为什么需要这个流程

`omkc` 全局安装的是打包产物（`dist/main.mjs`），**源码改动不会自动生效**。
仓库里的 `dist/main.mjs` 与全局副本 `AppData/Roaming/npm/node_modules/oh-my-kimi-code/dist/main.mjs`
是两份独立的文件，必须显式重新构建并热更。

曾遇到的实际案例：源码已提交（如 cursor modelParams 配置面），但客户端填 `model_params`
不生效——因为全局副本是几周前的旧产物。**只看 `--version` 无法判断产物新旧**（版本号
不变时产物可能已过时），必须 grep 特征符号验证。

## 标准流程（每次源码更新后执行）

```bash
# 1. 重新构建 CLI（tsdown 打包，产物 apps/kimi-code/dist/main.mjs）
pnpm -C apps/kimi-code run build

# 2. 热更全局安装副本（绕开 npm i -g 的 EBUSY/网络问题）
cp apps/kimi-code/dist/main.mjs \
  "C:/Users/Yorha/AppData/Roaming/npm/node_modules/oh-my-kimi-code/dist/main.mjs"

# 3. 验证产物确实包含新代码（用本次改动的特征符号，不要只信 --version）
grep -c "<特征符号>" apps/kimi-code/dist/main.mjs            # 应 >= 1（构建侧）
grep -c "<特征符号>" "C:/Users/Yorha/AppData/Roaming/npm/node_modules/oh-my-kimi-code/dist/main.mjs"  # 应 >= 1（安装侧）
cmp apps/kimi-code/dist/main.mjs \
  "C:/Users/Yorha/AppData/Roaming/npm/node_modules/oh-my-kimi-code/dist/main.mjs" && echo "两份一致"
```

## 特征符号选择原则

- 必须是**新代码引入的独特字符串**，旧产物里不存在
- 不能用 `--version`、不能用旧产物已存在的符号（如 `binding_slot`——会假阳性）
- 示例：本次改动加了 `modelParams` 配置面，可用 `providerOptions?.modelParams` 或
  `model_params` 这类只在新代码出现的字符串

## 生效时机

**正在运行的会话不会热加载新代码**——新功能只在新启动的窗口中生效。
验证时必须开新终端。

## 完整发布流程（如需发新版本号）

1. 上述本地构建 + 热更
2. `git tag` 新版本（如 `v0.38.0-omkc.2`）
3. 触发 release（构建到远端 + npm publish）
4. 用户 `npm i -g oh-my-kimi-code@<新版本>`

发布时注意：`npm pack` 前必须 build（pack 无构建钩子，直接带 dist 走）。
AGENTS.md 原文：*"When packing the CLI for local install or release (`npm pack` in `apps/kimi-code`), always run `pnpm -C apps/kimi-code run build` first"*。

## 相关事实（备忘）

- 全局安装副本路径：`C:/Users/Yorha/AppData/Roaming/npm/node_modules/oh-my-kimi-code/`
- 全局版本当前：`0.38.0-omkc.1`
- 构建脚本：`apps/kimi-code/package.json` 的 `build`（tsdown + dist-worker + native assets 检查）
- EBUSY 场景：`npm i -g` 报 clipboard 文件被占用时，用上面的 cp 热更绕过