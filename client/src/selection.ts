// selection.ts — multi-element selection for live style editing.
//
// Holds the ordered target set, draws numbered outline overlays, tracks applied
// token changes so they can be reverted, and emits change events so the panel
// can re-render. Pure DOM access is guarded so the module stays importable (and
// unit-testable) without a full document.

import { applyToken, revertToken, type Token, type TokenGroup } from "./tokens";
import { buildSelector } from "./selector";
import { captureAnchor, placeAt, type Placement, type PlacementAnchor } from "./structure";
import type { StyleChange } from "./envelope";

export interface TargetEntry {
  el: Element;
  selector: string;
  dataComponent?: string;
}

interface AppliedRecord {
  kind?: "style";
  el: Element | null;
  group: TokenGroup;
  token: Token;
  before: string;
  after: string;
  selector: string;
}

/**
 * A direct-text edit on one element. Elements are only offered a text field
 * when they have exactly one non-whitespace direct text node (see
 * `directTextNode`), so `nodeIndex` is enough to find it again after the text
 * is cleared (an empty text node is no longer "non-whitespace").
 */
export interface TextRecord {
  kind: "text";
  el: Element | null;
  selector: string;
  /** Index of the edited node in `el.childNodes` at edit time. */
  nodeIndex: number;
  /** Raw original node value (kept exact so revert restores surrounding whitespace). */
  before: string;
  /** Value typed into the editor. */
  after: string;
}

/**
 * A DOM move ("position" edit). Anchors instead of nodes: a recorded position
 * has to survive a page reload, where the element objects are new.
 */
export interface PlacementRecord {
  kind: "position";
  el: Element | null;
  selector: string;
  from: PlacementAnchor;
  to: PlacementAnchor;
}

export type EditRecord = AppliedRecord | PlacementRecord | TextRecord;

const isPlacement = (r: EditRecord): r is PlacementRecord => r.kind === "position";
const isText = (r: EditRecord): r is TextRecord => r.kind === "text";
const isStyle = (r: EditRecord): r is AppliedRecord =>
  r.kind !== "position" && r.kind !== "text";

/** The synthetic group id/label a move is reported under. */
export const POSITION_GROUP = "position";
const POSITION_GROUP_LABEL = "Position";

/** The synthetic group id/label a direct-text edit is reported under. */
export const TEXT_GROUP = "text";
const TEXT_GROUP_LABEL = "Text";

/** Edit record → payload shape (a move reports its position labels). */
function toStyleChange(r: EditRecord): StyleChange {
  if (isPlacement(r)) {
    return {
      target: r.selector,
      group: POSITION_GROUP,
      before: r.from.label,
      after: r.to.label,
      move: { from: r.from, to: r.to },
    };
  }
  if (isText(r)) {
    return {
      target: r.selector,
      group: TEXT_GROUP,
      before: r.before.trim(),
      after: r.after.trim(),
    };
  }
  return { target: r.selector, group: r.group.id, before: r.before, after: r.after };
}

const OUTLINE_PREFIX = "__ef_sel_";
const HOVER_ID = "__ef_sel_hover__";

const COLOR_TARGET = "#f59e0b"; // amber — selected targets
const COLOR_PICK = "#4f86f7"; // blue — pick-mode hover

let targets: TargetEntry[] = [];
let applied: EditRecord[] = [];
let committed: EditRecord[] = [];
let listeners: Array<() => void> = [];
let pickMode = false;
let hoverEl: Element | null = null;
let listening = false;

/**
 * The element currently outlined on the page, if any.
 *
 * Outlines are deliberately NOT persistent: with the panel open the page must
 * stay clean, otherwise a border/background/shadow edit can never be judged
 * because the overlay's own 2px box sits on top of it. The highlight is shown
 * only while the reporter hovers/focuses a target label in the panel (or hovers
 * the element whose tab lights up), plus a short `flash()` on select.
 */
let highlightEl: Element | null = null;
let flashEl: Element | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let highlightListeners: Array<(el: Element | null) => void> = [];

