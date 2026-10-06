// selection.ts — multi-element selection for live style editing.
//
// Holds the ordered target set, draws numbered outline overlays, tracks applied
// token changes so they can be reverted, and emits change events so the panel
// can re-render. Pure DOM access is guarded so the module stays importable (and
// unit-testable) without a full document.

import { applyToken, revertToken, type Token, type TokenGroup } from "./tokens";
import type { StyleChange } from "./envelope";

export interface TargetEntry {
  el: Element;
  selector: string;
  dataComponent?: string;
}

interface AppliedRecord {
  el: Element;
  group: TokenGroup;
  token: Token;
  before: string;
  after: string;
  selector: string;
}

const OUTLINE_PREFIX = "__ef_sel_";
const HOVER_ID = "__ef_sel_hover__";

const COLOR_TARGET = "#f59e0b"; // amber — selected targets
const COLOR_PICK = "#4f86f7"; // blue — pick-mode hover

let targets: TargetEntry[] = [];
let applied: AppliedRecord[] = [];
let listeners: Array<() => void> = [];
let pickMode = false;
let hoverEl: Element | null = null;
let listening = false;

function emit(): void {
  for (const fn of listeners.slice()) {
    try {
      fn();
    } catch {
      // A misbehaving subscriber must never break the overlay.
    }
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
  renderOutlines();
  emit();
}

/** Add an element to the target set. Returns false when already present. */
export function addTarget(el: Element, selector: string, dataComponent?: string): boolean {
  if (targets.some((t) => t.el === el)) return false;
  targets.push({ el, selector, ...(dataComponent ? { dataComponent } : {}) });
  ensureListeners();
  renderOutlines();
  emit();
  return true;
}

/** Remove an element from the target set, reverting its applied live edits. */
export function removeTarget(el: Element): boolean {
  const before = targets.length;
  // Revert edits made to this element BEFORE dropping its records — otherwise
  // the class/style stays on the host page but is untracked, so Cancel / idle
  // teardown could never undo it.
  for (const r of applied.filter((rec) => rec.el === el)) {
    try {
      revertToken(r.el, r.group, { before: r.before, after: r.after });
    } catch {
      // Element may have left the DOM — nothing to restore.
    }
  }
  targets = targets.filter((t) => t.el !== el);
  applied = applied.filter((r) => r.el !== el);
  if (targets.length === 0) dropListeners();
  renderOutlines();
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
  dropListeners();
  removeOverlays();
  emit();
}

// ── Applied changes ───────────────────────────────────────────────────────────

/** Apply a token to every selected target; records (and dedupes) the change. */
export function applyTokenToTargets(group: TokenGroup, token: Token): void {
  for (const t of targets) {
    const { before, after } = applyToken(t.el, group, token);
    // Keep the ORIGINAL before across repeated edits of the same group so the
    // recorded change reads as first-state → latest-state for the feedback.
    const existing = applied.find((r) => r.el === t.el && r.group.id === group.id);
    const effectiveBefore = existing ? existing.before : before;
    applied = applied.filter((r) => !(r.el === t.el && r.group.id === group.id));
    applied.push({ el: t.el, group, token, before: effectiveBefore, after, selector: t.selector });
  }
  renderOutlines();
  emit();
}

/** Applied edits as feedback records (selector, group, before→after). */
export function getChanges(): StyleChange[] {
  return applied.map((r) => ({
    target: r.selector,
    group: r.group.id,
    before: r.before,
    after: r.after,
  }));
}

export function getChangeCount(): number {
  return applied.length;
}

/** Revert every applied token change on the host page. Selection is kept. */
export function revertAll(): void {
  for (const r of applied) {
    try {
      revertToken(r.el, r.group, { before: r.before, after: r.after });
    } catch {
      // Ignore elements that vanished from the DOM.
    }
  }
  applied = [];
  renderOutlines();
  emit();
}

/**
 * Keep the applied DOM changes but stop tracking them (used after save/export
 * so the host page keeps the edits and later teardown won't undo them).
 */
export function commit(): void {
  applied = [];
  targets = [];
  pickMode = false;
  hoverEl = null;
  dropListeners();
  removeOverlays();
  emit();
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

function renderOutlines(): void {
  if (!canRender()) return;
  // Clear stale outlines/badges (keep the hover layer).
  try {
    document.querySelectorAll(`[id^="${OUTLINE_PREFIX}"]`).forEach((el) => {
      if (el.id !== HOVER_ID) el.remove();
    });
  } catch {
    // ignore
  }

  const scrollX = typeof window !== "undefined" ? window.scrollX : 0;
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;

  targets.forEach((t, i) => {
    let rect: { top: number; left: number; width: number; height: number };
    try {
      rect = t.el.getBoundingClientRect();
    } catch {
      return;
    }
    const box = document.createElement("div");
    box.id = `${OUTLINE_PREFIX}${i + 1}__`;
    Object.assign(box.style, {
      position: "absolute",
      top: `${rect.top + scrollY}px`,
      left: `${rect.left + scrollX}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      outline: `2px solid ${COLOR_TARGET}`,
      backgroundColor: "rgba(245, 158, 11, 0.10)",
      pointerEvents: "none",
      zIndex: "2147483644",
      boxSizing: "border-box",
      borderRadius: "2px",
    });
    document.body.appendChild(box);
    const badge = document.createElement("span");
    badge.id = `${OUTLINE_PREFIX}badge_${i + 1}__`;
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
    numBadge(badge, i + 1);
    document.body.appendChild(badge);
  });
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

/** Repaint outlines (scroll/resize). */
export function refreshOutlines(): void {
  renderOutlines();
}

// ── Scroll / resize listener lifecycle ────────────────────────────────────────

function onReflow(): void {
  renderOutlines();
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
