import type { SubagentBinding } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import {
  SubagentModelSettingsComponent,
  type SubagentLayer,
  type SubagentModelLayerData,
  type SubagentModelSettingsChange,
} from '#/tui/components/dialogs/subagent-model-settings';

const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const TAB = '\t';
const SHIFT_TAB = `${ESC}[Z`;

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

interface Harness {
  panel: SubagentModelSettingsComponent;
  mountPicker: ReturnType<typeof vi.fn<(picker: ChoicePickerComponent) => void>>;
  remount: ReturnType<typeof vi.fn>;
  onApply: ReturnType<
    typeof vi.fn<(layer: SubagentLayer, changes: readonly SubagentModelSettingsChange[]) => void>
  >;
  onDelete: ReturnType<typeof vi.fn<(layer: SubagentLayer, name: string) => boolean>>;
  onCancel: ReturnType<typeof vi.fn>;
}

interface HarnessOverrides {
  readonly workspace?: SubagentModelLayerData;
  readonly global?: SubagentModelLayerData;
  readonly availableModels?: Readonly<Record<string, { supportEfforts?: readonly string[] }>>;
  readonly subagentProfiles?: readonly string[];
}

const EMPTY_LAYER: SubagentModelLayerData = { bindings: {}, slots: {} };

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const mountPicker = vi.fn<(picker: ChoicePickerComponent) => void>();
  const remount = vi.fn();
  const onApply = vi.fn<
    (layer: SubagentLayer, changes: readonly SubagentModelSettingsChange[]) => void
  >();
  const onDelete = vi.fn<(layer: SubagentLayer, name: string) => boolean>().mockReturnValue(true);
  const onCancel = vi.fn();
  const panel = new SubagentModelSettingsComponent({
    workspace: overrides.workspace ?? EMPTY_LAYER,
    global: overrides.global ?? EMPTY_LAYER,
    availableModels: overrides.availableModels ?? { 'kimi-k2': { supportEfforts: ['low', 'high'] } },
    subagentProfiles: overrides.subagentProfiles,
    mountPicker,
    remount,
    onApply,
    onDelete,
    onCancel,
  });
  return { panel, mountPicker, remount, onApply, onDelete, onCancel };
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

/** Type a string one character at a time (as the inline slot-name input sees it). */
function type(panel: SubagentModelSettingsComponent, value: string): void {
  for (const ch of value) panel.handleInput(ch);
}

/** Cursor onto `+ Add slot…` (after the 6 built-in type rows) and open the input. */
function openAddSlot(panel: SubagentModelSettingsComponent, typeRows = 6): void {
  moveDown(panel, typeRows);
  panel.handleInput(ENTER);
}

