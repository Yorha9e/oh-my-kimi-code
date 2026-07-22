/**
 * Shared two-step "model → thinking effort" picker chain for binding a model
 * to a subagent type or named slot. Used both by the `/subagent-model set`
 * command (which persists immediately) and the settings batch-edit panel
 * (which stages a local draft). Neither caller talks to the SDK here; the
 * composed binding is handed back through `onBinding`, and `settle` returns
 * focus to whatever owned the editor slot (the editor or the settings panel).
 */

import type { SubagentBinding } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent, type ChoiceOption } from '#/tui/components/dialogs/choice-picker';

/** Sentinel option value meaning "keep inheriting from the main agent". */
export const SUBAGENT_INHERIT_VALUE = '__inherit__';

/** Models only need to expose their supported thinking efforts to the picker. */
export type SubagentBindingModelLike = {
  readonly supportEfforts?: readonly string[];
};

export interface SubagentBindingPickerParams {
  /** Human-readable target, e.g. `subagent "coder"` or `slot "review"`. */
  readonly targetLabel: string;
  readonly availableModels: Readonly<Record<string, SubagentBindingModelLike>>;
  /** Mount a picker into the owner's editor-replacement slot. */
  readonly mount: (picker: ChoicePickerComponent) => void;
  /** Return focus to the owner once the chain settles (pick or cancel). */
  readonly settle: () => void;
  /** Receives the binding the user composed (never called on plain cancel). */
  readonly onBinding: (binding: SubagentBinding) => void;
}

/** Sorted model aliases, ready to offer as picker options. */
export function subagentModelAliases(
  availableModels: Readonly<Record<string, SubagentBindingModelLike>>,
): string[] {
  return Object.keys(availableModels).toSorted();
}

/** Non-empty thinking efforts a model supports, in declared order. */
export function subagentSupportEfforts(
  availableModels: Readonly<Record<string, SubagentBindingModelLike>>,
  model: string,
): string[] {
  return availableModels[model]?.supportEfforts?.filter((effort) => effort.length > 0) ?? [];
}

/** Renders a binding the way `/subagent-model list` and the settings rows do. */
export function formatSubagentBinding(binding: SubagentBinding): string {
  if (binding.inherit === true) return 'inherit from main agent';
  const parts = [binding.model ?? 'inherit model'];
  if (binding.thinkingEffort !== undefined) parts.push(`thinking ${binding.thinkingEffort}`);
  return parts.join(', ');
}

/**
 * Runs the chained picker: pick a model (or keep inheriting); if the chosen
 * model supports thinking efforts, pick one (or inherit the main effort).
 * The first option at each step is the inherit choice.
 */
export function pickSubagentBinding(params: SubagentBindingPickerParams): void {
  const aliases = subagentModelAliases(params.availableModels);
  const modelOptions: ChoiceOption[] = [
    { value: SUBAGENT_INHERIT_VALUE, label: 'Keep inheriting from the main agent' },
    ...aliases.map((alias) => ({ value: alias, label: alias })),
  ];
  params.mount(
    new ChoicePickerComponent({
      title: `Bind model for ${params.targetLabel}`,
      hint: '↑↓ navigate · Enter confirm · Esc cancel',
      options: modelOptions,
      onSelect: (value) => {
        if (value === SUBAGENT_INHERIT_VALUE) {
          params.onBinding({ inherit: true });
          params.settle();
          return;
        }
        pickThinkingEffort(params, value);
      },
      onCancel: () => {
        params.settle();
      },
    }),
  );
}

function pickThinkingEffort(params: SubagentBindingPickerParams, model: string): void {
  const efforts = subagentSupportEfforts(params.availableModels, model);
  if (efforts.length === 0) {
    params.onBinding({ model });
    params.settle();
    return;
  }
  const effortOptions: ChoiceOption[] = [
    { value: SUBAGENT_INHERIT_VALUE, label: 'Inherit the main agent thinking effort' },
    ...efforts.map((effort) => ({ value: effort, label: effort })),
  ];
  params.mount(
    new ChoicePickerComponent({
      title: `Thinking effort for ${params.targetLabel} on ${model}`,
      hint: '↑↓ navigate · Enter confirm · Esc skip (inherit effort)',
      options: effortOptions,
      onSelect: (value) => {
        params.onBinding(value === SUBAGENT_INHERIT_VALUE ? { model } : { model, thinkingEffort: value });
        params.settle();
      },
      onCancel: () => {
        params.onBinding({ model });
        params.settle();
      },
    }),
  );
}
