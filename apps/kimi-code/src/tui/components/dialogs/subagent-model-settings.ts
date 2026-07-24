/**
 * Settings panel that batch-edits subagent model bindings across two config
 * layers — the workspace layer (`.kimi-code/local.toml` in the repo) and the
 * global layer (`~/.omkc/local.toml`). Each layer owns one row per known
 * subagent type plus one per existing named slot, its own local draft (Map)
 * staged through the shared model → effort picker chain, and a single Apply
 * step that hands the changed rows of the ACTIVE layer to the command layer for
 * persistence. Tab / Shift+Tab switch layers (their drafts stay independent);
 * the Slots section offers a `+ Add slot…` row that opens an inline name input.
 * A bound slot row can also be deleted outright: D enters the inline delete
 * confirmation on the row, Enter executes it, and Esc (or any movement key)
 * cancels. Type rows keep D as a clear/restore-binding-draft toggle. The
 * component never talks to the SDK itself.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { SubagentBinding } from '@moonshot-ai/kimi-code-sdk';

import { BUILTIN_SUBAGENT_TYPES } from '#/tui/constant/subagent-model';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';
import {
  formatSubagentBinding,
  pickSubagentBinding,
  type SubagentBindingModelLike,
} from '#/tui/utils/subagent-binding-picker';
import { renderTabStrip } from '#/tui/utils/tab-strip';

import type { ChoicePickerComponent } from './choice-picker';

const ELLIPSIS = '…';

/** The two config layers a binding can be persisted to. */
export type SubagentLayer = 'workspace' | 'global';

const LAYER_TAB_LABELS = ['Workspace', 'Global'];

/** One staged row change; `binding === undefined` clears the persisted binding. */
export interface SubagentModelSettingsChange {
  readonly kind: 'type' | 'slot';
  readonly name: string;
  readonly binding: SubagentBinding | undefined;
}

/** The persisted bindings of one layer, loaded before the panel opens. */
export interface SubagentModelLayerData {
  /** Per-type bindings (workspace: `getSubagentBindings`, global: `getGlobalSubagentBindings`). */
  readonly bindings: Readonly<Record<string, SubagentBinding>>;
  /** Named-slot bindings (workspace: `getSubagentSlotBindings`, global: `getGlobalSubagentSlotBindings`). */
  readonly slots: Readonly<Record<string, SubagentBinding>>;
}

export interface SubagentModelSettingsOptions {
  readonly workspace: SubagentModelLayerData;
  readonly global: SubagentModelLayerData;
  readonly availableModels: Readonly<Record<string, SubagentBindingModelLike>>;
  /** Subagent profile names from `listSubagentProfiles` RPC. When omitted the
   * panel falls back to `BUILTIN_SUBAGENT_TYPES` (the pre-RPC behavior). */
  readonly subagentProfiles?: readonly string[];
  /** Mount a child picker into the editor-replacement slot. */
  readonly mountPicker: (picker: ChoicePickerComponent) => void;
  /** Re-mount this panel after a child picker settles. */
  readonly remount: () => void;
  /** Apply is per-layer: only the active layer's draft is handed over. */
  readonly onApply: (
    layer: SubagentLayer,
    changes: readonly SubagentModelSettingsChange[],
  ) => void;
  /** Delete a persisted slot binding from `layer`'s local.toml. Resolves
   * `true` once persisted; the panel then drops the row and re-renders. */
  readonly onDelete: (layer: SubagentLayer, name: string) => Promise<boolean> | boolean;
  readonly onCancel: () => void;
}

interface SubagentModelRow {
  readonly kind: 'type' | 'slot';
  readonly name: string;
  readonly original: SubagentBinding | undefined;
  /** True for slots added via `+ Add slot…` that are not yet persisted. */
  readonly isNew?: boolean;
}

type SubagentModelItem =
  | { readonly kind: 'row'; readonly row: SubagentModelRow }
  | { readonly kind: 'add-slot' }
  | { readonly kind: 'apply' };