function emit(): void {
  for (const fn of listeners.slice()) {
    try {
      fn();
    } catch {
      // A misbehaving subscriber must never break the overlay.
    }
  }
}

/** Revert one record's DOM edit, tolerating stale (null) elements. */
function revertRecord(r: EditRecord): void {
  if (!r.el) return; // stale entry — nothing to restore
  try {
    if (isPlacement(r)) placeAt(r.el, r.from);
    else if (isText(r)) writeDirectText(r.el, r.before, r.nodeIndex);
    else revertToken(r.el, r.group, { before: r.before, after: r.after });
  } catch {
    // Element may have left the DOM — nothing to restore.
  }
}

/** Subscribe to selection/applied-change events. Returns an unsubscribe fn. */
export function onSelectionChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

// ── Target set ────────────────────────────────────────────────────────────────

export function getTargets(): TargetEntry[] {
  return targets.slice();
}

export function getTargetCount(): number {
  return targets.length;
}

export function hasTarget(el: Element): boolean {
  return targets.some((t) => t.el === el);
}

export function isPickMode(): boolean {
  return pickMode;
}

export function setPickMode(on: boolean): void {
  if (pickMode === on) return;
  pickMode = on;
  if (!on) hoverEl = null;
  renderHover();
  renderHighlight();
  emit();
}

/** Add an element to the target set. Returns false when already present. */
export function addTarget(el: Element, selector: string, dataComponent?: string): boolean {
  if (targets.some((t) => t.el === el)) return false;
  targets.push({ el, selector, ...(dataComponent ? { dataComponent } : {}) });
  ensureListeners();
  renderHighlight();
  emit();
  return true;
}

/** Remove an element from the target set, reverting its applied live edits. */
export function removeTarget(el: Element): boolean {
  const before = targets.length;
  if (highlightEl === el) highlightEl = null;
  if (flashEl === el) flashEl = null;
  // Revert edits made to this element BEFORE dropping its records — otherwise
  // the class/style stays on the host page but is untracked, so Cancel / idle
  // teardown could never undo it.
  for (const r of applied.filter((rec) => rec.el === el)) {
    revertRecord(r);
  }
  targets = targets.filter((t) => t.el !== el);
  applied = applied.filter((r) => r.el !== el);
  if (targets.length === 0) dropListeners();
  renderHighlight();
  emit();
  return targets.length !== before;
}

/** Toggle an element's membership. Returns true when it is now selected. */
export function toggleTarget(el: Element, selector: string, dataComponent?: string): boolean {
  if (hasTarget(el)) {
    removeTarget(el);
    return false;
  }
  addTarget(el, selector, dataComponent);
  return true;
}

/** Pick (add) a single element — the one-shot "Add element" flow. */
export function pickTarget(el: Element, selector: string, dataComponent?: string): void {
  addTarget(el, selector, dataComponent);
  if (pickMode) setPickMode(false);
}

/** Drop all targets + applied records and remove overlays. Does NOT revert DOM. */
export function clear(): void {
  targets = [];
  applied = [];
  pickMode = false;
  hoverEl = null;
  resetHighlight();
  dropListeners();
  removeOverlays();
  emit();
}

// ── Direct text ───────────────────────────────────────────────────────────────

const TEXT_NODE = 3;

/** An element's direct text children, ignoring whitespace-only nodes. */
function directTextNodes(el: Element): Text[] {
  const out: Text[] = [];
  const kids = el.childNodes as unknown as ArrayLike<ChildNode> | undefined;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    if (!node || node.nodeType !== TEXT_NODE) continue;
    if (!(node.nodeValue ?? "").trim()) continue;
    out.push(node as Text);
  }
  return out;
}

/**
 * The element's editable direct text node — only when it has exactly ONE
 * non-whitespace direct text child. Zero means the text lives in descendants
 * (or there is none); several means mixed inline markup (`Hello <b>world</b>`),
 * where replacing "the text" would collapse the markup. In both cases the
 * editor offers no text field.
 */
export function directTextNode(el: Element): Text | null {
  const nodes = directTextNodes(el);
  return nodes.length === 1 ? nodes[0] : null;
}

