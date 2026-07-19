# Preview: per-workspace subagent model bindings

> **Note:** This branch is the source of [MoonshotAI/kimi-code#1928](https://github.com/MoonshotAI/kimi-code/pull/1928) — an experimental feature proposal, **not** an official Kimi Code capability. It is under review and may change substantially. Feedback is very welcome (on the PR, or on issue [#1927](https://github.com/MoonshotAI/kimi-code/issues/1927)).

## What it does

Subagents spawned via the `Agent` tool normally inherit the main agent's model. This branch lets you bind a configured model alias (and thinking effort) to each subagent **type**, **per workspace**:

- Bindings live in `<projectRoot>/.kimi-code/local.toml` under `[subagent.<type>]`:

  ```toml
  [subagent.explore]
  model = "kimi-code/kimi-for-coding"
  thinking_effort = "high"
  ```

- The first time an unbound subagent type is spawned in a workspace, you are asked once whether to bind a model ("keep inheriting" is remembered too)
- `/subagent-model` command (`list` / `set <type>` / `clear <type>`) to manage bindings anytime
- Bindings are applied **mechanically** at spawn — the calling agent (LLM) cannot see or override them
- With the experiment on, resumed subagents always keep their configured model/effort (sticky); with it off, resume realigns to the parent exactly as before
- Effective model/effort is visible in the tool result, approval label, `subagent.spawned` event, and task list

## Design notes

- Model routing is treated as **user configuration, not an LLM decision** — no model directory is exposed to the model, and there is no `model` tool parameter
- Precedence: workspace binding > profile binding (for shipped profiles) > inherit the main agent
- Everything is gated behind the `subagent-model-selection` experiment (**off by default**), so default behavior is unchanged
- `AgentSwarm` batches do not read bindings yet (future work)

## Try it

Requires Node.js ≥ 24.15 and pnpm.

```bash
git clone https://github.com/Yorha9e/kimi-code.git
cd kimi-code
git checkout feat/subagent-model-binding
pnpm install
pnpm -C apps/kimi-code run build        # produces apps/kimi-code/dist/main.mjs
```

Then, from **your own project directory** (the workspace — and its `.kimi-code/local.toml` — follows the current directory):

```bash
cd /path/to/your/project
KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION=1 \
  node /path/to/kimi-code/apps/kimi-code/dist/main.mjs
```

## Will it affect my installed Kimi Code?

No:

- The build artifact is just files executed with `node` — nothing is installed, your existing `kimi` binary is untouched
- The feature is off by default; disabled means byte-for-byte upstream behavior (including resume semantics)
- It shares `~/.kimi-code` (config, credentials, sessions) with your stable CLI — all changes are additive and backward-compatible (binding files in projects are ignored by stable builds; sessions open fine both ways)
- For full isolation, run with a separate home: `KIMI_CODE_HOME=/tmp/kimi-exp node dist/main.mjs` (fresh login required)

## Known limitations

- Covers `Agent` tool subagents only; `AgentSwarm` ignores bindings
- Tested primarily on Windows with a limited set of configurations
- Experimental — design and implementation may change during review

## Status

- Issue: [MoonshotAI/kimi-code#1927](https://github.com/MoonshotAI/kimi-code/issues/1927)
- PR: [MoonshotAI/kimi-code#1928](https://github.com/MoonshotAI/kimi-code/pull/1928)

Comments, bug reports, and design pushback are all appreciated — on the PR or the issue. Thanks for taking a look. 🙏
