// badge.ts — numbered badge overlay showing existing comment counts and GitHub issues.
//
// Badges live in a single absolutely-positioned layer at the document origin.
// Each commented selector gets a stack anchored to the top-right of its target,
// so several badges on one element sit side by side instead of on top of each
// other. The layer moves with the page; capture-phase scroll handling and rAF
// keep stacks aligned when an ancestor scrolls or an element moves.

import type { BadgeSummary, IssueBadge } from "./api";
import { syncThemeTo } from "./theme";

const BADGE_PREFIX = "__ef_badge__";
const LAYER_ID = `${BADGE_PREFIX}layer`;
const STYLE_ID = "__ef_badge_styles__";
const VISIBLE_KEY = "__ef_badges_visible__";

interface SummaryEntry {
  summary: BadgeSummary;
  index: number;
}

interface IssueEntry {
  issue: IssueBadge;
  index: number;
}

interface BadgeGroup {
  selector: string;
  summaries: SummaryEntry[];
  issues: IssueEntry[];
}

interface BadgeStack {
  el: HTMLDivElement;
  selector: string;
  target: Element | null;
  inView: boolean;
}

let layer: HTMLElement | null = null;
let stacks: BadgeStack[] = [];
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let trackingStarted = false;
let rafId: number | null = null;
let visible = readVisiblePreference();

const STYLES = `
#${LAYER_ID} {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: visible;
  pointer-events: none;
  z-index: 2147483644;
}
#${LAYER_ID} .ef-badge-stack {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  max-width: min(60vw, 420px);
  pointer-events: none;
  transform-origin: 100% 50%;
}
#${LAYER_ID} .ef-badge {
  /* Theme tokens — light defaults; overridden for dark themes. */
  --ef-badge-shadow: 0 1px 3px rgba(0,0,0,0.3);
  all: initial;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 0;
  border-radius: 9px;
  background: oklch(0.65 0.14 82);
  color: oklch(0.2 0.04 82);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  text-align: center;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  box-shadow: var(--ef-badge-shadow);
  appearance: none;
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
#${LAYER_ID} .ef-badge:hover {
  transform: translateY(-1px) scale(1.06);
}
#${LAYER_ID} .ef-badge:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
#${LAYER_ID} .ef-badge-issue {
  background: oklch(0.55 0.19 26);
  color: #fff;
}
html[data-ef-theme="dark"] #${LAYER_ID} .ef-badge,
#${LAYER_ID} .ef-badge[data-ef-theme="dark"] {
  --ef-badge-shadow: 0 1px 4px rgba(0,0,0,0.6);
}
@media (prefers-reduced-motion: reduce) {
  #${LAYER_ID} .ef-badge { transition: none; }
}
`;

function readVisiblePreference(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Whether the badge layer should be shown. Persisted across sessions. */
export function isBadgesVisible(): boolean {
  return visible;
}

/**
 * Show or hide the badge layer. The preference is persisted so the switch
 * survives reloads; hiding does not discard the rendered badge data.
 */
export function setBadgesVisible(next: boolean): void {
  visible = next;
  try {
    localStorage.setItem(VISIBLE_KEY, next ? "true" : "false");
  } catch {
    // Storage can be unavailable (private mode / blocked cookies); hiding the
    // layer still works for this session.
  }
  if (!layer) return;
  layer.style.display = next ? "" : "none";
  if (next) {
    updatePositions();
    scheduleUpdate();
  }
}

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.style.display = visible ? "" : "none";
  document.body.appendChild(layer);
  return layer;
}

function createBadge(
  id: string,
  className: string,
  text: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.id = id;
  badge.className = `ef-badge ${className}`;
  badge.textContent = text;
  badge.title = title;
  badge.setAttribute("aria-label", title);
  badge.addEventListener("pointerdown", (e) => e.stopPropagation());
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  });
  syncThemeTo(badge);
  return badge;
}

/** Removes all active badges and observers from the page. */
export function clearBadges(): void {
  if (rafId !== null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
    else clearTimeout(rafId);
    rafId = null;
  }
  stacks.forEach((stack) => stack.el.remove());
  stacks = [];
  resizeObserver?.disconnect();
  resizeObserver = null;
  intersectionObserver?.disconnect();
  intersectionObserver = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (layer) {
    layer.remove();
    layer = null;
  }
}

/**
 * Renders badges for all summaries and issues that have a matching element on
 * the page. Badges for the same element share one stack, ordered feedback
 * first then issues.
 */