/** A text node at a recorded `childNodes` index, or null when it drifted. */
function textNodeAt(el: Element, index: number): Text | null {
  if (index < 0) return null;
  const kids = el.childNodes as unknown as ArrayLike<ChildNode> | undefined;
  const node = kids?.[index];
  return node && node.nodeType === TEXT_NODE ? (node as Text) : null;
}

/** The pending or committed text record for `el`, if any. */
function textRecordFor(el: Element): TextRecord | null {
  return (
    applied.find((r): r is TextRecord => isText(r) && r.el === el) ??
    committed.find((r): r is TextRecord => isText(r) && r.el === el) ??
    null
  );
}

/** Index of `node` in `el.childNodes`, or -1 when it left the DOM. */
function indexOfChild(el: Element, node: Node): number {
  const kids = el.childNodes as unknown as ArrayLike<ChildNode> | undefined;
  if (!kids) return -1;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] === node) return i;
  }
  return -1;
}

/**
 * The node the Text field edits. A single non-whitespace direct text node is
 * the normal case; when the user cleared that node, fall back to the recorded
 * index so the field (and Reset) keep working on an empty string.
 */
function textNodeFor(el: Element): Text | null {
  const direct = directTextNode(el);
  if (direct) return direct;
  const rec = textRecordFor(el);
  return rec ? textNodeAt(el, rec.nodeIndex) : null;
}

/** Current direct text, trimmed — or null when the element is not editable. */
export function getEditableText(el: Element): string | null {
  const node = textNodeFor(el);
  if (node) return (node.nodeValue ?? "").trim();
  const rec = textRecordFor(el);
  return rec ? rec.after.trim() : null;
}

/**
 * Write a direct text node's value, leaving surrounding markup intact. A
 * recorded `nodeIndex` wins so Reset targets the node that was edited, even
 * after it was cleared; otherwise the normal single-text-node lookup is used.
 */
function writeDirectText(el: Element, value: string, nodeIndex?: number): boolean {
  const node =
    (nodeIndex !== undefined ? textNodeAt(el, nodeIndex) : null) ?? textNodeFor(el);
  if (!node) return false;
  node.nodeValue = value;
  return true;
}

/**
 * Apply a live text edit from the editor: update the node and record the
 * pending change WITHOUT notifying subscribers. A notify here would re-mount
 * the editor on every keystroke and destroy the caret; the field's blur/change
 * calls `notifySelectionChange` instead. Returns false when the element has no
 * editable text node anymore.
 */
export function setTextForTarget(el: Element, value: string): boolean {
  const node = textNodeFor(el);
  if (!node) return false;
  const current = node.nodeValue ?? "";
  const existing = applied.find((r): r is TextRecord => isText(r) && r.el === el);
  const before = existing ? existing.before : current;

  // Typing back the original value is not an edit: restore the exact original
  // (including surrounding whitespace) and drop the pending record.
  if (value.trim() === before.trim()) {
    node.nodeValue = before;
    applied = applied.filter((r) => !(isText(r) && r.el === el));
    return true;
  }

  node.nodeValue = value;
  const selector = targets.find((t) => t.el === el)?.selector ?? "";
  const nodeIndex =
    existing?.nodeIndex ?? indexOfChild(el, node);
  applied = applied.filter((r) => !(isText(r) && r.el === el));
  applied.push({ kind: "text", el, selector, nodeIndex, before, after: value });
  return true;
}

/** True when a pending or committed text edit is recorded for `el`. */
export function hasTextChangeFor(el: Element): boolean {
  return (
    applied.some((r) => isText(r) && r.el === el) ||
    committed.some((r) => isText(r) && r.el === el)
  );
}

/**
 * Restore the element's original direct text ("Reset"): revert + drop the
 * pending record, else the committed one. Returns false when the overlay
 * recorded no text edit for this element.
 */