/** Per-layer rows + draft + cursor, kept independent across the two layers. */
class SubagentModelLayerState {
  readonly bindings: Readonly<Record<string, SubagentBinding>>;
  /** Mutable copy of the persisted slot bindings, kept in sync when a slot is
   * deleted from this layer (the workspace layer reads it for `global:` refs). */
  readonly slots: Record<string, SubagentBinding>;
  items: SubagentModelItem[];
  /** Keyed by `${kind}:${name}`; value `undefined` stages a clear. */
  readonly draft = new Map<string, SubagentBinding | undefined>();
  list: SearchableList<SubagentModelItem>;

  constructor(data: SubagentModelLayerData, profileNames: readonly string[]) {
    this.bindings = data.bindings;
    this.slots = { ...data.slots };
    this.items = buildItems(data, profileNames);
    this.list = makeList(this.items, 0);
  }

  hasSlot(name: string): boolean {
    return this.items.some(
      (item) => item.kind === 'row' && item.row.kind === 'slot' && item.row.name === name,
    );
  }

  /** Inserts a new unbound slot row at the end of the Slots section (before the
   * `+ Add slot…` row) and moves the cursor onto it. */
  addSlot(name: string): SubagentModelRow {
    const row: SubagentModelRow = { kind: 'slot', name, original: undefined, isNew: true };
    const addIndex = this.items.findIndex((item) => item.kind === 'add-slot');
    const insertAt = addIndex === -1 ? this.items.length : addIndex;
    this.items.splice(insertAt, 0, { kind: 'row', row });
    this.list = makeList(this.items, insertAt);
    return row;
  }
}

