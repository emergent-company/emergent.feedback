// highlighter.ts — element hover highlight (outline box + tooltip label).

import { buildSelector, elementLabel, nearestComponent } from "./selector";

const OVERLAY_ID = "__ef_highlight__";
const TOOLTIP_ID = "__ef_tooltip__";

// Colors when the element belongs to a known component.
const COLOR_COMPONENT = "#22c55e"; // green
const COLOR_COMPONENT_BG = "rgba(34, 197, 94, 0.08)";

// Colors when no data-component ancestor is found.
const COLOR_PLAIN = "#4f86f7"; // blue
const COLOR_PLAIN_BG = "rgba(79, 134, 247, 0.08)";

let currentEl: Element | null = null;

function getOrCreate(id: string, tag = "div"): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

/** Shows the highlight box and tooltip over el. */
export function highlight(el: Element): void {
  currentEl = el;
  const rect = el.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const hasComponent = nearestComponent(el) !== null;
  const color = hasComponent ? COLOR_COMPONENT : COLOR_PLAIN;
  const bgColor = hasComponent ? COLOR_COMPONENT_BG : COLOR_PLAIN_BG;

  const box = getOrCreate(OVERLAY_ID);
  Object.assign(box.style, {
    position: "absolute",
    top: `${rect.top + scrollY}px`,
    left: `${rect.left + scrollX}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    outline: `2px solid ${color}`,
    backgroundColor: bgColor,
    pointerEvents: "none",
    zIndex: "2147483645",
    boxSizing: "border-box",
    borderRadius: "2px",
    transition: "all 80ms ease",
  });

  const label = elementLabel(el);
  const tip = getOrCreate(TOOLTIP_ID);
  tip.textContent = label;

  // Position tooltip above the element, clamped so it doesn't overflow right edge.
  const tipLeft = Math.min(
    rect.left + scrollX,
    window.innerWidth + scrollX - (label.length * 7 + 16) // rough char-width estimate
  );

  Object.assign(tip.style, {
    position: "absolute",
    top: `${rect.top + scrollY - 26}px`,
    left: `${Math.max(4, tipLeft)}px`,
    background: color,
    color: "#fff",
    fontSize: "11px",
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    padding: "2px 7px",
    borderRadius: "3px",
    pointerEvents: "none",
    zIndex: "2147483646",
    whiteSpace: "nowrap",
  });
}

/** Removes the highlight box and tooltip. */
export function clearHighlight(): void {
  currentEl = null;
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(TOOLTIP_ID)?.remove();
}

/** Returns the currently highlighted element. */
export function getHighlighted(): Element | null {
  return currentEl;
}

/** Returns the CSS selector for the currently highlighted element. */
export function getHighlightedSelector(): string | null {
  return currentEl ? buildSelector(currentEl) : null;
}