export function clearTextForTarget(el: Element): boolean {
  const pending = applied.find((r): r is TextRecord => isText(r) && r.el === el);
  if (pending) {
    revertRecord(pending);
    applied = applied.filter((r) => r !== pending);
    renderHighlight();
    emit();
    return true;
  }

  const idx = committed.findIndex((r): r is TextRecord => isText(r) && r.el === el);
  if (idx < 0) return false;
  revertRecord(committed[idx]);
  committed.splice(idx, 1);
  renderHighlight();
  persist();
  emit();
  return true;
}

/**
 * Notify selection subscribers without touching the DOM. Used after live text
 * typing (whose per-keystroke updates deliberately stay silent).
 */
export function notifySelectionChange(): void {
  emit();
}

// ── Applied changes ───────────────────────────────────────────────────────────

/** Apply a token to a single element; records (and dedupes) the change. */
export function applyTokenToTarget(el: Element, group: TokenGroup, token: Token): void {
  const { before, after } = applyToken(el, group, token);
  // Keep the ORIGINAL before across repeated edits of the same group so the
  // recorded change reads as first-state → latest-state for the feedback.
  const existing = applied.find(
    (r): r is AppliedRecord => isStyle(r) && r.el === el && r.group.id === group.id
  );
  const effectiveBefore = existing ? existing.before : before;
  const selector = targets.find((t) => t.el === el)?.selector ?? "";
  applied = applied.filter((r) => !(isStyle(r) && r.el === el && r.group.id === group.id));
  applied.push({ el, group, token, before: effectiveBefore, after, selector });
  renderHighlight();
  emit();
}

/**
 * Record a completed move. Like token edits, repeated moves of the same element
 * collapse into one record that keeps the ORIGINAL from-position, so the
 * feedback reads as first-state → latest-state.
 */
export function recordMove(el: Element, placement: Placement): void {
  const selector = targets.find((t) => t.el === el)?.selector ?? buildSelector(el);
  const existing = applied.find((r): r is PlacementRecord => isPlacement(r) && r.el === el);
  if (existing) {
    // Only the destination moves forward. `from` AND `selector` both describe the
    // ORIGINAL position: on reload the page is back in its original order, so a
    // selector captured after an earlier move would resolve to the wrong element
    // (or to nothing).
    existing.to = placement.to;
  } else {
    applied.push({ kind: "position", el, selector, from: placement.from, to: placement.to });
  }
  // A reorder changes the DOM path of the moved element and of the siblings it
  // passed, so every target's selector is recomputed (`nth-of-type` paths shift).
  for (const t of targets) {
    try {
      t.selector = buildSelector(t.el);
    } catch {
      // Selector drift is never fatal — the recorded anchors are what replay.
    }
  }
  renderHighlight();
  emit();
}

/** Apply a token to every selected target; records (and dedupes) the change. */
export function applyTokenToTargets(group: TokenGroup, token: Token): void {
  for (const t of targets) applyTokenToTarget(t.el, group, token);
}

/** Applied edits as feedback records (selector, group, before→after). */
export function getChanges(): StyleChange[] {
  return applied.map(toStyleChange);
}

export function getChangeCount(): number {
  return applied.length;
}

/** Applied edits for a single element, as feedback records. */
export function getChangesFor(el: Element): StyleChange[] {
  return applied.filter((r) => r.el === el).map(toStyleChange);
}

/** Number of applied records tracked for a single element. */
export function getChangeCountFor(el: Element): number {
  return applied.filter((r) => r.el === el).length;
}

/** Revert only the applied changes belonging to `el`, keeping other targets. */
export function revertChangesFor(el: Element): void {
  for (const r of applied.filter((rec) => rec.el === el)) {
    revertRecord(r);
  }
  for (const r of committed.filter((rec) => rec.el === el)) {
    revertRecord(r);
  }
  applied = applied.filter((r) => r.el !== el);
  committed = committed.filter((r) => r.el !== el);
  renderHighlight();
  persist();
  emit();
}

/**
 * Reset one group to the element's own styling ("Default"): revert + drop the
 * pending record, else the committed one (so Default also undoes a committed
 * edit and stops it being replayed). Returns false when the overlay recorded
 * nothing for this group — a group can read "on" purely because the host markup
 * carries that class, and that must not be stripped behind the reporter's back.
 */
