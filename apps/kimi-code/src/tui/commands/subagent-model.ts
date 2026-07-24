import type { SubagentBinding } from '@moonshot-ai/kimi-code-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import {
  formatSubagentBinding,
  pickSubagentBinding,
  subagentModelAliases,
} from '../utils/subagent-binding-picker';
import type { SlashCommandHost } from './dispatch';

/**
 * `/subagent-model` — manage per-workspace model bindings for subagent types
 * and named binding slots (stored in `.kimi-code/local.toml`, applied
 * mechanically at spawn when the subagent-model-selection experiment is
 * enabled).
 *
 *   /subagent-model [list]            show current type bindings and slots
 *   /subagent-model set <type>        pick a model (and effort) for a subagent type
 *   /subagent-model set slot <name>   pick a model (and effort) for a named slot
 *   /subagent-model clear <type>      remove a type binding
 *   /subagent-model clear slot <name> remove a slot binding
 */
export async function handleSubagentModelCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const [actionRaw, targetRaw, nameRaw] = args.trim().split(/\s+/, 3);
  const action = (actionRaw ?? '').toLowerCase() || 'list';
  const isSlot = (targetRaw ?? '').toLowerCase() === 'slot';
  const name = (isSlot ? (nameRaw ?? '') : (targetRaw ?? '')).trim();
  const targetLabel = isSlot ? `slot "${name}"` : `subagent "${name}"`;

  if (action === 'list') {
    const bindings = await session.getSubagentBindings();
    const slotBindings = await session.getSubagentSlotBindings();
    const entries = Object.entries(bindings);
    const slotEntries = Object.entries(slotBindings);
    const availableModels = host.state.appState.availableModels;
    const lines: string[] = [];
    if (entries.length === 0 && slotEntries.length === 0) {
      lines.push('No subagent model bindings in this workspace.');
    } else {
      lines.push('Subagent model bindings (workspace):');
      if (entries.length > 0) {
        lines.push('  Types:');
        for (const [type, binding] of entries) {
          lines.push(`    ${type}: ${formatSubagentBinding(binding, availableModels)}`);
        }
      }
      if (slotEntries.length > 0) {
        lines.push('  Slots:');
        for (const [slot, binding] of slotEntries) {
          lines.push(`    ${slot}: ${formatSubagentBinding(binding, availableModels)}`);
        }
      }
    }
    // Best-effort: also list the profiles the Agent tool can actually spawn
    // (builtin + user-defined from <home>/agents/*.md). On failure, skip.
    try {
      const profiles = await session.listSubagentProfiles();
      if (profiles.length > 0) {
        lines.push('Available subagent types:');
        for (const profile of profiles) {
          const tag = profile.source === 'user' ? ' (user)' : '';
          lines.push(`  ${profile.name}${tag}`);
        }
      }
    } catch {
      // Older engine without listSubagentProfiles — bindings list above still stands.
    }
    lines.push('Use /subagent-model set <type> or /subagent-model set slot <name> to bind a model.');
    host.showStatus(lines.join('\n'));
    return;
  }

  if (action === 'clear') {
    if (name.length === 0) {
      host.showError('Usage: /subagent-model clear [slot] <name>');
      return;
    }
    try {
      const result = isSlot
        ? await session.setSubagentSlotBinding(name, undefined)
        : await session.setSubagentBinding(name, undefined);
      const clearedLabel = isSlot ? `slot "${name}"` : `"${name}"`;
      host.showStatus(
        `Cleared model binding for ${clearedLabel}.\nSaved to:\n  ${result.configPath}`,
        'success',
      );
    } catch (error) {
      host.showError(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (action === 'set') {
    if (name.length === 0) {
      host.showError('Usage: /subagent-model set [slot] <name>');
      return;
    }
    const availableModels = host.state.appState.availableModels;
    if (subagentModelAliases(availableModels).length === 0) {
      host.showError('No models configured. Run /login or /provider first.');
      return;
    }
    pickSubagentBinding({
      targetLabel,
      availableModels,
      mount: (picker) => {
        host.mountEditorReplacement(picker);
      },
      settle: () => {
        host.restoreEditor();
      },
      onBinding: (binding) => {
        void persistBinding(host, isSlot, name, binding);
      },
    });
    return;
  }

  host.showError('Usage: /subagent-model [list] | set [slot] <name> | clear [slot] <name>');
}

async function persistBinding(
  host: SlashCommandHost,
  isSlot: boolean,
  name: string,
  binding: SubagentBinding,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const targetLabel = isSlot ? `slot "${name}"` : `subagent "${name}"`;
  try {
    const result = isSlot
      ? await session.setSubagentSlotBinding(name, binding)
      : await session.setSubagentBinding(name, binding);
    host.showStatus(
      `${targetLabel} binding: ${formatSubagentBinding(binding)}\nSaved to:\n  ${result.configPath}`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
