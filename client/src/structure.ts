// structure.ts — DOM reordering for the live editor (drag-to-move).
//
// This module owns the ONLY structural mutation the overlay performs: moving a
// selected element to a new position in the host page. Everything else (style
// tokens) stays in tokens.ts.
//
// The overlay never keeps a raw node reference across a reload: a move is
// recorded as a pair of *anchors* — the container's selector plus the sibling
// the element sits before (null = last child) plus the index as a fallback for
// when a selector has drifted. `placeAt` replays a recorded anchor.
//
// Layout only — nothing here changes classes, styles or attributes.

import { buildSelector } from "./selector";

/** Where an element sits: enough to describe and to replay a position. */
export interface PlacementAnchor {
  /** Selector for the container the element is a child of. */
  container: string;
  /** Selector for the sibling the element sits before, or null for last child. */
  before: string | null;
  /** Index among the container's children (fallback when a selector drifts). */
  index: number;
  /** Human-readable position, e.g. `2nd of 4 in .toolbar` (issue text). */
  label: string;
}

/** A completed move: where the element was, where it went. */
export interface Placement {
  from: PlacementAnchor;
  to: PlacementAnchor;
}

/** A resolved drop: the container to insert into and the sibling to insert before. */
export interface DropTarget {
  container: Element;
  before: Element | null;
}

const OVERLAY_SELECTOR =
  '#__ef_dialog__, #__ef_highlight__, #__ef_tooltip__, #__ef_toast__, #__ef_indicator__, [id^="__ef_badge__"]';

/** True for the overlay's own chrome — never a move target or a drop container. */
export function isOverlayNode(el: Element | null): boolean {
  if (!el) return false;
  if (el.id && el.id.startsWith("__ef_")) return true;
  return !!el.closest?.(OVERLAY_SELECTOR);
}

function isRoot(el: Element | null): boolean {
  return !el || el === document.body || el === document.documentElement;
}

/** 1 → `1st`, 2 → `2nd`, 11 → `11th`, … */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Short, human-readable name for a container: the component name when the host
 * provides one, else an id, else `tag.class`.
 */
export function containerLabel(container: Element): string {
  const comp = container.getAttribute("data-component");
  if (comp) return comp;
  if (container.id) return `#${container.id}`;
  const cls = Array.from(container.classList ?? []).slice(0, 1).join("");
  return `${container.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** `2nd of 4 in .toolbar` — the position text used in the panel + issue. */
export function describePosition(el: Element): string {
  const container = el.parentElement;
  if (!container) return "detached";
  const siblings = Array.from(container.children);
  const idx = siblings.indexOf(el);
  return `${ordinal(idx + 1)} of ${siblings.length} in ${containerLabel(container)}`;
}

function childIndex(el: Element): number {
  const container = el.parentElement;
  if (!container) return 0;
  return Array.from(container.children).indexOf(el);
}

/** Capture the element's current position as a replayable anchor. */
export function captureAnchor(el: Element): PlacementAnchor | null {
  const container = el.parentElement;
  if (!container) return null;
  const next = el.nextElementSibling;
  return {
    container: buildSelector(container),
    before: next ? buildSelector(next) : null,
    index: childIndex(el),
    label: describePosition(el),
  };
}

/**
 * Row/column axis of a container's layout. Used to decide whether the pointer
 * sits before or after the hovered sibling. Anything that is not an obvious
 * flex row / grid column is treated as vertical (block flow, flex column).
 */
export function layoutAxis(container: Element): "x" | "y" {
  try {
    const style = window.getComputedStyle(container);
    const display = style.display;
    if (display.includes("flex")) {
      return style.flexDirection.startsWith("row") ? "x" : "y";
    }
    if (display.includes("grid")) {
      return style.gridAutoFlow.startsWith("column") ? "x" : "y";
    }
  } catch {
    // No layout info (detached/odd element) — fall through to vertical.
  }
  return "y";
}

/**
 * Resolve a drop from the element under the pointer.
 *
 * Three cases:
 * - `hit` has element children → the pointer is over the container's own box
 *   (padding/gaps, else `elementFromPoint` would have returned a child), so the
 *   element is appended into it. This is the reparent case.
 * - `hit` is a leaf → position it among its siblings, escalating while the
 *   parent has nothing to reorder against. That keeps nested markup usable:
 *   hovering a `<span>` inside a button inside a toolbar anchors the move to the
 *   toolbar's children, not to the button's single child.
 *
 * Returns null when the drop is illegal: overlay chrome, the page root, the
 * dragged element itself, or a container inside the dragged element (a cycle).
 */
export function computeDrop(
  hit: Element | null,
  dragged: Element,
  x: number,
  y: number
): DropTarget | null {
  if (!hit || isOverlayNode(hit) || isRoot(hit)) return null;
  // Only a container *inside* the dragged element is a cycle; the dragged
  // element's own parent is a perfectly good drop target (move to the end).
  if (hit === dragged || dragged.contains(hit)) return null;

  if (hit.childElementCount > 0) return { container: hit, before: null };

  let anchor: Element = hit;
  let container: Element | null = hit.parentElement;

  // Escalate while the container cannot hold a repositioned sibling.
  for (let hops = 0; hops < 64; hops += 1) {
    if (isRoot(container) || isOverlayNode(container)) return null;
    if (!container) return null;
    if (container === dragged || dragged.contains(container)) return null;
    // A container with a single child cannot express before/after: keep going
    // up so the anchor lands at a level where a reorder is meaningful.
    if (container.childElementCount > 1) break;
    anchor = container;
    container = container.parentElement;
  }
  if (!container || isRoot(container) || isOverlayNode(container)) return null;
  if (container === dragged || dragged.contains(container)) return null;

  const axis = layoutAxis(container);
  const rect = anchor.getBoundingClientRect();
  const midpoint = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  const pointer = axis === "x" ? x : y;
  return { container, before: pointer > midpoint ? anchor.nextElementSibling : anchor };
}

/** Move `el` into `drop`. Returns the resulting position, or null when it is a no-op. */
export function moveElement(el: Element, drop: DropTarget): Placement | null {
  const from = captureAnchor(el);
  if (!from) return null;
  const ref = drop.before && drop.before !== el ? drop.before : null;
  if (el.parentElement === drop.container && el.nextElementSibling === ref) return null;
  drop.container.insertBefore(el, ref);
  const to = captureAnchor(el);
  if (!to) return null;
  return { from, to };
}

function resolve(selector: string): Element | null {
  if (typeof document === "undefined" || !document.querySelector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Replay a recorded position (reload replay and revert). The `before` selector
 * wins; when it no longer resolves inside the container we fall back to the
 * recorded index, and finally to appending. Returns false when the container
 * itself has gone.
 */
export function placeAt(el: Element, anchor: PlacementAnchor): boolean {
  const container = resolve(anchor.container);
  if (!container) return false;

  let ref: Element | null = null;
  if (anchor.before) {
    const sibling = resolve(anchor.before);
    if (sibling && sibling.parentElement === container && sibling !== el) ref = sibling;
  }
  if (!ref) {
    const others = Array.from(container.children).filter((c) => c !== el);
    ref = others[anchor.index] ?? null;
  }
  container.insertBefore(el, ref);
  return true;
}