export function clearTokenForTarget(el: Element, group: TokenGroup): boolean {
  const pending = applied.find(
    (r): r is AppliedRecord => isStyle(r) && r.el === el && r.group.id === group.id
  );
  if (pending) {
    revertRecord(pending);
    applied = applied.filter((r) => r !== pending);
    renderHighlight();
    emit();
    return true;
  }

  const idx = committed.findIndex(
    (r): r is AppliedRecord => isStyle(r) && r.el === el && r.group.id === group.id
  );
  if (idx < 0) return false;
  revertRecord(committed[idx]);
  committed.splice(idx, 1);
  renderHighlight();
  persist();
  emit();
  return true;
}

/** Revert every applied AND committed token change on the host page. Selection kept. */
export function revertAll(): void {
  for (const r of applied) {
    revertRecord(r);
  }
  for (const r of committed) {
    revertRecord(r);
  }
  applied = [];
  committed = [];
  renderHighlight();
  persist();
  emit();
}

/**
 * Teardown: keep the DOM edits but stop tracking pending edits + targets.
 * Does NOT touch the committed store — committed edits survive teardown.
 */
export function commit(): void {
  applied = [];
  targets = [];
  pickMode = false;
  hoverEl = null;
  resetHighlight();
  dropListeners();
  removeOverlays();
  emit();
}

// ── Committed changes (persist across close / reload) ─────────────────────────

/** One committed edit, as shown in the panel's "committed" list. */
export interface CommittedEntry {
  selector: string;
  group: string;
  groupLabel: string;
  before: string;
  after: string;
  stale: boolean;
}

const COMMITTED_KEY = "__ef_committed__";

/** Storage key — scoped per path so edits don't leak across pages. */
function storageKey(): string {
  if (typeof location !== "undefined" && location.pathname) {
    return `${COMMITTED_KEY}:${location.pathname}`;
  }
  return COMMITTED_KEY;
}

/** Write the committed store to localStorage (guarded for Node/private mode). */
function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const data = committed.map((r) => {
      if (isPlacement(r)) {
        return { kind: POSITION_GROUP, selector: r.selector, from: r.from, to: r.to };
      }
      if (isText(r)) {
        return {
          kind: TEXT_GROUP,
          selector: r.selector,
          nodeIndex: r.nodeIndex,
          before: r.before,
          after: r.after,
        };
      }
      return { selector: r.selector, group: r.group, token: r.token, before: r.before, after: r.after };
    });
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch {
    // Private mode / sandboxed iframe / absent localStorage — ignore.
  }
}

/** True when two records cover the same element (or selector) + group. */
function sameRecord(a: EditRecord, b: EditRecord): boolean {
  if (isPlacement(a) !== isPlacement(b)) return false;
  if (isText(a) !== isText(b)) return false;
  if (isPlacement(a) && isPlacement(b)) {
    if (a.el && b.el) return a.el === b.el;
    return a.selector === b.selector;
  }
  if (isText(a) && isText(b)) {
    if (a.el && b.el) return a.el === b.el;
    return a.selector === b.selector;
  }
  if (isStyle(a) && isStyle(b)) {
    if (a.group.id !== b.group.id) return false;
    if (a.el && b.el) return a.el === b.el;
    return a.selector === b.selector;
  }
  return false;
}

/**
 * Promote pending edits to committed: merge into the committed store (dedupe
 * by element+group, keeping the latest while preserving the ORIGINAL before —
 * or the original from-position for a move), drop the pending list, keep the
 * DOM edits, persist, and notify.
 */
export function commitChanges(): void {
  const merged = committed.slice();
  for (const r of applied) {
    const idx = merged.findIndex((c) => sameRecord(c, r));
    if (idx < 0) {
      merged.push(r);
      continue;
    }
    const prev = merged[idx];
    if (isPlacement(prev) && isPlacement(r)) merged[idx] = { ...r, from: prev.from };
    else if (isText(prev) && isText(r)) merged[idx] = { ...r, before: prev.before };
    else if (isStyle(prev) && isStyle(r)) merged[idx] = { ...r, before: prev.before };
    else merged[idx] = r;
  }
  committed = merged;
  applied = [];
  renderHighlight();
  persist();
  emit();
}