describe('SubagentModelSettingsComponent', () => {
  it('renders bound, inherit, and unbound rows across Types and Slots sections', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {
        coder: { model: 'kimi-k2', thinkingEffort: 'high' },
        critic: { inherit: true },
      },
      slots: {
        review: { model: 'kimi-k2' },
      },
    };
    const { panel } = makeHarness({ workspace });
    const out = text(panel);

    expect(out).toContain(' Subagent models (workspace)');
    expect(out).toContain(
      ' Tab toggle layer · ↑↓ navigate · Enter select · D delete · Esc cancel',
    );
    expect(out).toContain(' Types');
    expect(out).toContain('coder  kimi-k2, thinking high');
    expect(out).toContain('critic  inherit from main agent');
    // explore is a built-in type with no binding.
    expect(out).toContain('explore  not bound');
    expect(out).toContain(' Slots');
    expect(out).toContain('review  kimi-k2');
    expect(out).toContain('+ Add slot…');
    expect(out).toContain('[ Apply changes ]  no changes');
  });

  it('switches layers with Tab and reflects the active layer in the title and rows', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const global: SubagentModelLayerData = {
      bindings: { critic: { model: 'gpt-5' } },
      slots: {},
    };
    const { panel } = makeHarness({ workspace, global });

    expect(text(panel)).toContain(' Subagent models (workspace)');
    expect(text(panel)).toContain('coder  kimi-k2');

    panel.handleInput(TAB);
    const globalOut = text(panel);
    expect(globalOut).toContain(' Subagent models (global)');
    expect(globalOut).toContain('critic  gpt-5');
    // The workspace-only binding is not present on the global layer.
    expect(globalOut).toContain('coder  not bound');

    // Shift+Tab switches back.
    panel.handleInput(SHIFT_TAB);
    expect(text(panel)).toContain(' Subagent models (workspace)');
    expect(text(panel)).toContain('coder  kimi-k2');
  });

  it('keeps workspace and global drafts independent', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const global: SubagentModelLayerData = {
      bindings: { critic: { model: 'gpt-5' } },
      slots: {},
    };
    const { panel, onApply } = makeHarness({ workspace, global });

    // Workspace: clear `coder`.
    panel.handleInput('D');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');

    // Switch to global: its draft starts empty.
    panel.handleInput(TAB);
    expect(text(panel)).toContain(' Subagent models (global)');
    expect(text(panel)).toContain('[ Apply changes ]  no changes');

    // Global: clear `critic` (the second type row).
    moveDown(panel, 1);
    panel.handleInput('D');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');

    // Back to workspace: its own single change is still staged.
    panel.handleInput(TAB);
    expect(text(panel)).toContain(' Subagent models (workspace)');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');

    // Applying reports only the active (workspace) layer's change.
    goToApply(panel);
    panel.handleInput(ENTER);
    expect(onApply).toHaveBeenCalledWith('workspace', [
      { kind: 'type', name: 'coder', binding: undefined },
    ]);
  });

  it('shows the persisted global binding as a reference on workspace rows', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const global: SubagentModelLayerData = {
      bindings: { coder: { model: 'gpt-5' }, explore: { inherit: true } },
      slots: {},
    };
    const { panel } = makeHarness({ workspace, global });

    expect(text(panel)).toContain('coder  kimi-k2 · global: gpt-5');
    expect(text(panel)).toContain('explore  not bound · global: inherit from main agent');

    // The global layer does not reference itself.
    panel.handleInput(TAB);
    expect(text(panel)).not.toContain('global:');
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
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const { panel, mountPicker } = makeHarness({ workspace });

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
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const { panel } = makeHarness({ workspace });

    panel.handleInput('D');
    expect(text(panel)).toContain('coder  not bound · modified');
    expect(text(panel)).toContain('[ Apply changes ]  1 change');

    panel.handleInput('D');
    expect(text(panel)).toContain('coder  kimi-k2');
    expect(text(panel)).not.toContain('· modified');
    expect(text(panel)).toContain('[ Apply changes ]  no changes');
  });

  it('adds a new slot through the inline input and opens the binding picker', () => {
    const { panel, mountPicker } = makeHarness();

    openAddSlot(panel);
    expect(text(panel)).toContain('New slot name');

    type(panel, 'fast');
    panel.handleInput(ENTER);

    // The new row is staged as an unbound "new" slot and the model picker opens.
    expect(text(panel)).not.toContain('New slot name');
    expect(text(panel)).toContain('fast  not bound · new');
    expect(mountPicker).toHaveBeenCalledTimes(1);
    expect(mountPicker.mock.calls[0]![0].render(120).map(strip).join('\n')).toContain(
      'Bind model for slot "fast"',
    );
  });

  it('commits the picked model onto a newly added slot', () => {
    const { panel, mountPicker, onApply } = makeHarness();

    openAddSlot(panel);
    type(panel, 'fast');
    panel.handleInput(ENTER);

    // Pick the only model (down once), which has efforts → pick `high` (down twice).
    const modelPicker = mountPicker.mock.calls[0]![0];
    modelPicker.handleInput(DOWN);
    modelPicker.handleInput(ENTER);
    const effortPicker = mountPicker.mock.calls[1]![0];
    effortPicker.handleInput(DOWN);
    effortPicker.handleInput(DOWN);
    effortPicker.handleInput(ENTER);

    expect(text(panel)).toContain('fast  kimi-k2, thinking high · modified');

    goToApply(panel);
    panel.handleInput(ENTER);
    expect(onApply).toHaveBeenCalledWith('workspace', [
      { kind: 'slot', name: 'fast', binding: { model: 'kimi-k2', thinkingEffort: 'high' } },
    ]);
  });

  it('rejects an empty slot name and stays in input mode', () => {
    const { panel, mountPicker } = makeHarness();

    openAddSlot(panel);
    panel.handleInput(ENTER);

    expect(text(panel)).toContain('Slot name cannot be empty.');
    expect(text(panel)).toContain('New slot name');
    expect(mountPicker).not.toHaveBeenCalled();
  });

  it('rejects a slot name containing spaces', () => {
    const { panel, mountPicker } = makeHarness();

    openAddSlot(panel);
    type(panel, 'my slot');
    panel.handleInput(ENTER);

    expect(text(panel)).toContain('Slot name cannot contain spaces.');
    expect(mountPicker).not.toHaveBeenCalled();
  });

  it('rejects a slot name containing a dot', () => {
    const { panel, mountPicker } = makeHarness();

    openAddSlot(panel);
    type(panel, 'my.slot');
    panel.handleInput(ENTER);

    expect(text(panel)).toContain('Slot name cannot contain ".".');
    expect(mountPicker).not.toHaveBeenCalled();
  });

  it('rejects a duplicate slot name within the same layer', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, mountPicker } = makeHarness({ workspace });

    // 6 type rows + the existing `review` slot, then `+ Add slot…`.
    openAddSlot(panel, 7);
    type(panel, 'review');
    panel.handleInput(ENTER);

    expect(text(panel)).toContain('Slot "review" already exists.');
    expect(mountPicker).not.toHaveBeenCalled();
  });

  it('cancels the slot-name input on Esc without adding a row', () => {
    const { panel, mountPicker } = makeHarness();

    openAddSlot(panel);
    type(panel, 'fast');
    panel.handleInput(ESC);

    expect(text(panel)).not.toContain('New slot name');
    expect(text(panel)).not.toContain('fast');
    expect(mountPicker).not.toHaveBeenCalled();
  });

  it('does not call onApply when applying with an empty draft', () => {
    const { panel, onApply } = makeHarness();

    goToApply(panel);
    panel.handleInput(ENTER);

    expect(onApply).not.toHaveBeenCalled();
  });

  it('reports staged changes in row order when applying', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, mountPicker, onApply } = makeHarness({ workspace });

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

    expect(onApply).toHaveBeenCalledWith('workspace', [
      { kind: 'type', name: 'coder', binding: undefined },
      { kind: 'slot', name: 'review', binding: { inherit: true } },
    ]);
  });

  it('routes apply to the global layer when it is active', () => {
    const global: SubagentModelLayerData = {
      bindings: { coder: { model: 'gpt-5' } },
      slots: {},
    };
    const { panel, onApply } = makeHarness({ global });

    panel.handleInput(TAB);
    panel.handleInput('D'); // clear `coder` on the global layer
    goToApply(panel);
    panel.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith('global', [
      { kind: 'type', name: 'coder', binding: undefined },
    ]);
  });

  it('discards the draft and cancels on Esc', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const { panel, onCancel } = makeHarness({ workspace });

    panel.handleInput('D');
    expect(text(panel)).toContain('· modified');

    panel.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('enters the delete confirmation on a bound slot row with D', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, onDelete } = makeHarness({ workspace });

    moveDown(panel, 6); // onto the `review` slot row
    expect(text(panel)).toContain('  ❯ review');
    panel.handleInput('D');

    const out = text(panel);
    expect(out).toContain('Delete slot "review"? Enter confirm · Esc cancel');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('enters the delete confirmation with lowercase d', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, onDelete } = makeHarness({ workspace });

    moveDown(panel, 6);
    panel.handleInput('d');

    expect(text(panel)).toContain('Delete slot "review"? Enter confirm · Esc cancel');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does not enter delete confirmation on type rows with D', () => {
    const workspace: SubagentModelLayerData = {
      bindings: { coder: { model: 'kimi-k2' } },
      slots: {},
    };
    const { panel } = makeHarness({ workspace });

    // The cursor starts on the first built-in type row (`coder`).
    panel.handleInput('D');

    expect(text(panel)).not.toContain('Delete slot');
    // D on a type row clears the binding draft instead.
    expect(text(panel)).toContain('coder  not bound · modified');
  });

  it('deletes the slot on D then Enter', async () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, remount, onDelete } = makeHarness({ workspace });

    moveDown(panel, 6);
    panel.handleInput('D');
    expect(text(panel)).toContain('Delete slot "review"? Enter confirm · Esc cancel');
    expect(onDelete).not.toHaveBeenCalled();

    panel.handleInput(ENTER);
    await vi.waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('workspace', 'review');
      expect(text(panel)).not.toContain('review');
    });
    // The panel re-mounts to redraw, and the cursor lands on the row that took
    // the deleted slot's place (`+ Add slot…`).
    expect(remount).toHaveBeenCalled();
    expect(text(panel)).toContain('  ❯ + Add slot…');
  });

  it('deletes from the active global layer and clears the workspace reference', async () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const global: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'gpt-5' } },
    };
    const { panel, onDelete } = makeHarness({ workspace, global });

    expect(text(panel)).toContain('review  kimi-k2 · global: gpt-5');

    panel.handleInput(TAB); // global layer
    moveDown(panel, 6); // onto the global `review` row
    panel.handleInput('D');
    panel.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('global', 'review');
      expect(text(panel)).not.toContain('review');
    });

    // Back on the workspace layer, the stale `global:` reference is gone.
    panel.handleInput(TAB);
    expect(text(panel)).toContain('review  kimi-k2');
    expect(text(panel)).not.toContain('global: gpt-5');
  });

  it('keeps the row when the deletion is not persisted', async () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, remount, onDelete } = makeHarness({ workspace });
    onDelete.mockReturnValue(false);

    moveDown(panel, 6);
    panel.handleInput('D');
    panel.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('workspace', 'review');
    });
    expect(text(panel)).toContain('review  kimi-k2');
    expect(remount).not.toHaveBeenCalled();
  });

  it('cancels the confirmation on Esc without deleting', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, onDelete } = makeHarness({ workspace });

    moveDown(panel, 6);
    panel.handleInput('D');
    expect(text(panel)).toContain('Delete slot "review"?');

    panel.handleInput(ESC);

    const out = text(panel);
    expect(out).not.toContain('Delete slot "review"?');
    expect(out).toContain('review  kimi-k2');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('cancels the confirmation when the cursor moves', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, onDelete } = makeHarness({ workspace });

    moveDown(panel, 6);
    panel.handleInput('D');
    expect(text(panel)).toContain('Delete slot "review"?');

    panel.handleInput(DOWN);

    const out = text(panel);
    expect(out).not.toContain('Delete slot "review"?');
    expect(out).toContain('review  kimi-k2');
    expect(out).toContain('  ❯ + Add slot…');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('cancels the delete confirmation on Esc without closing the panel', () => {
    const workspace: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'kimi-k2' } },
    };
    const { panel, onCancel } = makeHarness({ workspace });

    moveDown(panel, 6);
    panel.handleInput('D');
    expect(text(panel)).toContain('Delete slot "review"?');

    panel.handleInput(ESC);
    expect(text(panel)).not.toContain('Delete slot "review"?');
    expect(onCancel).not.toHaveBeenCalled();

    panel.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('warns when the focused slot is only bound on the other layer', () => {
    const global: SubagentModelLayerData = {
      bindings: {},
      slots: { review: { model: 'gpt-5' } },
    };
    const { panel, onDelete } = makeHarness({ global });

    // Add an unbound `review` slot on the workspace layer; the persisted
    // binding lives on the global layer only.
    openAddSlot(panel);
    type(panel, 'review');
    panel.handleInput(ENTER);
    // The cursor is on the new row; D tries to delete it.
    panel.handleInput('D');

    const out = text(panel);
    expect(out).toContain(
      'Slot "review" is only bound on the global layer. Switch layers to delete it.',
    );
    expect(out).not.toContain('Delete slot "review"?');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('warns when the new slot has no binding anywhere', () => {
    const { panel, onDelete } = makeHarness();

    openAddSlot(panel);
    type(panel, 'fast');
    panel.handleInput(ENTER);
    panel.handleInput('D');

    expect(text(panel)).toContain(
      'Slot "fast" has no binding on the workspace layer; nothing to delete.',
    );
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('renders user-defined profile types when subagentProfiles is provided', () => {
    const { panel } = makeHarness({
      subagentProfiles: [
        'coder',
        'critic',
        'explore',
        'orchestrator',
        'plan',
        'synthesizer',
        'my-reviewer',
      ],
    });
    const out = text(panel);
    // Built-in types are still present.
    expect(out).toContain('coder');
    expect(out).toContain('explore');
    // The user-defined type appears as an unbound type row.
    expect(out).toContain('my-reviewer  not bound');
  });

  it('falls back to built-in types when subagentProfiles is omitted', () => {
    const { panel } = makeHarness();
    const out = text(panel);
    // The six built-in types are present.
    expect(out).toContain('coder');
    expect(out).toContain('critic');
    expect(out).toContain('explore');
    expect(out).toContain('orchestrator');
    expect(out).toContain('plan');
    expect(out).toContain('synthesizer');
    // No user-defined types leak in.
    expect(out).not.toContain('my-reviewer');
  });
});
