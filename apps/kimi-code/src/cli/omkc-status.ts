/**
 * omkc-status companion launcher.
 *
 * omkc can ship an optional read-only status service at
 * `<dataDir>/bin/omkc-status.exe` (`omkc-status` elsewhere). Interactive
 * startup launches it best-effort, mirroring moa-card: a missing binary or
 * a spawn failure must never block or break the CLI. The service is
 * single-instance guarded on its own side too (a duplicate start reads its
 * discovery file and exits 0), but we pre-check here to avoid paying for a
 * doomed spawn on every interactive startup.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getBinDir, getDataDir } from '#/utils/paths';

/**
 * Single-instance pre-check: omkc-status records `{pid, port, started_at}`
 * in `<dataDir>/status/server.json` after binding. When that pid is alive
 * the service is (almost certainly) already up, so skip the spawn.
 * Best-effort by design: any failure (missing/corrupt file, dead pid) falls
 * through to "spawn anyway" and lets the service's own guard arbitrate.
 */
function isStatusAlreadyRunning(): boolean {
  try {
    const raw = readFileSync(join(getDataDir(), 'status', 'server.json'), 'utf8');
    const info = JSON.parse(raw) as { pid?: number };
    if (typeof info.pid !== 'number') return false;
    process.kill(info.pid, 0);
    return true;
  } catch (error) {
    // EPERM from kill(pid, 0): the pid exists but is owned elsewhere —
    // still counts as alive (same rule the service's own guard uses).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function maybeLaunchOmkcStatus(enabled: boolean): void {
  if (!enabled) return;
  const exePath = join(
    getBinDir(),
    process.platform === 'win32' ? 'omkc-status.exe' : 'omkc-status',
  );
  if (!existsSync(exePath)) return;
  if (isStatusAlreadyRunning()) return;
  // Fire-and-forget: detached with ignored stdio so the service never
  // touches the terminal, unref'd so it cannot keep the CLI event loop
  // alive. Spawn errors (e.g. a corrupt binary) are swallowed. We spawn the
  // .exe directly without shell: true, which is only for .cmd shims
  // (CVE-2024-27980).
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: process.platform === 'win32' ? true : undefined,
  });
  child.on('error', () => {});
  child.unref();
}
