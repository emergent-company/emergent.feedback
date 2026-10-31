// indicator.ts — top bar shown while comment mode is active.

import type { OverlayConfig } from "./config";
import { syncThemeTo } from "./theme";

const BAR_ID = "__ef_indicator__";
const BADGE_SWITCH_ID = "__ef_badge_switch__";
const DASHBOARD_LINK_ID = "__ef_dashboard_link__";

const STYLES = `
#${BAR_ID} {
  /* Theme tokens — the activation bar is intentionally dark in both themes. */
  --ef-bar-bg: oklch(0.215 0.016 274 / 0.92);
  --ef-bar-accent: oklch(0.76 0.15 162);
  --ef-bar-text: oklch(0.93 0.008 265);
  --ef-bar-key-bg: oklch(0.93 0.008 265 / 0.12);
  --ef-bar-key-border: oklch(0.93 0.008 265 / 0.22);
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  background: var(--ef-bar-bg);
  backdrop-filter: blur(4px);
  border-bottom: 2px solid var(--ef-bar-accent);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 12px;
  font-weight: 500;
  color: var(--ef-bar-text);
  letter-spacing: 0.01em;
  pointer-events: none;
  box-sizing: border-box;
  opacity: 1;
}
#${BAR_ID} .ef-bar-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ef-bar-accent);
  flex-shrink: 0;
  animation: ef-pulse 2s ease-in-out infinite;
}
#${BAR_ID} .ef-bar-label {
  font-weight: 600;
  white-space: nowrap;
}
#${BAR_ID} .ef-bar-hint {
  opacity: 0.72;
  white-space: nowrap;
}
#${BAR_ID} .ef-bar-key {
  display: inline-block;
  background: var(--ef-bar-key-bg);
  border: 1px solid var(--ef-bar-key-border);
  border-radius: 4px;
  padding: 0 5px;
  margin: 0 2px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  line-height: 18px;
}
#${BAR_ID} .ef-bar-spacer {
  flex: 1 1 auto;
}
#${BAR_ID} .ef-bar-switch {
  all: unset;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  color: var(--ef-bar-text);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
#${BAR_ID} .ef-bar-switch:hover {
  background: var(--ef-bar-key-bg);
}
#${BAR_ID} .ef-bar-switch:focus-visible {
  outline: 2px solid var(--ef-bar-accent);
  outline-offset: 1px;
}
#${BAR_ID} .ef-bar-switch-track {
  position: relative;
  box-sizing: border-box;
  width: 26px;
  height: 14px;
  border: 1px solid var(--ef-bar-key-border);
  border-radius: 999px;
  background: var(--ef-bar-key-bg);
  transition: background 0.15s ease, border-color 0.15s ease;
}
#${BAR_ID} .ef-bar-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ef-bar-text);
  transition: transform 0.15s ease, background 0.15s ease;
}
#${BAR_ID} .ef-bar-switch[aria-checked="true"] .ef-bar-switch-track {
  background: var(--ef-bar-accent);
  border-color: var(--ef-bar-accent);
}
#${BAR_ID} .ef-bar-switch[aria-checked="true"] .ef-bar-switch-thumb {
  transform: translateX(12px);
  background: var(--ef-bar-bg);
}
#${BAR_ID} .ef-bar-dashboard {
  pointer-events: auto;
  color: var(--ef-bar-text);
  text-decoration: none;
  white-space: nowrap;
  padding: 3px 8px;
  border: 1px solid var(--ef-bar-key-border);
  border-radius: 6px;
  font: inherit;
  transition: background 0.15s ease;
}
#${BAR_ID} .ef-bar-dashboard:hover {
  background: var(--ef-bar-key-bg);
}
#${BAR_ID} .ef-bar-dashboard:focus-visible {
  outline: 2px solid var(--ef-bar-accent);
  outline-offset: 1px;
}
html[data-ef-theme="dark"] #${BAR_ID},
#${BAR_ID}[data-ef-theme="dark"] {
  --ef-bar-bg: oklch(0.175 0.014 274 / 0.94);
}
@media (max-width: 720px) {
  #${BAR_ID} .ef-bar-hint { display: none; }
}
@media (max-width: 420px) {
  #${BAR_ID} { padding: 0 8px; gap: 6px; }
  #${BAR_ID} .ef-bar-label { display: none; }
}
@keyframes ef-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`;

export interface IndicatorOptions {
  badgesVisible?: boolean;
  onToggleBadges?: (visible: boolean) => void;
  dashboardUrl?: string;
}

function hotkeyLabel(hotkey: OverlayConfig["hotkey"]): string {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  switch (hotkey) {
    case "ctrl+shift":  return "Ctrl+Shift";
    case "meta+shift":  return isMac ? "⌘+Shift" : "Win+Shift";
    case "alt+shift":
    default:            return isMac ? "⌥+Shift" : "Alt+Shift";
  }
}

let styleEl: HTMLStyleElement | null = null;
let barEl: HTMLElement | null = null;

export function showIndicator(
  hotkey: OverlayConfig["hotkey"],
  options: IndicatorOptions = {},
): void {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
  }

  if (!barEl) {
    barEl = document.createElement("div");
    barEl.id = BAR_ID;
    document.body.appendChild(barEl);
  }
  // Late-created root: mirror the current theme so CSS dark overrides apply.
  syncThemeTo(barEl);

  barEl.replaceChildren();

  const dot = document.createElement("span");
  dot.className = "ef-bar-dot";

  const label = document.createElement("span");
  label.className = "ef-bar-label";
  label.textContent = "Comment mode";

  const hint = document.createElement("span");
  hint.className = "ef-bar-hint";
  hint.append("press ");
  const key = document.createElement("span");
  key.className = "ef-bar-key";
  key.textContent = hotkeyLabel(hotkey);
  hint.append(key, " to exit");

  const spacer = document.createElement("span");
  spacer.className = "ef-bar-spacer";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = BADGE_SWITCH_ID;
  toggle.className = "ef-bar-switch";
  toggle.setAttribute("role", "switch");
  const setChecked = (on: boolean): void => {
    toggle.setAttribute("aria-checked", on ? "true" : "false");
    toggle.setAttribute("aria-label", on ? "Hide comment badges" : "Show comment badges");
  };
  setChecked(options.badgesVisible !== false);

  const track = document.createElement("span");
  track.className = "ef-bar-switch-track";
  const thumb = document.createElement("span");
  thumb.className = "ef-bar-switch-thumb";
  track.appendChild(thumb);

  const toggleLabel = document.createElement("span");
  toggleLabel.className = "ef-bar-switch-label";
  toggleLabel.textContent = "Badges";

  toggle.append(track, toggleLabel);
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    setChecked(next);
    options.onToggleBadges?.(next);
  });

  barEl.append(dot, label, hint, spacer, toggle);

  if (options.dashboardUrl) {
    const dashboard = document.createElement("a");
    dashboard.id = DASHBOARD_LINK_ID;
    dashboard.className = "ef-bar-dashboard";
    dashboard.href = options.dashboardUrl;
    dashboard.target = "_blank";
    dashboard.rel = "noopener noreferrer";
    dashboard.textContent = "Dashboard ↗";
    barEl.appendChild(dashboard);
  }

  barEl.style.display = "flex";
  barEl.style.opacity = "1";
}

export function hideIndicator(): void {
  if (barEl) {
    barEl.style.opacity = "0";
    barEl.style.display = "none";
  }
}
