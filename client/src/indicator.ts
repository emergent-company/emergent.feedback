// indicator.ts — top bar shown while comment mode is active.

import type { OverlayConfig } from "./config";
import { syncThemeTo } from "./theme";

const BAR_ID = "__ef_indicator__";

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
  justify-content: center;
  height: 32px;
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
  transition: opacity 1.2s ease;
}
#${BAR_ID} .ef-bar-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ef-bar-accent);
  margin-right: 8px;
  flex-shrink: 0;
  animation: ef-pulse 2s ease-in-out infinite;
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
html[data-ef-theme="dark"] #${BAR_ID},
#${BAR_ID}[data-ef-theme="dark"] {
  --ef-bar-bg: oklch(0.175 0.014 274 / 0.94);
}
@keyframes ef-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`;

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
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

export function showIndicator(hotkey: OverlayConfig["hotkey"]): void {
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

  const label = hotkeyLabel(hotkey);
  barEl.innerHTML =
    `<span class="ef-bar-dot"></span>` +
    `Comment mode\u2002—\u2002press\u00a0<span class="ef-bar-key">${label}</span>\u00a0to exit`;

  // Reset opacity and show.
  barEl.style.display = "flex";
  barEl.style.opacity = "1";

  // Clear any pending fade.
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

  // Fade out after 3 seconds.
  fadeTimer = setTimeout(() => {
    if (barEl) barEl.style.opacity = "0";
    fadeTimer = null;
  }, 3000);
}

export function hideIndicator(): void {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  if (barEl) {
    barEl.style.opacity = "0";
    barEl.style.display = "none";
  }
}
