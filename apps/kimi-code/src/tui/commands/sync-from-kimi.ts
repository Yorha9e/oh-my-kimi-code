import { runHomeSync, type HomeSyncSummary } from '#/migration/kimi-code-home';

import type { SlashCommandHost } from './dispatch';

/**
 * `/sync-from-kimi` — incrementally sync user data from the official
 * kimi-code home (`~/.kimi-code`) into the omkc home. The first-run
 * migration is one-shot; this command is re-runnable at any time: newer
 * mtime wins per file, omkc's session index is merged (not replaced), and
 * in-flight official writes are skipped. Progress and the final summary are
 * emitted as transcript status lines.
 */
export async function handleSyncFromKimiCommand(host: SlashCommandHost): Promise<void> {
  host.showStatus(
    'Syncing data from the official ~/.kimi-code home into the omkc home ...\n' +
      'Tip: quit the official kimi while syncing so no half-written files are picked up.',
  );
  const outcome = await runHomeSync({ log: (msg) => host.showStatus(msg) });
  switch (outcome.kind) {
    case 'missing-source':
      host.showStatus(`Official home not found at ${outcome.sourceHome} — nothing to sync.`);
      return;
    case 'same-home':
      host.showStatus(
        `The omkc home and the official home resolve to the same path (${outcome.home}) — nothing to sync.`,
      );
      return;
    case 'skipped-by-marker':
      host.showStatus(
        `Skipped: ${outcome.sourceHome} carries a .skip-migration-to-omkc opt-out marker.`,
      );
      return;
    case 'failed':
      // runHomeSync already surfaced the warning through the log callback.
      return;
    case 'synced':
      host.showStatus(formatSyncSummary(outcome.summary), 'success');
      return;
  }
}

function formatSyncSummary(summary: HomeSyncSummary): string {
  return (
    `Sync complete: ${String(summary.copiedFiles)} copied, ` +
    `${String(summary.updatedFiles)} updated, ${String(summary.skippedFiles)} unchanged, ` +
    `${String(summary.keptNewerFiles)} kept (omkc newer), ` +
    `${String(summary.skippedFresh)} skipped as in-flight; ` +
    `session index: ${String(summary.sessionIndexImported)} imported, ` +
    `${String(summary.sessionIndexBadLines)} bad lines dropped.`
  );
}