export function renderBadges(
  summaries: BadgeSummary[],
  onBadgeClick: (ids: number[], selector: string) => void,
  issues: IssueBadge[] = [],
): void {
  clearBadges();
  if (!document.body) return;
  ensureStyles();

  const groups = new Map<string, BadgeGroup>();
  const groupFor = (selector: string): BadgeGroup => {
    let group = groups.get(selector);
    if (!group) {
      group = { selector, summaries: [], issues: [] };
      groups.set(selector, group);
    }
    return group;
  };

  summaries.forEach((summary, index) => {
    groupFor(summary.selector).summaries.push({ summary, index });
  });
  issues.forEach((issue, index) => {
    groupFor(issue.selector).issues.push({ issue, index });
  });
  if (groups.size === 0) return;

  const root = ensureLayer();

  groups.forEach((group) => {
    let target: Element | null = null;
    try {
      target = document.querySelector(group.selector);
    } catch {
      target = null;
    }

    const stack = document.createElement("div");
    stack.className = "ef-badge-stack";
    stack.dataset.selector = group.selector;

    group.summaries.forEach(({ summary, index }) => {
      const count = summary.count;
      stack.appendChild(
        createBadge(
          `${BADGE_PREFIX}${index}`,
          "ef-badge-feedback",
          String(count),
          `${count} comment${count !== 1 ? "s" : ""} on this element`,
          () => onBadgeClick(summary.ids, summary.selector),
        ),
      );
    });

    group.issues.forEach(({ issue, index }) => {
      stack.appendChild(
        createBadge(
          `${BADGE_PREFIX}issue_${index}`,
          "ef-badge-issue",
          `#${issue.issue_number}`,
          `GitHub issue #${issue.issue_number}: ${issue.title}`,
          () => window.open(issue.issue_url, "_blank", "noopener,noreferrer"),
        ),
      );
    });

    root.appendChild(stack);
    stacks.push({ el: stack, selector: group.selector, target, inView: true });
  });

  syncObservers();
  startTracking();
  updatePositions();
}

function syncObservers(): void {
  const targets = new Set<Element>();
  for (const stack of stacks) {
    if (stack.target?.isConnected) targets.add(stack.target);
  }

  if (typeof ResizeObserver !== "undefined") {
    if (!resizeObserver) resizeObserver = new ResizeObserver(() => scheduleUpdate());
    resizeObserver.disconnect();
    targets.forEach((target) => resizeObserver!.observe(target));
    if (document.body) resizeObserver.observe(document.body);
  }

  if (typeof IntersectionObserver !== "undefined") {
    if (!intersectionObserver) {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            for (const stack of stacks) {
              if (stack.target !== entry.target) continue;
              stack.inView = entry.isIntersecting;
              stack.el.style.visibility = entry.isIntersecting ? "" : "hidden";
            }
          }
        },
        { threshold: 0 },
      );
    }
    intersectionObserver.disconnect();
    targets.forEach((target) => intersectionObserver!.observe(target));
  }
}

function scheduleUpdate(): void {
  if (rafId !== null) return;
  if (typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updatePositions();
    });
  } else {
    rafId = window.setTimeout(() => {
      rafId = null;
      updatePositions();
    }, 16);
  }
}

function updatePositions(): void {
  // A host framework can replace body content and take the layer with it;
  // recreate it and re-parent the still-live stacks before measuring.
  if (!layer || !layer.isConnected) {
    if (stacks.length === 0) return;
    layer = ensureLayer();
    for (const stack of stacks) layer.appendChild(stack.el);
  }
  if (!visible) return;

  const layerRect = layer.getBoundingClientRect();
  const writes: Array<{ stack: BadgeStack; x: number; y: number; show: boolean }> = [];
  let observersDirty = false;

  for (const stack of stacks) {
    let target = stack.target;
    if (!target || !target.isConnected) {
      try {
        target = document.querySelector(stack.selector);
      } catch {
        target = null;
      }
      if (target !== stack.target) {
        stack.target = target;
        stack.inView = true;
        observersDirty = true;
      }
    }

    if (!target) {
      writes.push({ stack, x: 0, y: 0, show: false });
      continue;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      writes.push({ stack, x: 0, y: 0, show: false });
      continue;
    }

    writes.push({
      stack,
      x: rect.right - layerRect.left,
      y: rect.top - layerRect.top,
      show: true,
    });
  }

  for (const write of writes) {
    const { stack } = write;
    if (!write.show) {
      stack.el.style.display = "none";
      continue;
    }
    stack.el.style.display = "";
    stack.el.style.transform = `translate(${write.x}px, ${write.y}px) translate(-100%, -50%)`;
    stack.el.style.visibility = stack.inView ? "" : "hidden";
  }

  if (observersDirty) syncObservers();
}

function startTracking(): void {
  if (!trackingStarted) {
    trackingStarted = true;
    // Capture phase catches scrolling inside nested containers; the window
    // listener covers browsers that dispatch viewport scroll on window.
    document.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true });
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("orientationchange", scheduleUpdate, { passive: true });
    document.addEventListener("load", scheduleUpdate, true);
    document.addEventListener("transitionend", scheduleUpdate, true);
    document.addEventListener("animationend", scheduleUpdate, true);
    document.addEventListener("visibilitychange", scheduleUpdate);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleUpdate);
      window.visualViewport.addEventListener("scroll", scheduleUpdate);
    }
  }

  if (!mutationObserver && typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver(() => scheduleUpdate());
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}
