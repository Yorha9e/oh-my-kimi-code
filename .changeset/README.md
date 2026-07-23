# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to record user-visible changes. The community fork does **not publish to npm**: releases are native single-file executables published to GitHub Releases, and versions are bumped manually (see [Community release flow](#community-release-flow)). Changesets serve as the per-release change records used when writing changelog entries.

## Package selection

This repository uses an **independent, manually-selected** strategy. When generating a changeset, only select the packages that this change actually affects. The repository's `.changeset/config.json` already filters out internal workspace packages via `ignore`, so only the packages listed below should appear in the `pnpm changeset` prompt.

Current user-facing packages:

| Package | Directory | Description |
| --- | --- | --- |
| `oh-my-kimi-code` | `apps/kimi-code` | CLI / TUI application — provides the `omkc` command. Not published to npm; shipped as native executables via GitHub Releases |
| `@moonshot-ai/kimi-code-sdk` | `packages/node-sdk` | Public TypeScript SDK (upstream package name retained) |

All other workspace packages are private internal packages and are excluded via `ignore` in `.changeset/config.json`:

- `@moonshot-ai/acp-adapter`
- `@moonshot-ai/agent-core`
- `@moonshot-ai/kaos`
- `@moonshot-ai/kimi-code-oauth`
- `@moonshot-ai/kimi-telemetry`
- `@moonshot-ai/kimi-web`
- `@moonshot-ai/kosong`
- `@moonshot-ai/migration-legacy`
- `@moonshot-ai/protocol`
- `@moonshot-ai/vis`
- `@moonshot-ai/vis-server`
- `@moonshot-ai/vis-web`

Version impact from internal dependencies must be judged manually. The shipped CLI and SDK artifacts bundle internal workspace packages into the artifact itself; runtime `dependencies` of shipped packages must not include any `@moonshot-ai/*` internal workspace packages.

Example scenarios:

| Change | Changeset selection |
| --- | --- |
| Only modifies TUI behavior in `oh-my-kimi-code` | Add `patch` / `minor` / `major` to `oh-my-kimi-code` |
| Only modifies internal packages, no user-visible change in SDK / CLI | Usually no changeset needed |
| Internal package fix changes the CLI user experience | Add a changeset to `oh-my-kimi-code` describing the user-visible fix |
| Internal package adds a new capability exposed by the SDK | Add a changeset to `@moonshot-ai/kimi-code-sdk` |
| SDK behavior change affects CLI user experience | Add changesets to both `@moonshot-ai/kimi-code-sdk` and `oh-my-kimi-code` |
| Provider abstraction change affects SDK / CLI | Add changesets to the affected `@moonshot-ai/kimi-code-sdk` and/or `oh-my-kimi-code` |
| Test-only, internal refactor, docs, or private debug tooling changes | Usually no changeset needed |
| Bundled official plugin change under `plugins/` (e.g. `kimi-datasource`) | No changeset — the plugin is versioned via its own `kimi.plugin.json` / `plugins/marketplace.json` and shipped through the marketplace CDN, not with the CLI release artifact |

## Development Workflow

### 1. Implement the feature or fix

Complete code, tests, and documentation changes as usual. A changeset is required when the change affects user-visible behavior, public API, dependency ranges, or release artifacts of a user-facing package.

### 2. Generate a changeset

From the repository root:

```sh
pnpm changeset
```

Follow the prompts to choose:

- Which user-facing packages this change affects;
- The version bump level:
  - `patch`: bug fixes, small changes, follow-up dependency updates;
  - `minor`: backward-compatible new features;
  - `major`: breaking changes;
- A user-facing description of the change.

The command creates a `.changeset/*.md` file that must be committed alongside the code.

### 3. Commit the changeset

```sh
git add .changeset/
git commit -m "chore: add changeset for package release"
```

Commit messages must follow Conventional Commit style. Do not include any author/agent identity in the commit message.

## Community release flow

The community fork does not use changesets' version/publish machinery, and nothing is published to npm:

- `.github/workflows/release-native.yml` builds single-file native executables (SEA) for six platforms and publishes them to GitHub Releases. Pushing a tag `oh-my-kimi-code@x.y.z` publishes a stable release; a manual `workflow_dispatch` (version input) publishes a prerelease. Assets per platform: `omkc-<target>.zip` + `.zip.sha256` + an aggregated `manifest.json`.
- Versions follow the community scheme `<upstream-baseline>-omkc.<iteration>` (for example `0.29.0-omkc.1`), maintained manually in `apps/kimi-code/package.json`; `changeset version` and `changeset publish` are not run.
- Consumed changesets are the source material for the release's changelog entries and are removed when the release notes are written.

## Notes

- Every PR that affects user-facing-package behavior or public API should include a corresponding changeset.
- Changes under `plugins/` (the bundled official plugins such as `kimi-datasource`) do **not** need a changeset: each plugin carries its own version in `kimi.plugin.json` and `plugins/marketplace.json` and is distributed via the marketplace CDN, separately from the `oh-my-kimi-code` release artifact.
- Changeset files must be committed to the repository.
- Do not add release changesets for private internal packages; only select `oh-my-kimi-code` and `@moonshot-ai/kimi-code-sdk`.
- If a change in an underlying internal package alters user-visible behavior or public API of a user-facing package, add a changeset to the affected package. For example, when a bug fixed in `@moonshot-ai/agent-core` resolves an issue CLI users encounter, add a changeset to `oh-my-kimi-code` describing the user-visible fix.
- `oh-my-kimi-code` is the community CLI package name; after install it provides the `omkc` command.

## References

- [Changesets documentation](https://github.com/changesets/changesets)
