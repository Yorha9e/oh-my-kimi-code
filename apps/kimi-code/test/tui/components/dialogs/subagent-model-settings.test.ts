import type { SubagentBinding } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import {
  SubagentModelSettingsComponent,
  type SubagentModelSettingsChange,
  type SubagentModelSettingsOptions,
} from '#/tui/components/dialogs/subagent-model-settings';

const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

interface Harness {
  panel: SubagentModelSettingsComponent;
  mountPicker: ReturnType<typeof vi.fn<(picker: ChoicePickerComponent) => void>>;
  remount: ReturnType<typeof vi.fn>;
  onApply: ReturnType<typeof vi.fn<(changes: readonly SubagentModelSettingsChange[]) => void>>;
  onCancel: ReturnType<typeof vi.fn>;
}

function makeHarness(
  overrides: Partial<SubagentModelSettingsOptions> = {},
): Harness {
  const mountPicker = vi.fn<(picker: ChoicePickerComponent) => void>();
  const remount = vi.fn();
  const onApply = vi.fn<(changes: readonly SubagentModelSettingsChange[]) => void>();
  const onCancel = vi.fn();
  const panel = new SubagentModelSettingsComponent({
    bindings: {},
    slots: {},
    availableModels: { 'kimi-k2': { supportEfforts: ['low', 'high'] } },
    mountPicker,
    remount,
    onApply,
    onCancel,
    ...overrides,
  });
  return { panel, mountPicker, remount, onApply, onCancel };
}

function text(panel: SubagentModelSettingsComponent, width = 120): string {
  return panel.render(width).map(strip).join('\n');
}

/** Move the cursor down `count` rows (clamped at the last row). */
function moveDown(panel: SubagentModelSettingsComponent, count: number): void {
  for (let i = 0; i < count; i++) panel.handleInput(DOWN);
}

/** Cursor to the Apply row: overshoot down; the list clamps at the last item. */
function goToApply(panel: SubagentModelSettingsComponent): void {
  moveDown(panel, 64);
}