/** Alias for `commitChanges` — called after a successful Save / issue send. */
export function markSent(): void {
  commitChanges();
}

/** Revert + drop ONLY pending edits; committed entries are left untouched. */
export function revertPending(): void {
  for (const r of applied) {
    revertRecord(r);
  }
  applied = [];
  renderHighlight();
  emit();
}

/** Resolve a stored selector, tolerating invalid selectors + an absent DOM. */
function queryEl(selector: string): Element | null {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Read the committed store from storage and re-apply onto matched elements.
 * Entries whose selector no longer resolves become stale (el: null) and are
 * kept in memory + storage. Safe to call once at boot.
 */
export function loadCommitted(): void {
  committed = [];
  if (typeof localStorage === "undefined") {
    emit();
    return;
  }
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey());
  } catch {
    raw = null;
  }
  if (!raw) {
    emit();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    emit();
    return;
  }

  const records: EditRecord[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const selector = typeof rec.selector === "string" ? rec.selector : "";
    if (!selector) continue;

    // A recorded move: replay the position rather than a class/style.
    if (rec.kind === POSITION_GROUP) {
      const from = rec.from as PlacementAnchor | undefined;
      const to = rec.to as PlacementAnchor | undefined;
      if (!from || !to || typeof from.container !== "string" || typeof to.container !== "string") {
        continue;
      }
      const el = queryEl(selector);
      if (el) {
        try {
          placeAt(el, to);
        } catch {
          // ignore — element apply failed, treat as stale-but-present
        }
      }
      records.push({ kind: "position", el, selector, from, to });
      continue;
    }

    // A recorded direct-text edit: replay it on the element's text node.
    if (rec.kind === TEXT_GROUP) {
      const before = typeof rec.before === "string" ? rec.before : "";
      const after = typeof rec.after === "string" ? rec.after : "";
      const nodeIndex = typeof rec.nodeIndex === "number" ? rec.nodeIndex : -1;
      const el = queryEl(selector);
      if (el) {
        try {
          writeDirectText(el, after, nodeIndex >= 0 ? nodeIndex : undefined);
        } catch {
          // ignore — element apply failed, treat as stale-but-present
        }
      }
      records.push({ kind: "text", el, selector, nodeIndex, before, after });
      continue;
    }

    const group = (rec.group ?? null) as TokenGroup | null;
    const token = (rec.token ?? null) as Token | null;
    const before = typeof rec.before === "string" ? rec.before : "";
    const after = typeof rec.after === "string" ? rec.after : "";
    if (!group || !token) continue;

    const el = queryEl(selector);
    if (el) {
      try {
        applyToken(el, group, token);
      } catch {
        // ignore — element apply failed, treat as stale-but-present
      }
    }
    records.push({ el: el ?? null, group, token, before, after, selector });
  }
  committed = records;
  emit();
}

/**
 * Retry resolving committed entries that were stale at load time — the async
 * overlay script can run before the target elements are parsed, and SPA routes
 * may mount them later. Only touches entries with no resolved element.
 */
export function reapplyCommitted(): void {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
  let changed = false;
  for (const r of committed) {
    if (r.el) continue;
    const el = queryEl(r.selector);
    if (!el) continue;
    try {
      if (isPlacement(r)) placeAt(el, r.to);
      else if (isText(r)) writeDirectText(el, r.after, r.nodeIndex);
      else applyToken(el, r.group, r.token);
    } catch {
      // ignore — keep the entry stale-but-present
    }
    r.el = el;
    changed = true;
  }
  if (changed) emit();
}

