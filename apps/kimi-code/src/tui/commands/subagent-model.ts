import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';

const INHERIT_VALUE = '__inherit__';

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
    if (entries.length === 0 && slotEntries.length === 0) {
      host.showStatus(
        'No subagent model bindings in this workspace.\n' +
          'Use /subagent-model set <type> or /subagent-model set slot <name> to bind a model, ' +
          'or spawn a subagent to be asked once.',
      );
      return;
    }
    const lines = ['Subagent model bindings (workspace):'];
    if (entries.length > 0) {
      lines.push('  Types:');
      for (const [type, binding] of entries) {
        lines.push(`    ${type}: ${formatBinding(binding)}`);
      }
    }
    if (slotEntries.length > 0) {
      lines.push('  Slots:');
      for (const [slot, binding] of slotEntries) {
        lines.push(`    ${slot}: ${formatBinding(binding)}`);
      }
    }
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
    const aliases = Object.keys(host.state.appState.availableModels).toSorted();
    if (aliases.length === 0) {
      host.showError('No models configured. Run /login or /provider first.');
      return;
    }
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: `Bind model for ${targetLabel}`,
        hint: '↑↓ navigate · Enter confirm · Esc cancel',
        options: [
          {
            value: INHERIT_VALUE,
            label: 'Keep inheriting from the main agent',
          },
          ...aliases.map((alias) => ({ value: alias, label: alias })),
        ],
        onSelect: (value) => {
          if (value === INHERIT_VALUE) {
            host.restoreEditor();
            void persistBinding(host, isSlot, name, { inherit: true });
            return;
          }
          void pickThinkingEffort(host, isSlot, name, value);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
    return;
  }

  host.showError('Usage: /subagent-model [list] | set [slot] <name> | clear [slot] <name>');
}

function formatBinding(binding: {
  model?: string;
  thinkingEffort?: string;
  inherit?: boolean;
}): string {
  if (binding.inherit === true) return 'inherit from main agent';
  const parts = [binding.model ?? 'inherit model'];
  if (binding.thinkingEffort !== undefined) parts.push(`thinking ${binding.thinkingEffort}`);
  return parts.join(', ');
}

async function pickThinkingEffort(
  host: SlashCommandHost,
  isSlot: boolean,
  name: string,
  model: string,
): Promise<void> {
  const supportEfforts =
    host.state.appState.availableModels[model]?.supportEfforts?.filter(
      (effort) => effort.length > 0,
    ) ?? [];
  const targetLabel = isSlot ? `slot "${name}"` : `subagent "${name}"`;
  if (supportEfforts.length === 0) {
    host.restoreEditor();
    await persistBinding(host, isSlot, name, { model });
    return;
  }
  host.restoreEditor();
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Thinking effort for ${targetLabel} on ${model}`,
      hint: '↑↓ navigate · Enter confirm · Esc skip (inherit effort)',
      options: [
        { value: INHERIT_VALUE, label: 'Inherit the main agent thinking effort' },
        ...supportEfforts.map((effort) => ({ value: effort, label: effort })),
      ],
      onSelect: (value) => {
        host.restoreEditor();
        void persistBinding(
          host,
          isSlot,
          name,
          value === INHERIT_VALUE ? { model } : { model, thinkingEffort: value },
        );
      },
      onCancel: () => {
        host.restoreEditor();
        void persistBinding(host, isSlot, name, { model });
      },
    }),
  );
}

async function persistBinding(
  host: SlashCommandHost,
  isSlot: boolean,
  name: string,
  binding: { model?: string; thinkingEffort?: string; inherit?: boolean },
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
      `${targetLabel} binding: ${formatBinding(binding)}\nSaved to:\n  ${result.configPath}`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
