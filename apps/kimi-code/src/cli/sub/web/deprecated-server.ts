/**
 * Deprecated `kimi server` shim.
 *
 * The `kimi server` command tree was replaced by `kimi web` (a foreground
 * server opened in the browser). Any `kimi server …` invocation — bare or
 * with any legacy subcommand/flags — lands here, prints the deprecation
 * notice, and exits 1. The shim itself is scheduled for removal in the next
 * major version of Kimi Code.
 *
 * One subcommand stays functional: `kimi server kill`, the cleanup path for
 * background servers started by pre-0.28.0 builds (recorded in the legacy
 * single-instance lock, which the instance registry never sees).
 */

import type { Command } from 'commander';

import { CLI_COMMAND_NAME, PRODUCT_NAME } from '#/constant/app';

import { registerLegacyKillCommand } from './legacy-kill';

export const DEPRECATED_SERVER_NOTICE =
  `\`${CLI_COMMAND_NAME} server\` has been deprecated and no longer works.\n` +
  `Use \`${CLI_COMMAND_NAME} web\` instead — it runs the local server in the foreground and opens the web UI (\`--no-open\` to skip).\n` +
  `To stop a server started by a version before 0.28.0, use \`${CLI_COMMAND_NAME} server kill\`.\n` +
  `This notice will be removed in the next major version of ${PRODUCT_NAME}.\n`;

export function registerDeprecatedServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description(`Deprecated — use \`${CLI_COMMAND_NAME} web\` instead.`)
    // Swallow every legacy subcommand/flag (`run`, `kill`, `--port`, …) so
    // they all land in the same notice instead of a commander parse error.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      process.stderr.write(DEPRECATED_SERVER_NOTICE);
      process.exit(1);
    });
  registerLegacyKillCommand(server);
}