/** Committed edits, flattened for the panel's "committed changes" list. */
export function getCommittedEntries(): CommittedEntry[] {
  return committed.map((r) => {
    if (isPlacement(r)) {
      return {
        selector: r.selector,
        group: POSITION_GROUP,
        groupLabel: POSITION_GROUP_LABEL,
        before: r.from.label,
        after: r.to.label,
        stale: r.el == null,
      };
    }
    if (isText(r)) {
      return {
        selector: r.selector,
        group: TEXT_GROUP,
        groupLabel: TEXT_GROUP_LABEL,
        before: r.before.trim(),
        after: r.after.trim(),
        stale: r.el == null,
      };
    }
    return {
      selector: r.selector,
      group: r.group.id,
      groupLabel: r.group.label,
      before: r.before,
      after: r.after,
      stale: r.el == null,
    };
  });
}

export function getCommittedCount(): number {
  return committed.length;
}

/** Revert + drop the committed entry at `index`, then persist. */
export function removeCommittedAt(index: number): void {
  const r = committed[index];
  if (!r) return;
  revertRecord(r);
  committed.splice(index, 1);
  persist();
  emit();
}

/** Revert + drop every committed entry, then persist (empty). */
export function clearCommitted(): void {
  for (const r of committed) {
    revertRecord(r);
  }
  committed = [];
  persist();
  emit();
}

/** Committed edits as feedback records. */
export function getCommittedChanges(): StyleChange[] {
  return committed.map(toStyleChange);
}

/** Pending + committed edits, as feedback records. */
export function getAllChanges(): StyleChange[] {
  return [...applied, ...committed].map(toStyleChange);
}

/** Pending + committed edits for a single element. */
export function getAllChangesFor(el: Element): StyleChange[] {
  return [...applied, ...committed].filter((r) => r.el === el).map(toStyleChange);
}

/** Number of pending + committed records tracked for a single element. */
export function getAllChangeCountFor(el: Element): number {
  return (
    applied.filter((r) => r.el === el).length +
    committed.filter((r) => r.el === el).length
  );
}

// ── Overlay rendering ─────────────────────────────────────────────────────────

function canRender(): boolean {
  return (
    typeof document !== "undefined" &&
    !!document.body &&
    typeof document.createElement === "function"
  );
}

function removeOverlays(): void {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  try {
    document.querySelectorAll(`[id^="${OUTLINE_PREFIX}"]`).forEach((el) => el.remove());
  } catch {
    // ignore
  }
}

function numBadge(el: HTMLElement, n: number): void {
  el.textContent = String(n);
}

// ── Highlight (hover-driven, single element) ──────────────────────────────────

const HIGHLIGHT_ID = `${OUTLINE_PREFIX}highlight__`;
const HIGHLIGHT_BADGE_ID = `${OUTLINE_PREFIX}highlight_badge__`;
const FLASH_MS = 700;

function emitHighlight(): void {
  for (const fn of highlightListeners.slice()) {
    try {
      fn(highlightEl);
    } catch {
      // A misbehaving subscriber must never break the overlay.
    }
  }
}

/**
 * Subscribe to highlight changes so the panel can peek the matching tab.
 * Returns an unsubscribe fn.
 */
export function onHighlightChange(fn: (el: Element | null) => void): () => void {
  highlightListeners.push(fn);
  return () => {
    highlightListeners = highlightListeners.filter((f) => f !== fn);
  };
}

/** The element currently outlined on the page (null when nothing is). */
export function getHighlight(): Element | null {
  return highlightEl;
}

/**
 * Highlight a single target — or clear the highlight with (null). Driven by
 * hovering/focusing a target label in the panel, and by hovering an element on
 * the page that is already a target.
 */
export function setHighlight(el: Element | null): void {
  if (highlightEl === el) return;
  highlightEl = el;
  renderHighlight();
  emitHighlight();
}

/**
 * Briefly outline a target — click-to-select feedback that does not leave a
 * permanent box on the page (which would hide the style edits being previewed).
 */
export function flash(el: Element, ms: number = FLASH_MS): void {
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  flashEl = el;
  renderHighlight();
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (flashEl === el) {
      flashEl = null;
      renderHighlight();
    }
  }, ms);
}

/** Cancel any flash + drop the highlight (teardown paths). */
function resetHighlight(): void {
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  highlightEl = null;
  flashEl = null;
}

