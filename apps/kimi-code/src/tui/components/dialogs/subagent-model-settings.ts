/**
 * Settings panel that batch-edits per-workspace subagent model bindings:
 * one row per known subagent type plus one per existing named slot, a local
 * draft (Map) staged through the shared model → effort picker chain, and a
 * single Apply step that hands the changed rows to the command layer for
 * persistence. The component never talks to the SDK itself.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
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

import type { ChoicePickerComponent } from './choice-picker';

const ELLIPSIS = '…';

/** One staged row change; `binding === undefined` clears the persisted binding. */
export interface SubagentModelSettingsChange {
  readonly kind: 'type' | 'slot';
  readonly name: string;
  readonly binding: SubagentBinding | undefined;
}

export interface SubagentModelSettingsOptions {
  /** Current per-type bindings (`session.getSubagentBindings()`). */
  readonly bindings: Readonly<Record<string, SubagentBinding>>;
  /** Current named-slot bindings (`session.getSubagentSlotBindings()`). */
  readonly slots: Readonly<Record<string, SubagentBinding>>;
  readonly availableModels: Readonly<Record<string, SubagentBindingModelLike>>;
  /** Mount a child picker into the editor-replacement slot. */
  readonly mountPicker: (picker: ChoicePickerComponent) => void;
  /** Re-mount this panel after a child picker settles. */
  readonly remount: () => void;
  readonly onApply: (changes: readonly SubagentModelSettingsChange[]) => void;
  readonly onCancel: () => void;
}

interface SubagentModelRow {
  readonly kind: 'type' | 'slot';
  readonly name: string;
  readonly original: SubagentBinding | undefined;
}

type SubagentModelItem =
  | { readonly kind: 'row'; readonly row: SubagentModelRow }
  | { readonly kind: 'apply' };

export class SubagentModelSettingsComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: SubagentModelSettingsOptions;
  private readonly items: readonly SubagentModelItem[];
  private readonly list: SearchableList<SubagentModelItem>;
  /** Keyed by `${kind}:${name}`; value `undefined` stages a clear. */
  private readonly draft = new Map<string, SubagentBinding | undefined>();

  constructor(opts: SubagentModelSettingsOptions) {
    super();
    this.opts = opts;
    this.items = buildItems(opts);
    this.list = new SearchableList({
      items: this.items,
      toSearchText: (item) => (item.kind === 'row' ? `${item.row.kind} ${item.row.name}` : 'apply'),
      // Bounded row count (built-in types + existing bindings/slots): render
      // every row on one page so the section headers never split mid-page.
      pageSize: Math.max(this.items.length, 1),
      searchable: false,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.draft.clear();
      this.opts.onCancel();
      return;
    }
    const activate =
      matchesKey(data, Key.enter) || matchesKey(data, Key.space) || printableChar(data) === ' ';
    if (activate) {
      const item = this.list.selected();
      if (item === undefined) return;
      if (item.kind === 'apply') {
        const changes = this.draftChanges();
        if (changes.length > 0) this.opts.onApply(changes);
        return;
      }
      this.openBindingPicker(item.row);
      return;
    }
    const decoded = printableChar(data);
    if (decoded === 'D' || decoded === 'd') {
      const item = this.list.selected();
      if (item !== undefined && item.kind === 'row') this.toggleClearDraft(item.row);
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Subagent models'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · D delete · Esc cancel'),
      '',
    ];

    let lastRowKind: 'type' | 'slot' | undefined;
    for (let i = view.page.start; i < view.page.end; i++) {
      const item = view.items[i]!;
      const selected = i === view.selectedIndex;
      if (item.kind === 'apply') {
        lines.push('');
        lines.push(this.renderApplyRow(selected));
        continue;
      }
      if (item.row.kind !== lastRowKind) {
        if (lastRowKind !== undefined) lines.push('');
        const header = item.row.kind === 'type' ? 'Types' : 'Slots';
        lines.push(currentTheme.boldFg('textStrong', ` ${header}`));
        lastRowKind = item.row.kind;
      }
      lines.push(this.renderRow(item.row, selected));
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private openBindingPicker(row: SubagentModelRow): void {
    const targetLabel = row.kind === 'slot' ? `slot "${row.name}"` : `subagent "${row.name}"`;
    pickSubagentBinding({
      targetLabel,
      availableModels: this.opts.availableModels,
      mount: this.opts.mountPicker,
      settle: this.opts.remount,
      onBinding: (binding) => {
        this.setDraft(row, binding);
      },
    });
  }

  private setDraft(row: SubagentModelRow, binding: SubagentBinding): void {
    const key = rowKey(row);
    if (bindingEquals(binding, row.original)) {
      this.draft.delete(key);
      return;
    }
    this.draft.set(key, binding);
  }

  private toggleClearDraft(row: SubagentModelRow): void {
    const key = rowKey(row);
    if (this.draft.has(key)) {
      // D again undoes the staged change: a drafted clear returns to the
      // persisted binding, a drafted bind on a never-bound row returns to
      // unbound, and a drafted bind over a persisted binding becomes a clear.
      if (this.draft.get(key) === undefined || row.original === undefined) {
        this.draft.delete(key);
        return;
      }
      this.draft.set(key, undefined);
      return;
    }
    if (row.original === undefined) return;
    this.draft.set(key, undefined);
  }

  private effectiveBinding(row: SubagentModelRow): SubagentBinding | undefined {
    const key = rowKey(row);
    return this.draft.has(key) ? this.draft.get(key) : row.original;
  }

  private draftChanges(): readonly SubagentModelSettingsChange[] {
    const changes: SubagentModelSettingsChange[] = [];
    for (const item of this.items) {
      if (item.kind !== 'row') continue;
      const key = rowKey(item.row);
      if (this.draft.has(key)) {
        changes.push({
          kind: item.row.kind,
          name: item.row.name,
          binding: this.draft.get(key),
        });
      }
    }
    return changes;
  }

  private renderRow(row: SubagentModelRow, selected: boolean): string {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const label = selected
      ? currentTheme.boldFg('primary', row.name)
      : currentTheme.fg('text', row.name);
    const effective = this.effectiveBinding(row);
    const status = effective === undefined ? 'not bound' : formatSubagentBinding(effective);
    const detail = this.draft.has(rowKey(row)) ? `${status} · modified` : status;
    return `${prefix}${label}  ${currentTheme.fg('textMuted', detail)}`;
  }

  private renderApplyRow(selected: boolean): string {
    const count = this.draftChanges().length;
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
}

function buildItems(opts: SubagentModelSettingsOptions): SubagentModelItem[] {
  const typeNames = [
    ...new Set([...BUILTIN_SUBAGENT_TYPES, ...Object.keys(opts.bindings)]),
  ].toSorted();
  const items: SubagentModelItem[] = typeNames.map((name) => ({
    kind: 'row',
    row: { kind: 'type', name, original: opts.bindings[name] },
  }));
  for (const name of Object.keys(opts.slots).toSorted()) {
    items.push({ kind: 'row', row: { kind: 'slot', name, original: opts.slots[name] } });
  }
  items.push({ kind: 'apply' });
  return items;
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