export class SubagentModelSettingsComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: SubagentModelSettingsOptions;
  private readonly layers: Record<SubagentLayer, SubagentModelLayerState>;
  private activeLayer: SubagentLayer = 'workspace';
  private readonly slotInput = new Input();
  private addingSlot = false;
  private slotInputError: string | undefined;
  /** Slot row awaiting delete confirmation (D); Enter executes, Esc/cancel cancels. */
  private deleteConfirmRow: SubagentModelRow | undefined;
  /** One-shot message shown when D cannot delete the focused slot row. */
  private deleteError: string | undefined;

  constructor(opts: SubagentModelSettingsOptions) {
    super();
    this.opts = opts;
    const profileNames = opts.subagentProfiles ?? BUILTIN_SUBAGENT_TYPES;
    this.layers = {
      workspace: new SubagentModelLayerState(opts.workspace, profileNames),
      global: new SubagentModelLayerState(opts.global, profileNames),
    };
  }

  private get active(): SubagentModelLayerState {
    return this.layers[this.activeLayer];
  }

  handleInput(data: string): void {
    if (this.addingSlot) {
      this.handleSlotNameInput(data);
      return;
    }
    this.deleteError = undefined;
    if (this.deleteConfirmRow !== undefined) {
      this.handleDeleteConfirmInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.activeLayer = this.activeLayer === 'workspace' ? 'global' : 'workspace';
      return;
    }
    const activate =
      matchesKey(data, Key.enter) || matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (activate) {
      const item = this.active.list.selected();
      if (item === undefined) return;
      if (item.kind === 'apply') {
        const changes = this.draftChanges(this.active);
        if (changes.length > 0) this.opts.onApply(this.activeLayer, changes);
        return;
      }
      if (item.kind === 'add-slot') {
        this.beginAddSlot();
        return;
      }
      this.openBindingPicker(this.active, item.row);
      return;
    }
    const decoded = printableChar(data);
    if (decoded === 'D' || decoded === 'd') {
      const item = this.active.list.selected();
      if (item !== undefined && item.kind === 'row') {
        if (item.row.kind === 'slot') {
          this.enterDeleteConfirm(item.row);
        } else {
          this.toggleClearDraft(this.active, item.row);
        }
      }
      return;
    }
    this.active.list.handleKey(data);
  }

  override render(width: number): string[] {
    if (this.addingSlot) return this.renderSlotNameInput(width);

    const layer = this.active;
    const view = layer.list.view();
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      this.renderTitle(),
      currentTheme.fg(
        'textMuted',
        ' Tab toggle layer · ↑↓ navigate · Enter select · D delete · Esc cancel',
      ),
      '',
      renderTabStrip({
        labels: LAYER_TAB_LABELS,
        activeIndex: this.activeLayer === 'workspace' ? 0 : 1,
        width,
        colors: currentTheme.palette,
      }),
      '',
    ];

    let lastRowKind: 'type' | 'slot' | undefined;
    for (let i = view.page.start; i < view.page.end; i++) {
      const item = view.items[i]!;
      const selected = i === view.selectedIndex;
      if (item.kind === 'apply') {
        lines.push('');
        lines.push(this.renderApplyRow(layer, selected));
        continue;
      }
      if (item.kind === 'add-slot') {
        if (lastRowKind !== 'slot') {
          if (lastRowKind !== undefined) lines.push('');
          lines.push(currentTheme.boldFg('textStrong', ' Slots'));
          lastRowKind = 'slot';
        }
        lines.push(this.renderAddSlotRow(selected));
        continue;
      }
      if (item.row.kind !== lastRowKind) {
        if (lastRowKind !== undefined) lines.push('');
        const header = item.row.kind === 'type' ? 'Types' : 'Slots';
        lines.push(currentTheme.boldFg('textStrong', ` ${header}`));
        lastRowKind = item.row.kind;
      }
      lines.push(this.renderRow(layer, item.row, selected));
    }

    if (this.deleteError !== undefined) {
      lines.push(currentTheme.fg('error', ` ${this.deleteError}`));
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  override invalidate(): void {
    super.invalidate();
    this.slotInput.invalidate();
  }

  private renderTitle(): string {
    return (
      currentTheme.boldFg('primary', ' Subagent models') +
      currentTheme.fg('textMuted', ` (${this.activeLayer})`)
    );
  }

  private handleSlotNameInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.endAddSlot();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submitSlotName();
      return;
    }
    this.slotInput.handleInput(data);
  }

  private beginAddSlot(): void {
    this.addingSlot = true;
    this.slotInputError = undefined;
    this.slotInput.setValue('');
  }

  private endAddSlot(): void {
    this.addingSlot = false;
    this.slotInputError = undefined;
    this.slotInput.setValue('');
  }

  private submitSlotName(): void {
    const name = this.slotInput.getValue().trim();
    const error = validateSlotName(name, this.active);
    if (error !== undefined) {
      this.slotInputError = error;
      return;
    }
    const layer = this.active;
    const row = layer.addSlot(name);
    this.endAddSlot();
    this.openBindingPicker(layer, row);
  }

  private openBindingPicker(layer: SubagentModelLayerState, row: SubagentModelRow): void {
    const targetLabel = row.kind === 'slot' ? `slot "${row.name}"` : `subagent "${row.name}"`;
    pickSubagentBinding({
      targetLabel,
      availableModels: this.opts.availableModels,
      mount: this.opts.mountPicker,
      settle: this.opts.remount,
      onBinding: (binding) => {
        this.setDraft(layer, row, binding);
      },
    });
  }

  private setDraft(
    layer: SubagentModelLayerState,
    row: SubagentModelRow,
    binding: SubagentBinding,
  ): void {
    const key = rowKey(row);
    if (bindingEquals(binding, row.original)) {
      layer.draft.delete(key);
      return;
    }
    layer.draft.set(key, binding);
  }

  private toggleClearDraft(layer: SubagentModelLayerState, row: SubagentModelRow): void {
    const key = rowKey(row);
    if (layer.draft.has(key)) {
      // D again undoes a staged type change: a drafted clear returns to the
      // persisted binding, while a draft on an originally unbound type returns
      // to unbound. A drafted bind over a persisted binding becomes a clear.
      if (layer.draft.get(key) === undefined || row.original === undefined) {
        layer.draft.delete(key);
        return;
      }
      layer.draft.set(key, undefined);
      return;
    }
    if (row.original === undefined) return;
    layer.draft.set(key, undefined);
  }

  /** D on a slot row enters the delete confirmation directly. Only rows with a
   * binding persisted in the active layer are deletable - a slot that is only
   * bound on the other layer (or not bound at all) reports why it cannot be. */
  private enterDeleteConfirm(row: SubagentModelRow): void {
    if (row.original === undefined) {
      this.deleteError = this.notDeletableMessage(row);
      return;
    }
    this.deleteConfirmRow = row;
  }

  private notDeletableMessage(row: SubagentModelRow): string {
    const otherLayer: SubagentLayer = this.activeLayer === 'workspace' ? 'global' : 'workspace';
    if (this.layers[otherLayer].slots[row.name] !== undefined) {
      return `Slot "${row.name}" is only bound on the ${otherLayer} layer. Switch layers to delete it.`;
    }
    return `Slot "${row.name}" has no binding on the ${this.activeLayer} layer; nothing to delete.`;
  }

  /** Enter confirms the deletion; Esc cancels it outright; any other key
   * cancels it and then performs its usual action (e.g. ↑↓ moves away). */
  private handleDeleteConfirmInput(data: string): void {
    const row = this.deleteConfirmRow;
    if (row === undefined) return;
    if (matchesKey(data, Key.enter)) {
      this.deleteConfirmRow = undefined;
      this.executeDelete(row);
      return;
    }
    this.deleteConfirmRow = undefined;
    if (matchesKey(data, Key.escape)) return;
    this.handleInput(data);
  }

  private executeDelete(row: SubagentModelRow): void {
    const layer = this.active;
    const layerName = this.activeLayer;
    void Promise.resolve()
      .then(() => this.opts.onDelete(layerName, row.name))
      .then((persisted) => {
        if (!persisted) return;
        this.removeSlotRow(layer, row);
        // Re-mount so the host redraws and re-focuses the slimmer panel.
        this.opts.remount();
      })
      .catch(() => {
        // The host already surfaced the failure; keep the row for a retry.
      });
  }

  private removeSlotRow(layer: SubagentModelLayerState, row: SubagentModelRow): void {
    const index = layer.items.findIndex((item) => item.kind === 'row' && item.row === row);
    if (index === -1) return;
    layer.items.splice(index, 1);
    layer.draft.delete(rowKey(row));
    delete layer.slots[row.name];
    // Cursor lands on the row that took the deleted slot's place (clamped).
    layer.list = makeList(layer.items, Math.max(0, Math.min(index, layer.items.length - 1)));
  }

  private effectiveBinding(
    layer: SubagentModelLayerState,
    row: SubagentModelRow,
  ): SubagentBinding | undefined {
    const key = rowKey(row);
    return layer.draft.has(key) ? layer.draft.get(key) : row.original;
  }

  private draftChanges(
    layer: SubagentModelLayerState,
  ): readonly SubagentModelSettingsChange[] {
    const changes: SubagentModelSettingsChange[] = [];
    for (const item of layer.items) {
      if (item.kind !== 'row') continue;
      const key = rowKey(item.row);
      if (layer.draft.has(key)) {
        changes.push({
          kind: item.row.kind,
          name: item.row.name,
          binding: layer.draft.get(key),
        });
      }
    }
    return changes;
  }

  private renderRow(
    layer: SubagentModelLayerState,
    row: SubagentModelRow,
    selected: boolean,
  ): string {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected
      ? currentTheme.boldFg('primary', row.name)
      : currentTheme.fg('text', row.name);
    if (this.deleteConfirmRow === row) {
      const prompt = currentTheme.boldFg(
        'warning',
        `Delete slot "${row.name}"? Enter confirm · Esc cancel`,
      );
      return `${prefix}${label}  ${prompt}`;
    }
    const effective = this.effectiveBinding(layer, row);
    let status: string;
    if (effective === undefined) {
      status = row.isNew === true ? 'not bound · new' : 'not bound';
    } else {
      status = formatSubagentBinding(effective, this.opts.availableModels);
    }
    let detail = layer.draft.has(rowKey(row)) ? `${status} · modified` : status;
    const globalRef = this.globalReference(row);
    if (globalRef !== undefined) detail += ` · global: ${globalRef}`;
    return `${prefix}${label}  ${currentTheme.fg('textMuted', detail)}`;
  }

  /** Workspace rows reference the persisted global binding for the same name. */
  private globalReference(row: SubagentModelRow): string | undefined {
    if (this.activeLayer !== 'workspace') return undefined;
    const global = this.layers.global;
    const binding = row.kind === 'slot' ? global.slots[row.name] : global.bindings[row.name];
    return binding === undefined ? undefined : formatSubagentBinding(binding);
  }

  private renderAddSlotRow(selected: boolean): string {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected
      ? currentTheme.boldFg('primary', '+ Add slot…')
      : currentTheme.fg('primary', '+ Add slot…');
    return `${prefix}${label}`;
  }

  private renderApplyRow(layer: SubagentModelLayerState, selected: boolean): string {
    const count = this.draftChanges(layer).length;
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = '[ Apply changes ]';
    const button =
      count === 0 ? currentTheme.fg('textDim', label) : currentTheme.boldFg('primary', label);
    const summary =
      count === 0 ? 'no changes' : `${String(count)} ${count === 1 ? 'change' : 'changes'}`;
    const summaryText =
      count === 0 ? currentTheme.fg('textMuted', summary) : currentTheme.fg('success', summary);
    return `${prefix}${button}  ${summaryText}`;
  }

  private renderSlotNameInput(width: number): string[] {
    this.slotInput.focused = this.focused;
    const safeWidth = Math.max(0, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';
    const border = (s: string): string => currentTheme.fg('primary', s);

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      this.renderTitle(),
      currentTheme.fg('textMuted', ' Enter submit · Esc cancel'),
      '',
      currentTheme.boldFg('textStrong', ' New slot name'),
    ];

    const inputLine = this.slotInput.render(innerWidth)[0] ?? '> ';
    if (safeWidth >= 4) {
      lines.push(border('╭' + '─'.repeat(safeWidth - 2) + '╮'));
      const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
      lines.push(border('│') + pad + inputLine + ' '.repeat(rightPad) + border('│'));
      lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    } else {
      lines.push(inputLine);
    }

    if (this.slotInputError !== undefined) {
      lines.push(currentTheme.fg('error', ` ${this.slotInputError}`));
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
  }
}