/** Remove the highlight box + badge (keeps the pick-mode hover layer). */
function clearHighlightNodes(): void {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  try {
    document.querySelectorAll(`[id^="${OUTLINE_PREFIX}"]`).forEach((el) => {
      if (el.id !== HOVER_ID) el.remove();
    });
  } catch {
    // ignore
  }
}

/**
 * Draw the highlight box (+ numbered badge for the panel tab order) for the
 * highlighted element, or the flashing one while a select-flash is running.
 * No background fill: the outline must not hide the edit being judged.
 */
function renderHighlight(): void {
  if (!canRender()) return;
  clearHighlightNodes();

  const el = highlightEl ?? flashEl;
  if (!el) return;

  let rect: { top: number; left: number; width: number; height: number };
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return;
  }
  const scrollX = typeof window !== "undefined" ? window.scrollX : 0;
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
  const flashing = !highlightEl && !!flashEl;

  const box = document.createElement("div");
  box.id = HIGHLIGHT_ID;
  Object.assign(box.style, {
    position: "absolute",
    top: `${rect.top + scrollY}px`,
    left: `${rect.left + scrollX}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    outline: `2px solid ${COLOR_TARGET}`,
    backgroundColor: flashing ? "rgba(245, 158, 11, 0.08)" : "transparent",
    pointerEvents: "none",
    zIndex: "2147483644",
    boxSizing: "border-box",
    borderRadius: "2px",
  });
  document.body.appendChild(box);

  // Badge number matches the target's tab in the panel; only target elements
  // get one (a hovered non-target has nothing to match).
  const idx = targets.findIndex((t) => t.el === el);
  if (idx < 0) return;

  const badge = document.createElement("span");
  badge.id = HIGHLIGHT_BADGE_ID;
  Object.assign(badge.style, {
    position: "absolute",
    top: `${rect.top + scrollY - 9}px`,
    left: `${rect.left + scrollX - 9}px`,
    minWidth: "18px",
    height: "18px",
    lineHeight: "18px",
    textAlign: "center",
    fontSize: "11px",
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontWeight: "700",
    color: "#fff",
    background: COLOR_TARGET,
    borderRadius: "9px",
    padding: "0 4px",
    pointerEvents: "none",
    zIndex: "2147483645",
    boxSizing: "border-box",
  });
  numBadge(badge, idx + 1);
  document.body.appendChild(badge);
}

function renderHover(): void {
  if (!canRender()) return;
  const existing = document.getElementById(HOVER_ID);
  if (!pickMode || !hoverEl || hasTarget(hoverEl)) {
    existing?.remove();
    return;
  }
  let rect: { top: number; left: number; width: number; height: number };
  try {
    rect = hoverEl.getBoundingClientRect();
  } catch {
    return;
  }
  const scrollX = typeof window !== "undefined" ? window.scrollX : 0;
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
  let box = existing;
  if (!box) {
    box = document.createElement("div");
    box.id = HOVER_ID;
    document.body.appendChild(box);
  }
  Object.assign(box.style, {
    position: "absolute",
    top: `${rect.top + scrollY}px`,
    left: `${rect.left + scrollX}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    outline: `2px dashed ${COLOR_PICK}`,
    backgroundColor: "rgba(79, 134, 247, 0.08)",
    pointerEvents: "none",
    zIndex: "2147483643",
    boxSizing: "border-box",
    borderRadius: "2px",
  });
}

/** Update the pick-mode hover outline (null clears it). */
export function handleHover(el: Element | null): void {
  hoverEl = el;
  if (pickMode) renderHover();
}

/** Repaint the current highlight (scroll/resize/docked reflow). */
export function refreshOutlines(): void {
  renderHighlight();
}

// ── Scroll / resize listener lifecycle ────────────────────────────────────────

function onReflow(): void {
  renderHighlight();
}

function ensureListeners(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("scroll", onReflow, true);
  window.addEventListener("resize", onReflow);
}

function dropListeners(): void {
  if (!listening || typeof window === "undefined") return;
  listening = false;
  window.removeEventListener("scroll", onReflow, true);
  window.removeEventListener("resize", onReflow);
}
