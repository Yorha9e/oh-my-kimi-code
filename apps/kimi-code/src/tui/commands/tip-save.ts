import type { Event, Session } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * The one-shot prompt sent to the tip-save child after it has been forked.
 * The child inherits the full main context, so the prompt does not restate
 * the discussion — it only carries the task, the moamcp field spec, and the
 * workspace path the child must pass verbatim to `moa_tip_create`.
 * `extra` is the optional `/tip-save <补充说明>` argument.
 */
export function buildTipSaveChildPrompt(workspace: string, extra?: string): string {
  const lines = [
    'You are a background summarizer forked from the main conversation. You inherited the full discussion context — do not ask the user anything and do not restate the discussion.',
    '',
    'Task: analyze the inherited discussion and extract the 1-3 most valuable feature ideas / design conclusions worth remembering across sessions. For each one, call the moa_tip_create MCP tool with:',
    `- workspace: ${workspace} (absolute path, pass verbatim)`,
    '- title: short and specific',
    '- summary: a few sentences — the goal and expected value',
    '- context: the background (a few KiB at most; do NOT copy the whole conversation)',
    '- status: "captured"',
    '- module / tags: sensible values for this project',
    '- documentRefs / sourceRefs / relatedTipIds: when applicable (documentRefs are relative to the project root)',
    'The user explicitly invoked /tip-save, which counts as confirmation for the "confirm before saving" rule — save directly, without asking.',
    '',
    'Notes:',
    '- Save only durable feature ideas / design conclusions; skip one-shot instructions, large code blocks, and casual chat.',
    '- Skip ideas already covered by an existing tip; quality over quantity.',
    '- When done, reply with a short plain-text report: for each saved tip, its id and title, e.g. "Saved 2 tips:\\n- <id>: <title>". Respond with text only; no need to narrate tool calls.',
  ];
  if (extra !== undefined && extra.length > 0) {
    lines.push('', `Additional instructions from the user: ${extra}`);
  }
  return lines.join('\n');
}

/**
 * Watch the tip-save child's event stream and surface its outcome with
 * `showNotice`: the accumulated plain-text report on a completed turn, or a
 * failure/cancel notice otherwise. Deliberately silent in between — no panel,
 * no transcript entries — the child's deltas are swallowed by the subagent
 * event router anyway (unknown child agent ids render nothing).
 *
 * Once the turn is over the child has served its one-shot purpose and is
 * released via `session.disposeAgent` (best-effort; the v2 engine already
 * reclaims the child itself on `turn.ended`, this is the v1 engine's path
 * and an idempotent backstop everywhere).
 */
function watchTipSaveChild(
  host: SlashCommandHost,
  session: Session,
  agentId: string,
): { dispose(): void } {
  let report = '';
  let done = false;
  const unsubscribe = session.onEvent((event: Event) => {
    if (done || event.agentId !== agentId) return;
    if (event.type === 'assistant.delta') {
      report += event.delta;
      return;
    }
    if (event.type === 'turn.ended') {
      unsubscribe();
      done = true;
      const shortId = agentId.slice(0, 8);
      if (event.reason === 'completed') {
        const text = report.trim();
        host.showNotice(
          'TipSave finished',
          text.length > 0 ? text : `side agent ${shortId} completed without a report`,
        );
      } else if (event.reason === 'cancelled') {
        host.showNotice('TipSave cancelled', `side agent ${shortId} was interrupted`);
      } else {
        host.showNotice(
          'TipSave failed',
          event.error !== undefined
            ? `[${event.error.code}] ${event.error.message}`
            : `turn ended with reason: ${event.reason}`,
        );
      }
      void session.disposeAgent(agentId).catch(() => {});
    }
  });
  return {
    dispose(): void {
      if (!done) {
        done = true;
        unsubscribe();
      }
    },
  };
}

/**
 * `/tip-save [补充说明]` — summarize the current discussion into moamcp
 * Project Tips via a cheap forked side agent. The main conversation is not
 * touched: the child runs its own turn in the background and the report
 * arrives as a notice.
 */
export async function handleTipSaveCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  const extra = args.trim();

  let agentId: string;
  try {
    agentId = await session.startTipSave();
  } catch (error) {
    host.showError(`Failed to start /tip-save: ${formatErrorMessage(error)}`);
    return;
  }

  const shortId = agentId.slice(0, 8);
  host.showNotice(
    'TipSave started in background',
    `side agent ${shortId} is summarizing this discussion into Project Tips`,
  );
  const watcher = watchTipSaveChild(host, session, agentId);

  const prompt = buildTipSaveChildPrompt(session.workDir, extra);
  void host.harness
    .withInteractiveAgent(agentId, () => session.prompt(prompt))
    .catch((error: unknown) => {
      watcher.dispose();
      // The child never ran a turn, so no `turn.ended` will reclaim it —
      // release it here instead (best-effort, idempotent on both engines).
      void session.disposeAgent(agentId).catch(() => {});
      host.showError(`Failed to start /tip-save: ${formatErrorMessage(error)}`);
    });
}
