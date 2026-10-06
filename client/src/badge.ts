// badge.ts — numbered badge overlay showing existing comment counts and GitHub issues.

import type { BadgeSummary, IssueBadge } from "./api";
import { syncThemeTo } from "./theme";

const BADGE_PREFIX = "__ef_badge__";
const STYLE_ID = "__ef_badge_styles__";
let activeBadges: HTMLElement[] = [];
let resizeObserver: ResizeObserver | null = null;

const STYLES = `
[id^="${BADGE_PREFIX}"] {
  /* Theme tokens — light defaults; overridden under [data-ef-theme="dark"]. */
  --ef-badge-shadow: 0 1px 3px rgba(0,0,0,0.3);
  position: absolute;
  color: #fff;
  font-size: 10px;
  font-family: sans-serif;
  font-weight: bold;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 10px;
  z-index: 2147483644;
  cursor: pointer;
  user-select: none;
  box-shadow: var(--ef-badge-shadow);
  min-width: 16px;
  text-align: center;
}
[id^="${BADGE_PREFIX}"].ef-badge-feedback { background: #f0a500; }
[id^="${BADGE_PREFIX}"].ef-badge-issue { background: #c0392b; }
html[data-ef-theme="dark"] [id^="${BADGE_PREFIX}"] {
  --ef-badge-shadow: 0 1px 4px rgba(0,0,0,0.6);
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Removes all active badges from the page. */
export function clearBadges(): void {
  activeBadges.forEach((b) => b.remove());
  activeBadges = [];
  resizeObserver?.disconnect();
  resizeObserver = null;
}

/**
 * Renders badges for all summaries and issues that have a matching element on the page.
 * Badges are absolutely positioned over the top-right corner of each element.
 */
export function renderBadges(
  summaries: BadgeSummary[],
  onBadgeClick: (ids: number[], selector: string) => void,
  issues: IssueBadge[] = [],
): void {
  clearBadges();
  ensureStyles();

  // Track all (badge, selector) pairs for repositioning.
  const allBadges: { badge: HTMLElement; selector: string }[] = [];

  // ── Feedback badges (amber) ────────────────────────────────────────────────
  summaries.forEach((s, i) => {
    let el: Element | null = null;
    try { el = document.querySelector(s.selector); } catch { return; }
    if (!el) return;

    const badge = document.createElement("div");
    badge.id = `${BADGE_PREFIX}${i}`;
    badge.className = "ef-badge-feedback";
    badge.textContent = String(s.count);
    badge.title = `${s.count} comment${s.count !== 1 ? "s" : ""} on this element`;

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      onBadgeClick(s.ids, s.selector);
    });

    document.body.appendChild(badge);
    syncThemeTo(badge);
    activeBadges.push(badge);
    allBadges.push({ badge, selector: s.selector });
    positionBadge(badge, el, 0);
  });

  // ── Issue badges (red) ─────────────────────────────────────────────────────
  issues.forEach((iss, i) => {
    let el: Element | null = null;
    try { el = document.querySelector(iss.selector); } catch { return; }
    if (!el) return;

    const badge = document.createElement("div");
    badge.id = `${BADGE_PREFIX}issue_${i}`;
    badge.className = "ef-badge-issue";
    badge.textContent = `#${iss.issue_number}`;
    badge.title = `GitHub issue #${iss.issue_number}: ${iss.title}`;

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.open(iss.issue_url, "_blank", "noopener");
    });

    document.body.appendChild(badge);
    syncThemeTo(badge);
    activeBadges.push(badge);
    allBadges.push({ badge, selector: iss.selector });
    // Offset vertically so issue badge doesn't overlap feedback badge on same element.
    positionBadge(badge, el, summaries.some((s) => s.selector === iss.selector) ? 18 : 0);
  });

  // Reposition on scroll/resize.
  const reposition = () => {
    // Rebuild mapping from current summaries + issues.
    allBadges.forEach(({ badge, selector }) => {
      let el: Element | null = null;
      try { el = document.querySelector(selector); } catch { return; }
      if (!el) return;
      const isIssueBadge = badge.id.startsWith(`${BADGE_PREFIX}issue_`);
      const hasOverlap = !isIssueBadge ? false :
        summaries.some((s) => s.selector === selector);
      positionBadge(badge, el, isIssueBadge && hasOverlap ? 18 : 0);
    });
  };

  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });

  resizeObserver = new ResizeObserver(reposition);
  resizeObserver.observe(document.body);
}

function positionBadge(badge: HTMLElement, el: Element, offsetY = 0): void {
  const rect = el.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  badge.style.top = `${rect.top + scrollY - 8 + offsetY}px`;
  badge.style.left = `${rect.right + scrollX - 8}px`;
}