describe('SubagentModelSettingsComponent', () => {
  it('renders bound, inherit, and unbound rows across Types and Slots sections', () => {
    const bindings: Record<string, SubagentBinding> = {
      coder: { model: 'kimi-k2', thinkingEffort: 'high' },
      critic: { inherit: true },
    };
    const slots: Record<string, SubagentBinding> = {
      review: { model: 'kimi-k2' },
    };
    const { panel } = makeHarness({ bindings, slots });
    const out = text(panel);

    expect(out).toContain(' Subagent models');
    expect(out).toContain(' ↑↓ navigate · Enter select · D delete · Esc cancel');
    expect(out).toContain(' Types');
    expect(out).toContain('coder  kimi-k2, thinking high');
    expect(out).toContain('critic  inherit from main agent');
    // explore is a built-in type with no binding.
    expect(out).toContain('explore  not bound');
    expect(out).toContain(' Slots');
    expect(out).toContain('review  kimi-k2');
    expect(out).toContain('[ Apply changes ]  no changes');
  });

  it('moves the cursor with ↑↓', () => {
    const { panel } = makeHarness();
    // coder is the first built-in type alphabetically.
    expect(text(panel)).toContain('  ❯ coder');

    panel.handleInput(DOWN);
    const afterDown = text(panel);
    expect(afterDown).not.toContain('  ❯ coder');
    expect(afterDown).toContain('❯');

    panel.handleInput(UP);
    expect(text(panel)).toContain('  ❯ coder');
  });

  it('opens the two-step picker on Enter and stages a model + effort draft', () => {
    const { panel, mountPicker, remount } = makeHarness();

    // Cursor starts on `coder`; Enter opens the model picker.
    panel.handleInput(ENTER);
    expect(mountPicker).toHaveBeenCalledTimes(1);
    const modelPicker = mountPicker.mock.calls[0]![0];
    expect(modelPicker).toBeInstanceOf(ChoicePickerComponent);
    expect(modelPicker.render(120).map(strip).join('\n')).toContain(
      'Bind model for subagent "coder"',
    );

    // Down to the single model, Enter chains into the effort picker.
    modelPicker.handleInput(DOWN);
    modelPicker.handleInput(ENTER);
    expect(mountPicker).toHaveBeenCalledTimes(2);
    const effortPicker = mountPicker.mock.calls[1]![0];
    expect(effortPicker.render(120).map(strip).join('\n')).toContain(
      'Thinking effort for subagent "coder" on kimi-k2',
    );

    // Down twice to `high`, Enter commits the draft and settles back.
    effortPicker.handleInput(DOWN);
    effortPicker.handleInput(DOWN);
    effortPicker.handleInput(ENTER);
    expect(remount).toHaveBeenCalled();

    expect(text(panel)).toContain('coder  kimi-k2, thinking high · modified');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');
  });

  it('stages an inherit draft when the first picker option is chosen', () => {
    const bindings: Record<string, SubagentBinding> = { coder: { model: 'kimi-k2' } };
    const { panel, mountPicker } = makeHarness({ bindings });

    panel.handleInput(ENTER);
    const modelPicker = mountPicker.mock.calls[0]![0];
    // Cursor starts on "Keep inheriting…"; Enter commits { inherit: true }.
    modelPicker.handleInput(ENTER);

    expect(text(panel)).toContain('coder  inherit from main agent · modified');
  });

  it('stages a model-only draft when the model has no thinking efforts', () => {
    const { panel, mountPicker } = makeHarness({
      availableModels: { 'gpt-5': {} },
    });

    panel.handleInput(ENTER);
    const modelPicker = mountPicker.mock.calls[0]![0];
    modelPicker.handleInput(DOWN);
    modelPicker.handleInput(ENTER);

    // No effort step is mounted for a model without supportEfforts.
    expect(mountPicker).toHaveBeenCalledTimes(1);
    expect(text(panel)).toContain('coder  gpt-5 · modified');
  });

  it('clears a bound row with D and restores it with a second D', () => {
    const bindings: Record<string, SubagentBinding> = { coder: { model: 'kimi-k2' } };
    const { panel } = makeHarness({ bindings });

    panel.handleInput('D');
    expect(text(panel)).toContain('coder  not bound · modified');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');

    panel.handleInput('D');
    expect(text(panel)).toContain('coder  kimi-k2');
    expect(text(panel)).not.toContain('· modified');
    expect(text(panel)).toContain('[ Apply changes ]  no changes');
  });

  it('does not call onApply when applying with an empty draft', () => {
    const { panel, onApply } = makeHarness();

    goToApply(panel);
    panel.handleInput(ENTER);

    expect(onApply).not.toHaveBeenCalled();
  });

  it('reports staged changes in row order when applying', () => {
    const bindings: Record<string, SubagentBinding> = { coder: { model: 'kimi-k2' } };
    const slots: Record<string, SubagentBinding> = { review: { model: 'kimi-k2' } };
    const { panel, mountPicker, onApply } = makeHarness({ bindings, slots });

    // Clear `coder` (first type row).
    panel.handleInput('D');

    // Bind the `review` slot to inherit: navigate to it (after the 6 built-in
    // type rows), then pick the inherit option in the model picker.
    moveDown(panel, 6);
    panel.handleInput(ENTER);
    const modelPicker = mountPicker.mock.calls[0]![0];
    modelPicker.handleInput(ENTER);

    goToApply(panel);
    panel.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith([
      { kind: 'type', name: 'coder', binding: undefined },
      { kind: 'slot', name: 'review', binding: { inherit: true } },
    ]);
  });

  it('discards the draft and cancels on Esc', () => {
    const bindings: Record<string, SubagentBinding> = { coder: { model: 'kimi-k2' } };
    const { panel, onCancel } = makeHarness({ bindings });

    panel.handleInput('D');
    expect(text(panel)).toContain('· modified');

    panel.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