function buildItems(
  data: SubagentModelLayerData,
  profileNames: readonly string[],
): SubagentModelItem[] {
  const typeNames = [
    ...new Set([...profileNames, ...Object.keys(data.bindings)]),
  ].toSorted();
  const items: SubagentModelItem[] = typeNames.map((name) => ({
    kind: 'row',
    row: { kind: 'type', name, original: data.bindings[name] },
  }));
  for (const name of Object.keys(data.slots).toSorted()) {
    items.push({ kind: 'row', row: { kind: 'slot', name, original: data.slots[name] } });
  }
  items.push({ kind: 'add-slot' });
  items.push({ kind: 'apply' });
  return items;
}

function makeList(
  items: readonly SubagentModelItem[],
  initialIndex: number,
): SearchableList<SubagentModelItem> {
  return new SearchableList({
    items,
    toSearchText: (item) => {
      if (item.kind === 'row') return `${item.row.kind} ${item.row.name}`;
      return item.kind === 'add-slot' ? 'add slot' : 'apply';
    },
    // Bounded row count (built-in types + existing bindings/slots): render
    // every row on one page so the section headers never split mid-page.
    pageSize: Math.max(items.length, 1),
    searchable: false,
    initialIndex,
  });
}

function validateSlotName(name: string, layer: SubagentModelLayerState): string | undefined {
  if (name.length === 0) return 'Slot name cannot be empty.';
  if (/\s/.test(name)) return 'Slot name cannot contain spaces.';
  if (name.includes('.')) return 'Slot name cannot contain ".".';
  if (layer.hasSlot(name)) return `Slot "${name}" already exists.`;
  return undefined;
}

function rowKey(row: SubagentModelRow): string {
  return `${row.kind}:${row.name}`;
}

function bindingEquals(
  a: SubagentBinding | undefined,
  b: SubagentBinding | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.inherit === b.inherit && a.model === b.model && a.thinkingEffort === b.thinkingEffort;
}
