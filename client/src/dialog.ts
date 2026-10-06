// dialog.ts — element feedback dialog (existing comments + compose) and login dialog.

import type { FeedbackComment } from "./api";
import type {
  FeedbackIntent,
  IntentAction,
  ScopeBreadth,
  StyleChange,
} from "./envelope";
import { syncThemeTo } from "./theme";
import { mountStyleEditor } from "./styleEditor";
import type { ThemeTokens } from "./tokens";
import {
  getChanges as getSelectionChanges,
  getChangeCount as getSelectionChangeCount,
  getTargets as getSelectionTargets,
  isPickMode,
  onSelectionChange,
  removeTarget as removeSelectionTarget,
  applyTokenToTargets,
  revertAll as revertSelectionChanges,
  setPickMode,
  type TargetEntry,
} from "./selection";

const DIALOG_ID = "__ef_dialog__";
const STYLE_ID = "__ef_styles__";
const DOCKED_KEY = "__ef_dialog_docked__";

/** Persisted dock preference. Defaults to docked (true). */
function readDockedPref(): boolean {
  try {
    const v = localStorage.getItem(DOCKED_KEY);
    if (v === null) return true;
    return v !== "false";
  } catch {
    return true;
  }
}

function writeDockedPref(docked: boolean): void {
  try {
    localStorage.setItem(DOCKED_KEY, docked ? "true" : "false");
  } catch {
    // Storage may be unavailable (private mode / sandboxed iframe).
  }
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #__ef_dialog__ {
      /* Theme tokens — light defaults; overridden under [data-ef-theme="dark"].
         Scoped to the overlay root so nothing leaks into the host page. */
      --ef-backdrop: rgba(0,0,0,0.55);
      --ef-card-bg: #ffffff;
      --ef-card-shadow: 0 12px 48px rgba(0,0,0,0.28);
      --ef-border: #e8e8e8;
      --ef-border-subtle: #f2f2f2;
      --ef-control-border: #dddddd;
      --ef-input-border: #cccccc;
      --ef-heading: #0f0f0f;
      --ef-text: #222222;
      --ef-text-soft: #333333;
      --ef-text-strong: #111111;
      --ef-muted: #767676;
      --ef-muted-strong: #555555;
      --ef-muted-soft: #666666;
      --ef-chip-fg: #444444;
      --ef-surface: #fafafa;
      --ef-surface-alt: #f2f2f2;
      --ef-surface-select: #f7f7f7;
      --ef-control-bg: #ffffff;
      --ef-hover-bg: #fafafa;
      --ef-control-border-hover: #bbbbbb;
      --ef-btn-secondary-bg: #efefef;
      --ef-btn-secondary-hover-bg: #e0e0e0;
      --ef-btn-secondary-text: #222222;
      --ef-btn-export-bg: #1a1a1a;
      --ef-btn-export-hover-bg: #333333;
      --ef-btn-export-text: #ffffff;
      --ef-btn-export-disabled-bg: #888888;
      --ef-primary: #4f86f7;
      --ef-primary-hover: #3a6fd8;
      --ef-primary-disabled: #a0baf7;
      --ef-focus-ring: rgba(79,134,247,0.15);
      --ef-focus-ring-input: rgba(79,134,247,0.12);
      --ef-focus-ring-chip: rgba(79,134,247,0.2);
      --ef-chip-on-bg: #eef3ff;
      --ef-chip-on-text: #2b5fd0;
      --ef-error: #c53030;
      --ef-accent: #d97706;
      --ef-accent-soft: rgba(217,119,6,0.12);
      --ef-swatch-checker: #e6e6e6;
      --ef-swatch-border: rgba(0,0,0,0.15);
      --ef-code-bg: #1e1e2e;
      --ef-code-border: #313149;
      --ef-code-text: #cdd6f4;
      --ef-bug-bg: #fff0f0;
      --ef-bug: #d73a4a;
      --ef-enh-bg: #f0fbff;
      --ef-enh: #0969da;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--ef-backdrop);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #__ef_dialog__ * { box-sizing: border-box; }

    /* ── Main card ─────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-card {
      background: var(--ef-card-bg);
      border-radius: 10px;
      width: 520px;
      max-width: calc(100vw - 32px);
      max-height: 85vh;
      box-shadow: var(--ef-card-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Programmatic focus target — no visible ring on the card itself. */
    #__ef_dialog__ .ef-card:focus,
    #__ef_dialog__ .ef-login-card:focus { outline: none; }
    #__ef_dialog__ .ef-header {
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-header-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 3px;
    }
    #__ef_dialog__ .ef-header-top h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--ef-heading);
      flex: 1;
    }
    #__ef_dialog__ .ef-user-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--ef-muted-soft);
      font-weight: 500;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-user-pill img {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--ef-control-border);
    }
    #__ef_dialog__ .ef-selector {
      font-size: 11px;
      color: var(--ef-muted-strong);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
    }

    /* ── Existing comments ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-comments {
      flex-shrink: 0;
      max-height: 240px;
      overflow-y: auto;
      border-bottom: 1px solid var(--ef-border);
    }
    #__ef_dialog__ .ef-comment-item {
      padding: 10px 18px;
      border-bottom: 1px solid var(--ef-border-subtle);
    }
    #__ef_dialog__ .ef-comment-item:last-child { border-bottom: none; }
    #__ef_dialog__ .ef-comment-meta {
      display: flex;
      gap: 6px;
      align-items: baseline;
      margin-bottom: 3px;
    }
    #__ef_dialog__ .ef-comment-author {
      font-size: 12px;
      font-weight: 600;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-comment-date {
      font-size: 11px;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-comment-text {
      font-size: 13px;
      color: var(--ef-text);
      line-height: 1.5;
    }

    /* ── Compose area ──────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-compose {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 18px;
      min-height: 0;
      overflow-y: auto;
    }
    @media (max-width: 420px) {
      #__ef_dialog__ .ef-intent-label { min-width: 0; }
      #__ef_dialog__ .ef-hint { padding-left: 0; }
    }

    #__ef_dialog__ textarea {
      width: 100%;
      border: 1px solid var(--ef-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 13px;
      font-family: inherit;
      color: var(--ef-text-strong);
      resize: vertical;
      min-height: 80px;
      outline: none;
      line-height: 1.5;
      flex: 1;
    }
    #__ef_dialog__ textarea:focus {
      border-color: var(--ef-primary);
      box-shadow: 0 0 0 3px var(--ef-focus-ring);
    }
    #__ef_dialog__ textarea::placeholder { color: var(--ef-muted); }
    #__ef_dialog__ .ef-error {
      color: var(--ef-error);
      font-size: 12px;
    }

    /* ── Type toggle ───────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-type-toggle {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-type-toggle input[type="radio"] { display: none; }
    #__ef_dialog__ .ef-type-toggle label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 20px;
      border: 1.5px solid var(--ef-control-border);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      color: var(--ef-muted-strong);
      background: var(--ef-control-bg);
      transition: all 0.1s;
      user-select: none;
    }
    #__ef_dialog__ .ef-type-toggle input[value="bug"]:checked + label {
      background: var(--ef-bug-bg);
      border-color: var(--ef-bug);
      color: var(--ef-bug);
    }
    #__ef_dialog__ .ef-type-toggle input[value="enhancement"]:checked + label {
      background: var(--ef-enh-bg);
      border-color: var(--ef-enh);
      color: var(--ef-enh);
    }

    /* ── Footer ────────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-footer {
      padding: 10px 18px;
      border-top: 1px solid var(--ef-border);
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--ef-surface);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-footer-spacer { flex: 1; }
    #__ef_dialog__ button {
      padding: 6px 16px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      font-family: inherit;
      transition: background 0.12s;
    }
    #__ef_dialog__ .ef-btn-primary { background: var(--ef-primary); color: #fff; }
    #__ef_dialog__ .ef-btn-primary:hover { background: var(--ef-primary-hover); }
    #__ef_dialog__ .ef-btn-primary:disabled { background: var(--ef-primary-disabled); cursor: default; }
    #__ef_dialog__ .ef-btn-secondary { background: var(--ef-btn-secondary-bg); color: var(--ef-btn-secondary-text); }
    #__ef_dialog__ .ef-btn-secondary:hover { background: var(--ef-btn-secondary-hover-bg); }
    #__ef_dialog__ .ef-btn-export { background: var(--ef-btn-export-bg); color: var(--ef-btn-export-text); }
    #__ef_dialog__ .ef-btn-export:hover { background: var(--ef-btn-export-hover-bg); }
    #__ef_dialog__ .ef-btn-export:disabled { background: var(--ef-btn-export-disabled-bg); cursor: default; }

    /* ── Metadata collapsible ──────────────────────────────────────────────── */
    #__ef_dialog__ .ef-meta-toggle {
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-meta-toggle summary {
      font-size: 11px;
      color: var(--ef-muted);
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #__ef_dialog__ .ef-meta-toggle summary::-webkit-details-marker { display: none; }
    #__ef_dialog__ .ef-meta-toggle summary::before {
      content: "▶";
      font-size: 8px;
      transition: transform 0.15s;
      display: inline-block;
    }
    #__ef_dialog__ .ef-meta-toggle[open] summary::before { transform: rotate(90deg); }
    #__ef_dialog__ .ef-meta-grid {
      margin-top: 6px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      font-size: 11px;
      line-height: 1.6;
    }
    #__ef_dialog__ .ef-meta-key {
      color: var(--ef-muted);
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-meta-val {
      color: var(--ef-text);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
      white-space: pre-wrap;
    }
    #__ef_dialog__ .ef-meta-section-title {
      grid-column: 1 / -1;
      font-weight: 600;
      color: var(--ef-muted-strong);
      font-family: inherit;
      margin-top: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* ── Session history ────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-history-list {
      margin-top: 6px;
      max-height: 200px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-history-line {
      font-size: 11px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      line-height: 1.7;
      color: var(--ef-text-soft);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #__ef_dialog__ .ef-history-type {
      display: inline-block;
      width: 36px;
      font-weight: 600;
      color: var(--ef-muted);
      text-transform: uppercase;
      flex-shrink: 0;
    }

    /* ── HTML preview ──────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-html-preview {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      line-height: 1.6;
      white-space: pre;
      overflow: auto;
      max-height: 160px;
      margin: 6px 0 0;
      padding: 8px 10px;
      background: var(--ef-code-bg);
      border-radius: 5px;
      border: 1px solid var(--ef-code-border);
      color: var(--ef-code-text);
    }
    /* syntax token colours (Catppuccin-ish dark) */
    #__ef_dialog__ .ef-ht  { color: #89b4fa; }   /* tag name */
    #__ef_dialog__ .ef-ha  { color: #a6e3a1; }   /* attr name */
    #__ef_dialog__ .ef-hv  { color: #fab387; }   /* attr value */
    #__ef_dialog__ .ef-hd  { color: #6c7086; }   /* doctype / comment */
    #__ef_dialog__ .ef-hp  { color: #89dceb; }   /* punctuation <, >, = */

    /* ── Issue topic override ───────────────────────────────────────────────── */
    #__ef_dialog__ .ef-topic-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-topic-label {
      font-size: 11px;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-topic-input {
      width: 100%;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      color: var(--ef-text-strong);
      outline: none;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-topic-input:focus {
      border-color: var(--ef-primary);
      background: var(--ef-control-bg);
      box-shadow: 0 0 0 3px var(--ef-focus-ring-input);
    }

    /* ── Component picker ──────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-component-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-component-label {
      font-size: 11px;
      color: var(--ef-muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-component-select {
      flex: 1;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-strong);
      background: var(--ef-surface-select);
      border: 1px solid var(--ef-control-border);
      border-radius: 5px;
      padding: 3px 6px;
      outline: none;
      cursor: pointer;
    }
    #__ef_dialog__ .ef-component-select:focus {
      border-color: var(--ef-primary);
      background: var(--ef-control-bg);
    }

    /* ── Target info strip ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-target-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 18px 10px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-target-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      color: var(--ef-chip-fg);
      background: var(--ef-surface-alt);
      border-radius: 4px;
      padding: 2px 7px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    #__ef_dialog__ .ef-target-chip-label {
      /* on #f2f2f2 chip — #767676 only clears 4.0:1 there */
      color: var(--ef-muted-soft);
      font-family: inherit;
    }

    /* ── Intent micro-form ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-intent {
      display: flex;
      flex-direction: column;
      gap: 7px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-intent-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    #__ef_dialog__ .ef-intent-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--ef-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      min-width: 54px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      flex: 1;
      min-width: 0;
    }
    #__ef_dialog__ .ef-chip {
      padding: 3px 11px;
      border-radius: 20px;
      border: 1.5px solid var(--ef-control-border);
      background: var(--ef-control-bg);
      color: var(--ef-muted-strong);
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      font-family: inherit;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-chip:hover { border-color: var(--ef-control-border-hover); background: var(--ef-hover-bg); }
    #__ef_dialog__ .ef-chip:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-chip.ef-chip-on {
      background: var(--ef-chip-on-bg);
      border-color: var(--ef-primary);
      color: var(--ef-chip-on-text);
    }
    #__ef_dialog__ .ef-chip.ef-chip-muted {
      /* chip hover background is #fafafa */
      color: var(--ef-muted-soft);
      border-style: dashed;
      font-weight: 400;
    }
    #__ef_dialog__ .ef-hint {
      font-size: 11px;
      color: var(--ef-muted);
      flex-basis: 100%;
      padding-left: 62px;
      line-height: 1.4;
    }

    /* Current (captured actual) read-out */
    #__ef_dialog__ .ef-current {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 9px;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      background: var(--ef-surface);
      flex: 1;
      min-width: 0;
    }
    #__ef_dialog__ .ef-swatch {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: 1px solid var(--ef-swatch-border);
      flex-shrink: 0;
      overflow: hidden;
      /* checkerboard shows through translucent colours */
      background-image:
        linear-gradient(45deg, var(--ef-swatch-checker) 25%, transparent 25%, transparent 75%, var(--ef-swatch-checker) 75%),
        linear-gradient(45deg, var(--ef-swatch-checker) 25%, transparent 25%, transparent 75%, var(--ef-swatch-checker) 75%);
      background-size: 8px 8px;
      background-position: 0 0, 4px 4px;
    }
    #__ef_dialog__ .ef-swatch > span {
      display: block;
      width: 100%;
      height: 100%;
    }
    #__ef_dialog__ .ef-current-prop {
      font-size: 11px;
      /* on #fafafa read-out background */
      color: var(--ef-muted-soft);
      flex-shrink: 0;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-current input {
      flex: 1;
      min-width: 0;
      border: none;
      background: transparent;
      padding: 2px 0;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-strong);
      outline: none;
    }

    /* ── Login card ────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-login-card {
      background: var(--ef-card-bg);
      border-radius: 10px;
      padding: 28px 24px 20px;
      width: 340px;
      max-width: calc(100vw - 32px);
      box-shadow: var(--ef-card-shadow);
    }
    #__ef_dialog__ .ef-login-card h2 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 700;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-login-card p {
      margin: 0 0 18px;
      font-size: 13px;
      color: var(--ef-muted-strong);
    }
    #__ef_dialog__ .ef-login-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    /* ── Docked rail ───────────────────────────────────────────────────────── */
    #__ef_dialog__.ef-docked {
      top: 0;
      right: 0;
      bottom: 0;
      left: auto;
      inset: 0 0 0 auto;
      width: min(400px, 100vw);
      background: transparent;
      pointer-events: none;
      align-items: stretch;
      justify-content: flex-end;
    }
    #__ef_dialog__.ef-docked .ef-card {
      pointer-events: auto;
      width: 100%;
      max-width: 100%;
      height: 100%;
      max-height: 100vh;
      border-radius: 0;
      box-shadow: -8px 0 40px rgba(0,0,0,0.22);
    }
    @media (max-width: 520px) {
      #__ef_dialog__.ef-docked { width: 100vw; }
    }
    #__ef_dialog__ .ef-dock-btn {
      background: transparent;
      border: 1px solid var(--ef-control-border);
      color: var(--ef-muted-strong);
      border-radius: 6px;
      width: 24px;
      height: 24px;
      padding: 0;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-dock-btn:hover {
      background: var(--ef-hover-bg);
      border-color: var(--ef-control-border-hover);
      color: var(--ef-text-strong);
    }
    #__ef_dialog__ .ef-dock-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }

    /* ── Shared section label ──────────────────────────────────────────────── */
    #__ef_dialog__ .ef-section-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ef-muted);
      margin-bottom: 6px;
    }

    /* ── Targets ───────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-targets {
      padding: 10px 18px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-target-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    #__ef_dialog__ .ef-target-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--ef-surface-alt);
      border: 1px solid var(--ef-border);
      border-radius: 6px;
      padding: 3px 4px 3px 6px;
      max-width: 100%;
    }
    #__ef_dialog__ .ef-target-num {
      min-width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
      background: var(--ef-accent);
      color: #fff;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      padding: 0 3px;
      box-sizing: border-box;
    }
    #__ef_dialog__ .ef-target-name {
      font-size: 11px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 190px;
    }
    #__ef_dialog__ .ef-target-remove {
      background: transparent;
      border: none;
      color: var(--ef-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 3px;
      border-radius: 4px;
      font-family: inherit;
    }
    #__ef_dialog__ .ef-target-remove:hover {
      color: var(--ef-error);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-target-add {
      background: transparent;
      border: 1px dashed var(--ef-control-border);
      color: var(--ef-primary);
      border-radius: 20px;
      padding: 3px 11px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }
    #__ef_dialog__ .ef-target-add:hover {
      background: var(--ef-hover-bg);
      border-color: var(--ef-primary);
    }
    #__ef_dialog__ .ef-target-add.ef-picking {
      background: var(--ef-chip-on-bg);
      border-style: solid;
      border-color: var(--ef-primary);
    }

    /* ── Live style editor ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-style-editor {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #__ef_dialog__ .ef-style-empty {
      font-size: 12px;
      color: var(--ef-muted);
      padding: 2px 0 4px;
    }
    #__ef_dialog__ .ef-style-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    #__ef_dialog__ .ef-style-group-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    #__ef_dialog__ .ef-style-group-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--ef-text);
    }
    #__ef_dialog__ .ef-style-current {
      font-size: 11px;
      color: var(--ef-muted);
      font-style: italic;
    }
    #__ef_dialog__ .ef-style-current-mixed {
      color: var(--ef-accent);
      font-style: normal;
      font-weight: 600;
    }
    #__ef_dialog__ .ef-token-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    #__ef_dialog__ .ef-token-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 20px;
      border: 1.5px solid var(--ef-control-border);
      background: var(--ef-control-bg);
      color: var(--ef-muted-strong);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-token-chip:hover {
      border-color: var(--ef-control-border-hover);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-token-chip:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-token-chip.ef-token-on {
      background: var(--ef-chip-on-bg);
      border-color: var(--ef-primary);
      color: var(--ef-chip-on-text);
    }
    #__ef_dialog__ .ef-token-swatch {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      border: 1px solid var(--ef-swatch-border);
      flex-shrink: 0;
      background-image:
        linear-gradient(45deg, var(--ef-swatch-checker) 25%, transparent 25%, transparent 75%, var(--ef-swatch-checker) 75%),
        linear-gradient(45deg, var(--ef-swatch-checker) 25%, transparent 25%, transparent 75%, var(--ef-swatch-checker) 75%);
      background-size: 6px 6px;
      background-position: 0 0, 3px 3px;
    }
    #__ef_dialog__ .ef-style-classes summary {
      font-size: 11px;
      color: var(--ef-muted);
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #__ef_dialog__ .ef-style-classes summary::-webkit-details-marker { display: none; }
    #__ef_dialog__ .ef-style-classes summary::before {
      content: "▶";
      font-size: 8px;
      transition: transform 0.15s;
      display: inline-block;
    }
    #__ef_dialog__ .ef-style-classes[open] summary::before { transform: rotate(90deg); }
    #__ef_dialog__ .ef-style-class-list {
      margin-top: 5px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 120px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-style-class-item {
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 11px;
    }
    #__ef_dialog__ .ef-style-class-idx {
      color: var(--ef-muted);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-style-class-item code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-soft);
      word-break: break-all;
    }
    #__ef_dialog__ .ef-style-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* ── Changes summary ───────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-changes {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #__ef_dialog__ .ef-changes-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 140px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-changes-list li {
      font-size: 11px;
      color: var(--ef-text-soft);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      display: flex;
      gap: 5px;
      align-items: baseline;
      flex-wrap: wrap;
    }
    #__ef_dialog__ .ef-change-group {
      color: var(--ef-muted-strong);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-change-before {
      color: var(--ef-muted);
      text-decoration: line-through;
    }
    #__ef_dialog__ .ef-change-after {
      color: var(--ef-primary);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-changes-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* ── Dark theme ─────────────────────────────────────────────────────────
       Keyed off data-ef-theme, mirrored onto the overlay root by theme.ts.
       Overriding the tokens above keeps every declaration theme-agnostic. */
    html[data-ef-theme="dark"] #__ef_dialog__,
    #__ef_dialog__[data-ef-theme="dark"] {
      --ef-backdrop: rgba(0,0,0,0.68);
      --ef-card-bg: #1c1f26;
      --ef-card-shadow: 0 12px 48px rgba(0,0,0,0.6);
      --ef-border: #333944;
      --ef-border-subtle: #2a2f38;
      --ef-control-border: #3a424f;
      --ef-input-border: #3a424f;
      --ef-heading: #f2f4f7;
      --ef-text: #dde1e7;
      --ef-text-soft: #c3c8d0;
      --ef-text-strong: #f2f4f7;
      --ef-muted: #9aa3b0;
      --ef-muted-strong: #b6bdc8;
      --ef-muted-soft: #9aa3b0;
      --ef-chip-fg: #c3c8d0;
      --ef-surface: #22262e;
      --ef-surface-alt: #282d36;
      --ef-surface-select: #22262e;
      --ef-control-bg: #24272d;
      --ef-hover-bg: #2b303a;
      --ef-control-border-hover: #4a5361;
      --ef-btn-secondary-bg: #2a2f38;
      --ef-btn-secondary-hover-bg: #333a45;
      --ef-btn-secondary-text: #e6e9ee;
      --ef-btn-export-bg: #eef1f5;
      --ef-btn-export-hover-bg: #ffffff;
      --ef-btn-export-text: #16181d;
      --ef-btn-export-disabled-bg: #4a505b;
      --ef-primary: #5b8def;
      --ef-primary-hover: #6f9cf2;
      --ef-primary-disabled: #33415c;
      --ef-focus-ring: rgba(91,141,239,0.25);
      --ef-focus-ring-input: rgba(91,141,239,0.2);
      --ef-focus-ring-chip: rgba(91,141,239,0.3);
      --ef-chip-on-bg: #23324f;
      --ef-chip-on-text: #9dc0ff;
      --ef-error: #ff6b6b;
      --ef-accent: #fbbf24;
      --ef-accent-soft: rgba(251,191,36,0.16);
      --ef-swatch-checker: #3a424f;
      --ef-swatch-border: rgba(255,255,255,0.18);
      --ef-code-bg: #14161c;
      --ef-code-border: #3b4152;
      --ef-code-text: #cdd6f4;
      --ef-bug-bg: #3a2226;
      --ef-bug: #ff8a94;
      --ef-enh-bg: #12293d;
      --ef-enh: #6cb6ff;
    }
  `;
  document.head.appendChild(style);
}

function getOrCreateDialog(): HTMLElement {
  let el = document.getElementById(DIALOG_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = DIALOG_ID;
    document.body.appendChild(el);
  }
  // Late-created root: mirror the current theme so CSS dark overrides apply.
  syncThemeTo(el);
  return el;
}

// ── Modal focus management ────────────────────────────────────────────────────
// The overlay is a custom <div> modal, so we implement the focus semantics a
// native <dialog> would give us: move focus inside on open, keep Tab contained,
// and return focus to the invoking element on close.

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'summary, [tabindex]:not([tabindex="-1"])';

let focusReturnEl: HTMLElement | null = null;
let dialogKeydown: ((e: KeyboardEvent) => void) | null = null;
// Escape handler owned by the submit dialog; removed on close so a mode-driven
// teardown (e.g. the activation hotkey) can't be double-handled by onCancel.
let dialogEscapeKey: ((e: KeyboardEvent) => void) | null = null;
// Teardown for the live selection subscription owned by the submit dialog.
let dialogCleanup: (() => void) | null = null;

function getFocusable(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Wire focus restoration for a dialog card. Captures the element that
 * currently has focus so closeDialog() can restore it and moves focus to the
 * card itself (a stable, non-keyboard-triggering target).
 *
 * Tab containment is only applied in modal mode (`opts.modal !== false`). The
 * docked rail is non-modal, so Tab must move out of it into the page normally.
 */
function activateDialog(card: HTMLElement, opts?: { modal?: boolean }): void {
  focusReturnEl = (document.activeElement as HTMLElement | null) ?? null;

  const modal = opts?.modal !== false;
  if (!modal) {
    card.focus();
    return;
  }

  dialogKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = getFocusable(card);
    if (items.length === 0) { e.preventDefault(); card.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === card || !card.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", dialogKeydown, true);

  card.focus();
}

export type FeedbackType = "bug" | "enhancement";

export interface SubmitFeedbackOptions {
  selector: string;
  existingComments: FeedbackComment[];
  context: Record<string, unknown>;
  user: { login: string; avatarUrl: string };
  defaultIssueTopic: string;
  repo: string;
  branch?: string;
  appVersion?: string;
  componentHierarchy?: { name: string; isChild: boolean }[];
  selectedComponentIdx?: number;
  onComponentChange?: (index: number) => void;
  /** Project theme tokens for the live style editor. */
  tokens?: ThemeTokens;
  /**
   * Live multi-select targets. Defaults to the selection module's current set
   * so index.ts can pass it explicitly without duplicating state.
   */
  getTargets?: () => TargetEntry[];
  /** Live applied style changes. Defaults to the selection module. */
  getChanges?: () => StyleChange[];
  /** Submits a comment; resolves with the new feedback ID when known. */
  onSubmit: (comment: string, type: FeedbackType, intent: FeedbackIntent) => Promise<number | void>;
  onExport: (ids: number[], type: FeedbackType, issueTopic: string) => Promise<void>;
  onCancel: () => void;
}

// ── Intent micro-form helpers ────────────────────────────────────────────────

const INTENT_ACTIONS: { value: IntentAction; label: string }[] = [
  { value: "change", label: "Change" },
  { value: "add", label: "Add" },
  { value: "remove", label: "Remove" },
  { value: "move", label: "Move" },
  { value: "fix", label: "Fix" },
  { value: "refactor", label: "Refactor" },
  { value: "investigate", label: "Investigate" },
];

/** Default action verb for a feedback type (bug → fix, enhancement → change). */
function inferAction(type: FeedbackType): IntentAction {
  return type === "bug" ? "fix" : "change";
}

interface ExpectedSuggestion {
  value: string;
  label: string;
  /** Short structured sentence written into intent.expected when tapped. */
  sentence: string;
}

/**
 * Auto-suggest "what did you expect?" chips from captured element signals.
 * Returns [] when nothing contextual applies — the caller hides the row.
 */
function buildExpectedSuggestions(
  styles: Record<string, string> | undefined,
  tagName: string
): ExpectedSuggestion[] {
  const out: ExpectedSuggestion[] = [];
  const hasColor = !!styles && !!(styles["color"] || styles["backgroundColor"]);
  const buttonish = tagName === "button" || tagName === "a" || tagName === "input";

  if (hasColor) {
    out.push({ value: "contrast", label: "More contrast", sentence: "Higher contrast — meets WCAG AA (≥ 4.5:1)" });
    out.push({ value: "darker", label: "Darker", sentence: "Darker color" });
    if (buttonish) out.push({ value: "match", label: "Match other buttons", sentence: "Match the style of other buttons" });
    out.push({ value: "different-color", label: "Different color", sentence: "A different color" });
  }
  if (styles?.["fontSize"]) {
    out.push({ value: "larger", label: "Larger", sentence: "Larger text" });
    out.push({ value: "smaller", label: "Smaller", sentence: "Smaller text" });
  }
  return out;
}

/** Pick the single most relevant captured actual value to pre-fill intent.actual. */
function pickCurrent(
  styles: Record<string, string> | undefined
): { label: string; value: string; swatch?: string } | null {
  if (!styles) return null;
  if (styles["color"]) return { label: "text color", value: styles["color"], swatch: styles["color"] };
  if (styles["backgroundColor"]) return { label: "background", value: styles["backgroundColor"], swatch: styles["backgroundColor"] };
  if (styles["fontSize"]) return { label: "font size", value: styles["fontSize"] };
  if (styles["fontWeight"]) return { label: "weight", value: styles["fontWeight"] };
  return null;
}

/** Shows the element feedback dialog: existing comments + compose area. */
export function showSubmitDialog(opts: SubmitFeedbackOptions): void {
  injectStyles();
  const dialog = getOrCreateDialog();

  // ── Dock state (default docked; persisted across pages) ────────────────────
  let docked = readDockedPref();
  const applyDockState = (card: HTMLElement | null) => {
    dialog.classList.toggle("ef-docked", docked);
    if (card) card.setAttribute("aria-modal", docked ? "false" : "true");
  };

  const tokens: ThemeTokens = opts.tokens ?? { version: 1, groups: [], source: "fallback" };

  // Live accessors — default to the selection module singletons.
  const currentTargets = (): TargetEntry[] =>
    opts.getTargets ? opts.getTargets() : getSelectionTargets();
  const currentChanges = (): StyleChange[] =>
    opts.getChanges ? opts.getChanges() : getSelectionChanges();

  const existing = opts.existingComments;
  const existingIds = existing.map((c) => c.id);
  const ctx = opts.context;

  const commentsHTML = existing.length === 0 ? "" : `
    <div class="ef-comments">
      ${existing.map((c) => `
        <div class="ef-comment-item">
          <div class="ef-comment-meta">
            <span class="ef-comment-author">@${escapeHtml(c.github_user)}</span>
            <span class="ef-comment-date">${escapeHtml(c.created_at)}</span>
          </div>
          <div class="ef-comment-text">${escapeHtml(c.comment)}</div>
        </div>`).join("")}
    </div>`;

  const title = existing.length > 0
    ? `${existing.length} comment${existing.length !== 1 ? "s" : ""} on this element`
    : "Add feedback";

  const chips: string[] = [];
  if (opts.repo)       chips.push(`<span class="ef-target-chip"><span class="ef-target-chip-label">repo</span>${escapeHtml(opts.repo)}</span>`);
  if (opts.branch)     chips.push(`<span class="ef-target-chip"><span class="ef-target-chip-label">branch</span>${escapeHtml(opts.branch)}</span>`);
  if (opts.appVersion) chips.push(`<span class="ef-target-chip"><span class="ef-target-chip-label">version</span>${escapeHtml(opts.appVersion)}</span>`);
  const targetStripHTML = chips.length > 0 ? `<div class="ef-target-strip">${chips.join("")}</div>` : "";

  const hierarchy = opts.componentHierarchy ?? [];
  const componentPickerHTML = hierarchy.length > 1 ? `
    <div class="ef-component-row">
      <span class="ef-component-label">Component</span>
      <select class="ef-component-select" id="__ef_component__">
        ${hierarchy.map((h, i) => `<option value="${i}" ${i === (opts.selectedComponentIdx ?? 0) ? "selected" : ""}>
          ${h.isChild ? "↳ " : ""}${escapeHtml(h.name)}
        </option>`).join("")}
      </select>
    </div>` : "";

  // ── Build metadata rows ────────────────────────────────────────────────────
  const metaRows: [string, string][] = [];

  // Element
  const component = ctx["dataComponent"] as string | undefined;
  if (component) metaRows.push(["component", component]);
  metaRows.push(["selector", opts.selector]);
  const br = ctx["boundingRect"] as Record<string, number> | undefined;
  if (br) metaRows.push(["position", `top ${br["top"]}, left ${br["left"]} — ${br["width"]} × ${br["height"]} px`]);

  // Page
  metaRows.push(["url", String(ctx["url"] ?? window.location.href)]);
  const vp = ctx["viewport"] as Record<string, number> | undefined;
  const dpr = ctx["devicePixelRatio"] as number | undefined;
  if (vp) metaRows.push(["viewport", `${vp["width"]} × ${vp["height"]} px${dpr && dpr !== 1 ? ` (${dpr}× DPR)` : ""}`]);

  // CSS
  const frameworks = ctx["cssFramework"] as string[] | undefined;
  if (frameworks?.length) metaRows.push(["css framework", frameworks.join(", ")]);
  const styles = ctx["computedStyles"] as Record<string, string> | undefined;
  if (styles) {
    const keyStyles = ["display", "position", "color", "backgroundColor", "fontSize", "fontFamily", "fontWeight", "padding", "margin", "borderRadius"]
      .filter((k) => styles[k])
      .map((k) => `${k}: ${styles[k]}`)
      .join("\n");
    if (keyStyles) metaRows.push(["computed styles", keyStyles]);
  }

  // Browser
  const ua = String(ctx["userAgent"] ?? navigator.userAgent);
  metaRows.push(["user agent", ua]);

  const metaHTML = metaRows.map(([k, v]) => `
    <div class="ef-meta-key">${escapeHtml(k)}</div>
    <div class="ef-meta-val">${escapeHtml(v)}</div>`).join("");

  const outerHTML = ctx["outerHTML"] as string | undefined;

  // ── Intent micro-form pieces ───────────────────────────────────────────────
  const tagName = String(ctx["tagName"] ?? "").toLowerCase();
  const suggestions = buildExpectedSuggestions(styles, tagName);
  const current = pickCurrent(styles);

  const expectedRowHTML = suggestions.length > 0 ? `
        <div class="ef-intent-row">
          <span class="ef-intent-label">Expected</span>
          <div class="ef-chips" id="__ef_expected__">
            ${suggestions.map((s) => `<button type="button" class="ef-chip${s.value === "__below__" ? " ef-chip-muted" : ""}" data-expected="${s.value}" data-sentence="${escapeHtml(s.sentence)}" aria-pressed="false">${escapeHtml(s.label)}</button>`).join("")}
          </div>
        </div>` : "";

  const currentRowHTML = current ? `
        <div class="ef-intent-row">
          <span class="ef-intent-label">Current</span>
          <div class="ef-current">
            ${current.swatch ? `<span class="ef-swatch"><span style="background:${escapeHtml(current.swatch)}"></span></span>` : ""}
            <span class="ef-current-prop">${escapeHtml(current.label)}</span>
            <input id="__ef_actual__" type="text" value="${escapeHtml(current.value)}" spellcheck="false" aria-label="Current value">
          </div>
        </div>` : "";

  dialog.innerHTML = `
    <div class="ef-card" role="dialog" aria-modal="true" aria-labelledby="__ef_title__" tabindex="-1">
      <div class="ef-header">
        <div class="ef-header-top">
          <h2 id="__ef_title__">${title}</h2>
          <div class="ef-user-pill">
            <img src="${escapeHtml(opts.user.avatarUrl)}" alt="">
            <span>${escapeHtml(opts.user.login)}</span>
          </div>
          <button class="ef-dock-btn" id="__ef_dock__" type="button" title="Dock to the side" aria-label="Dock to the side"></button>
        </div>
        <details class="ef-meta-toggle">
          <summary>Context that will be attached</summary>
          <div class="ef-meta-grid">${metaHTML}</div>
        </details>
        ${outerHTML ? `
        <details class="ef-meta-toggle">
          <summary>Element HTML</summary>
          <pre class="ef-html-preview">${highlightHTML(outerHTML)}</pre>
        </details>` : ""}
        ${buildSessionHistoryHTML(ctx)}
      </div>
      ${componentPickerHTML}
      ${targetStripHTML}
      <div class="ef-targets" id="__ef_targets__"></div>
      ${commentsHTML}
      <div class="ef-compose">
        <div id="__ef_style_editor__"></div>
        <div class="ef-changes" id="__ef_changes__"></div>
        <div class="ef-topic-row">
          <label class="ef-topic-label" for="__ef_topic__">Issue title</label>
          <input class="ef-topic-input" id="__ef_topic__" type="text" value="${escapeHtml(opts.defaultIssueTopic)}">
        </div>
        <div class="ef-type-toggle">
          <input type="radio" name="__ef_type__" id="__ef_type_bug__" value="bug">
          <label for="__ef_type_bug__">🐛 Bug</label>
          <input type="radio" name="__ef_type__" id="__ef_type_enh__" value="enhancement" checked>
          <label for="__ef_type_enh__">✨ Enhancement</label>
        </div>
        <div class="ef-intent">
          <div class="ef-intent-row">
            <span class="ef-intent-label">Action</span>
            <div class="ef-chips" id="__ef_action__"></div>
          </div>
          ${expectedRowHTML}
          ${currentRowHTML}
          <div class="ef-intent-row">
            <span class="ef-intent-label">Scope</span>
            <div class="ef-chips" id="__ef_scope__">
              <button type="button" class="ef-chip ef-chip-on" data-breadth="element" aria-pressed="true">This element</button>
              <button type="button" class="ef-chip" data-breadth="region" aria-pressed="false">Region</button>
              <button type="button" class="ef-chip" data-breadth="multi" aria-pressed="false">Multiple</button>
            </div>
            <span class="ef-hint" id="__ef_scope_hint__"></span>
          </div>
        </div>
        <textarea id="__ef_comment__" placeholder="Anything else? (optional)"></textarea>
        <div class="ef-error" id="__ef_err__"></div>
      </div>
      <div class="ef-footer">
        <button class="ef-btn-secondary" id="__ef_submit__">Save</button>
        <div class="ef-footer-spacer"></div>
        <button class="ef-btn-secondary" id="__ef_cancel__">Cancel</button>
        <button class="ef-btn-primary" id="__ef_export__">Send to GitHub</button>
      </div>
    </div>
  `;

  const card = dialog.querySelector<HTMLElement>(".ef-card")!;
  applyDockState(card);
  activateDialog(card, { modal: !docked });

  // ── Dock toggle ─────────────────────────────────────────────────────────────
  const dockBtn = dialog.querySelector<HTMLButtonElement>("#__ef_dock__")!;
  const renderDockBtn = () => {
    dockBtn.textContent = docked ? "⤢" : "▥";
    const label = docked ? "Undock to center" : "Dock to the side";
    dockBtn.title = label;
    dockBtn.setAttribute("aria-label", label);
  };
  renderDockBtn();
  dockBtn.addEventListener("click", () => {
    docked = !docked;
    writeDockedPref(docked);
    applyDockState(card);
    renderDockBtn();
  });

  const textarea = dialog.querySelector<HTMLTextAreaElement>("#__ef_comment__")!;
  const submitBtn = dialog.querySelector<HTMLButtonElement>("#__ef_submit__")!;
  const cancelBtn = dialog.querySelector<HTMLButtonElement>("#__ef_cancel__")!;
  const exportBtn = dialog.querySelector<HTMLButtonElement>("#__ef_export__")!;
  const errDiv = dialog.querySelector<HTMLElement>("#__ef_err__")!;

  const componentSelect = dialog.querySelector<HTMLSelectElement>("#__ef_component__");
  if (componentSelect && opts.onComponentChange) {
    componentSelect.addEventListener("change", () => {
      opts.onComponentChange!(parseInt(componentSelect.value, 10));
    });
  }

  const getType = (): FeedbackType => {
    const checked = dialog.querySelector<HTMLInputElement>("input[name='__ef_type__']:checked");
    return (checked?.value ?? "enhancement") as FeedbackType;
  };

  const getIssueTopic = (): string => {
    const input = dialog.querySelector<HTMLInputElement>("#__ef_topic__");
    return input?.value.trim() || opts.defaultIssueTopic;
  };

  // ── Intent micro-form state + wiring ───────────────────────────────────────
  const actionWrap = dialog.querySelector<HTMLElement>("#__ef_action__")!;
  const expectedWrap = dialog.querySelector<HTMLElement>("#__ef_expected__");
  const scopeWrap = dialog.querySelector<HTMLElement>("#__ef_scope__")!;
  const scopeHint = dialog.querySelector<HTMLElement>("#__ef_scope_hint__")!;
  const actualInput = dialog.querySelector<HTMLInputElement>("#__ef_actual__");

  // ── Targets + live style editor + changes summary ───────────────────────────
  const targetsHost = dialog.querySelector<HTMLElement>("#__ef_targets__")!;
  const styleHost = dialog.querySelector<HTMLElement>("#__ef_style_editor__")!;
  const changesHost = dialog.querySelector<HTMLElement>("#__ef_changes__")!;

  const targetLabel = (t: TargetEntry): string => {
    if (t.dataComponent) return t.dataComponent;
    const tail = t.selector.split(">").pop()?.trim();
    return tail || t.selector;
  };

  const renderTargets = () => {
    const targets = currentTargets();
    const picking = isPickMode();
    const addBtn = `<button type="button" class="ef-target-add${picking ? " ef-picking" : ""}" id="__ef_add_target__">+ Add element</button>`;
    if (targets.length === 0) {
      targetsHost.innerHTML = `<div class="ef-section-label">Targets</div><div class="ef-target-list">${addBtn}</div>`;
    } else {
      targetsHost.innerHTML = `
        <div class="ef-section-label">Targets</div>
        <div class="ef-target-list">
          ${targets.map((t, i) => `<span class="ef-target-item"><span class="ef-target-num">${i + 1}</span><span class="ef-target-name" title="${escapeHtml(t.selector)}">${escapeHtml(targetLabel(t))}</span><button type="button" class="ef-target-remove" data-idx="${i}" aria-label="Remove target">×</button></span>`).join("")}
          ${addBtn}
        </div>`;
    }
    targetsHost.querySelector<HTMLButtonElement>("#__ef_add_target__")?.addEventListener("click", () => {
      setPickMode(!isPickMode());
      renderTargets();
    });
    targetsHost.querySelectorAll<HTMLButtonElement>(".ef-target-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx ?? "-1", 10);
        const t = currentTargets()[idx];
        if (t) removeSelectionTarget(t.el);
      });
    });
  };

  const renderStyle = () => {
    mountStyleEditor(styleHost, tokens, currentTargets(), currentChanges().length, {
      onApply: (group, token) => applyTokenToTargets(group, token),
      onRevertAll: () => revertSelectionChanges(),
    });
  };

  const renderChanges = () => {
    const changes = currentChanges();
    if (changes.length === 0) {
      changesHost.innerHTML = "";
      return;
    }
    changesHost.innerHTML = `
      <div class="ef-section-label">Changes (${changes.length})</div>
      <ul class="ef-changes-list">
        ${changes.map((c) => `<li><span class="ef-change-group">${escapeHtml(c.group)}</span><span class="ef-change-before">${escapeHtml(c.before || "—")}</span><span>→</span><span class="ef-change-after">${escapeHtml(c.after)}</span></li>`).join("")}
      </ul>
      <div class="ef-changes-actions"><button type="button" class="ef-btn-secondary" id="__ef_revert__">Revert all</button></div>`;
    changesHost.querySelector<HTMLButtonElement>("#__ef_revert__")?.addEventListener("click", () => {
      revertSelectionChanges();
    });
  };

  const renderSelection = () => {
    renderTargets();
    renderStyle();
    renderChanges();
  };

  let action: IntentAction = inferAction(getType());
  let actionTouched = false;
  let expected = "";
  // True once the human edits the prefilled "Current" value. Drives provenance:
  // browser-prefilled actual is `captured`; human-edited actual is `stated`.
  let actualEdited = false;
  let breadth: ScopeBreadth = "element";

  const renderActions = () => {
    actionWrap.innerHTML = INTENT_ACTIONS.map((a) =>
      `<button type="button" class="ef-chip${a.value === action ? " ef-chip-on" : ""}" data-action="${a.value}" aria-pressed="${a.value === action}">${a.label}</button>`
    ).join("");
  };
  renderActions();

  actionWrap.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!btn) return;
    action = btn.dataset.action as IntentAction;
    actionTouched = true;
    renderActions();
  });

  dialog.querySelectorAll<HTMLInputElement>("input[name='__ef_type__']").forEach((inp) => {
    inp.addEventListener("change", () => {
      if (!actionTouched) { action = inferAction(getType()); renderActions(); }
    });
  });

  if (expectedWrap) {
    const expBtns = Array.from(expectedWrap.querySelectorAll<HTMLButtonElement>("[data-expected]"));
    const clearExpected = () => expBtns.forEach((b) => {
      b.classList.remove("ef-chip-on");
      b.setAttribute("aria-pressed", "false");
    });
    expBtns.forEach((btn) => btn.addEventListener("click", () => {
      const val = btn.dataset.expected ?? "";
      if (val === "__below__") { expected = ""; clearExpected(); textarea.focus(); return; }
      const wasOn = btn.classList.contains("ef-chip-on");
      clearExpected();
      if (wasOn) { expected = ""; return; } // tap again to clear
      btn.classList.add("ef-chip-on");
      btn.setAttribute("aria-pressed", "true");
      expected = btn.dataset.sentence ?? "";
    }));
  }

  const renderScopeHint = () => {
    const n = currentTargets().length;
    if (n > 1) {
      scopeHint.textContent = `Applies to all ${n} selected targets.`;
      return;
    }
    scopeHint.textContent = breadth === "element"
      ? ""
      : "Region selection isn't captured — the selected element is recorded.";
  };

  scopeWrap.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-breadth]");
    if (!btn) return;
    breadth = (btn.dataset.breadth ?? "element") as ScopeBreadth;
    scopeWrap.querySelectorAll<HTMLButtonElement>("[data-breadth]").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("ef-chip-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    renderScopeHint();
  });

  // Any edit (including clearing the field) marks the actual value as stated.
  actualInput?.addEventListener("input", () => { actualEdited = true; });
  actualInput?.addEventListener("change", () => { actualEdited = true; });

  /** Build the structured intent passed to onSubmit as the third argument. */
  const buildIntent = (): FeedbackIntent => {
    const actualVal = actualInput?.value.trim();
    const targets = currentTargets();
    const changes = currentChanges();
    const targetSelectors =
      targets.length > 0 ? targets.map((t) => t.selector) : [opts.selector];
    const intent: FeedbackIntent = {
      kind: getType(),
      action,
      expected: expected.trim() || undefined,
      actual: actualVal ? `${current ? current.label + ": " : ""}${actualVal}` : undefined,
      actualEdited,
      scope: {
        // Multi-target editing is a genuine multi selection; otherwise honour
        // the user's own scope chip.
        breadth: targetSelectors.length > 1 ? "multi" : breadth,
        targets: targetSelectors,
      },
    };
    if (changes.length > 0) intent.changes = changes;
    return intent;
  };

  /**
   * Comment text for the legacy explanation field. Falls back to a concise
   * sentence assembled from the structured chips so a chip-only report still
   * satisfies the server's non-empty comment contract.
   */
  const collectComment = (): string => {
    const raw = textarea.value.trim();
    if (raw) return raw;
    const parts: string[] = [];
    if (expected.trim()) parts.push(expected.trim());
    const actualVal = actualInput?.value.trim();
    if (actualEdited && actualVal && current) parts.push(`currently ${current.label}: ${actualVal}`);
    return parts.join(" — ");
  };

  // No autofocus: the intent chips are the primary surface, and focusing the
  // (now last) textarea would scroll them out of view and pop the mobile keyboard.

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      removeKey();
      closeDialog();
      opts.onCancel();
    }
  };
  const removeKey = () => {
    document.removeEventListener("keydown", onKey);
    if (dialogEscapeKey === onKey) dialogEscapeKey = null;
  };
  document.addEventListener("keydown", onKey);
  dialogEscapeKey = onKey;

  cancelBtn.addEventListener("click", () => {
    removeKey();
    closeDialog();
    opts.onCancel();
  });

  submitBtn.addEventListener("click", async () => {
    const comment = collectComment();
    if (!comment) { errDiv.textContent = "Add a note or choose what you expected."; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    errDiv.textContent = "";
    try {
      await opts.onSubmit(comment, getType(), buildIntent());
      removeKey();
      closeDialog();
    } catch (err) {
      errDiv.textContent = String(err);
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });

  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting…";
    submitBtn.disabled = true;
    errDiv.textContent = "";
    try {
      const comment = collectComment();
      const type = getType();
      const topic = getIssueTopic();
      let ids = [...existingIds];
      if (comment) {
        // Submit the new comment first, then include its ID in the export.
        const newId = await opts.onSubmit(comment, type, buildIntent());
        if (typeof newId === "number") ids = [...ids, newId];
      }
      if (ids.length === 0) {
        errDiv.textContent = "Nothing to export — add a note or choose what you expected.";
        exportBtn.disabled = false;
        exportBtn.textContent = "Send to GitHub";
        submitBtn.disabled = false;
        return;
      }
      // Close immediately — export happens in background.
      removeKey();
      closeDialog();
      opts.onExport(ids, type, topic).catch((err: unknown) => {
        showToast(`Failed to create issue: ${String(err)}`);
      });
    } catch (err) {
      errDiv.textContent = String(err);
      exportBtn.disabled = false;
      exportBtn.textContent = "Send to GitHub";
      submitBtn.disabled = false;
    }
  });

  // Initial render + keep selection-driven sections live as the user picks.
  renderSelection();
  renderScopeHint();
  const unsubSelection = onSelectionChange(() => {
    renderSelection();
    renderScopeHint();
  });
  dialogCleanup = unsubSelection;

  // Backdrop click to cancel — modal only. The docked rail is click-through
  // (pointer-events: none), so this never fires while docked.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && !docked) { removeKey(); closeDialog(); opts.onCancel(); }
  });
}

export interface LoginDialogOptions {
  onLogin: () => Promise<void>;
  onCancel: () => void;
}

export function showLoginDialog(opts: LoginDialogOptions): void {
  injectStyles();
  const dialog = getOrCreateDialog();

  dialog.innerHTML = `
    <div class="ef-login-card" role="dialog" aria-modal="true" aria-labelledby="__ef_login_title__" tabindex="-1">
      <h2 id="__ef_login_title__">Sign in with GitHub</h2>
      <p>Authentication required to submit feedback.</p>
      <div class="ef-login-actions">
        <button class="ef-btn-secondary" id="__ef_cancel__">Cancel</button>
        <button class="ef-btn-primary" id="__ef_login__">Sign in with GitHub</button>
      </div>
      <div class="ef-error" id="__ef_err__" style="margin-top:8px"></div>
    </div>
  `;

  const card = dialog.querySelector<HTMLElement>(".ef-login-card")!;
  activateDialog(card);

  const loginBtn = dialog.querySelector<HTMLButtonElement>("#__ef_login__")!;
  const cancelBtn = dialog.querySelector<HTMLButtonElement>("#__ef_cancel__")!;
  const errDiv = dialog.querySelector<HTMLElement>("#__ef_err__")!;

  loginBtn.addEventListener("click", async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = "Opening…";
    try {
      await opts.onLogin();
      closeDialog();
    } catch (err) {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign in with GitHub";
      errDiv.textContent = String(err);
    }
  });

  cancelBtn.addEventListener("click", () => { closeDialog(); opts.onCancel(); });

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) { closeDialog(); opts.onCancel(); }
  });
}

export function closeDialog(): void {
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return;
  if (dialogKeydown) {
    document.removeEventListener("keydown", dialogKeydown, true);
    dialogKeydown = null;
  }
  if (dialogEscapeKey) {
    document.removeEventListener("keydown", dialogEscapeKey);
    dialogEscapeKey = null;
  }
  if (dialogCleanup) {
    dialogCleanup();
    dialogCleanup = null;
  }
  dialog.remove();
  // Return focus to the control that opened the dialog, if it still exists.
  const ret = focusReturnEl;
  focusReturnEl = null;
  if (ret && document.contains(ret) && typeof ret.focus === "function") {
    try { ret.focus(); } catch { /* element may have been removed */ }
  }
}

const TOAST_ID = "__ef_toast__";

function injectToastStyles(): void {
  if (document.getElementById(TOAST_ID + "_styles")) return;
  const style = document.createElement("style");
  style.id = TOAST_ID + "_styles";
  style.textContent = `
    #${TOAST_ID} {
      /* Theme tokens — light defaults; overridden under [data-ef-theme="dark"]. */
      --ef-toast-bg: #1a1a1a;
      --ef-toast-text: #ffffff;
      --ef-toast-shadow: 0 4px 20px rgba(0,0,0,0.3);
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: var(--ef-toast-bg);
      color: var(--ef-toast-text);
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 500;
      box-shadow: var(--ef-toast-shadow);
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      max-width: 360px;
    }
    #${TOAST_ID}.ef-visible {
      opacity: 1;
    }
    html[data-ef-theme="dark"] #${TOAST_ID},
    #${TOAST_ID}[data-ef-theme="dark"] {
      --ef-toast-bg: #2a2f38;
      --ef-toast-text: #f2f4f7;
      --ef-toast-shadow: 0 4px 24px rgba(0,0,0,0.55);
    }
  `;
  document.head.appendChild(style);
}

export function showToast(message: string): void {
  injectToastStyles();
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOAST_ID;
    document.body.appendChild(el);
  }
  syncThemeTo(el);
  el.textContent = message;
  el.classList.add("ef-visible");
  clearTimeout((el as any).__ef_toast_timer);
  (el as any).__ef_toast_timer = setTimeout(() => {
    el!.classList.remove("ef-visible");
  }, 3000);
}


// ── HTML syntax highlighter ──────────────────────────────────────────────────
// Tokenises raw HTML and returns a highlighted string safe to inject as
// innerHTML into a <pre>. No external deps.
function highlightHTML(raw: string): string {
  // Regex that matches one HTML token at a time.
  const TOKEN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?([\w:-]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>|[^<]+/gi;
  const ATTR  = /([\w:-]+)(\s*=\s*(?:"([^"]*)")|'([^']*)'|([^\s>]*))?/g;

  const e = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  function span(cls: string, text: string): string {
    return `<span class="${cls}">${text}</span>`;
  }

  // Indent tracker.
  let indent = 0;
  const INDENT_SIZE = 2;
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);

  function pad(): string { return " ".repeat(indent * INDENT_SIZE); }

  const out: string[] = [];

  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;

  while ((match = TOKEN.exec(raw)) !== null) {
    const full = match[0];
    const tagName = match[1];

    // Comment / doctype
    if (full.startsWith("<!--") || full.startsWith("<!")) {
      out.push(pad() + span("ef-hd", e(full)) + "\n");
      continue;
    }

    // Text node — skip blank whitespace-only nodes
    if (!full.startsWith("<")) {
      const text = full.trim();
      if (text) out.push(pad() + e(text) + "\n");
      continue;
    }

    const isClose  = full.startsWith("</");
    const isSelf   = full.endsWith("/>") || (tagName && VOID.has(tagName.toLowerCase()));

    if (isClose) indent = Math.max(0, indent - 1);

    // Build highlighted tag string.
    let tag = span("ef-hp", "&lt;") + (isClose ? span("ef-hp", "/") : "");
    tag += span("ef-ht", e(tagName ?? ""));

    // Highlight attributes.
    const attrStr = match[2] ?? "";
    if (attrStr.trim()) {
      ATTR.lastIndex = 0;
      let am: RegExpExecArray | null;
      while ((am = ATTR.exec(attrStr)) !== null) {
        const name = am[1];
        const rest = am[2] ?? ""; // includes the = and value
        tag += " " + span("ef-ha", e(name));
        if (rest) {
          // split off = and value
          const eqIdx = rest.indexOf("=");
          const val = rest.slice(eqIdx + 1).trim();
          tag += span("ef-hp", "=") + span("ef-hv", e(val));
        }
      }
    }

    tag += (isSelf && !isClose ? span("ef-hp", " /&gt;") : span("ef-hp", "&gt;"));

    out.push(pad() + tag + "\n");

    if (!isClose && !isSelf) indent++;
  }

  return out.join("").trimEnd();
}

// ── Session history ───────────────────────────────────────────────────────────
function buildSessionHistoryHTML(ctx: Record<string, unknown>): string {
  const raw = ctx["sessionHistory"];
  if (!Array.isArray(raw) || raw.length === 0) return "";

  const lines: string[] = [];
  for (const ev of raw) {
    const t = typeof ev === "object" && ev ? (ev as any) : null;
    if (!t || !t.type || !t.data) continue;
    const time = formatTime(t.timestamp);
    switch (t.type) {
      case "navigation": {
        const prev = shortenURL(t.data.previousUrl);
        const url = shortenURL(t.data.url);
        lines.push(`<div class="ef-history-line"><span class="ef-history-type">nav</span> ${time} ${escapeHtml(prev)} → ${escapeHtml(url)}</div>`);
        break;
      }
      case "input": {
        const comp = t.data.component ? ` [${escapeHtml(t.data.component)}]` : "";
        const val = String(t.data.value ?? "");
        const valDisplay = val.length > 60 ? val.slice(0, 57) + "..." : val;
        lines.push(`<div class="ef-history-line"><span class="ef-history-type">input</span> ${time} ${escapeHtml(String(t.data.tagName ?? ""))}${comp} = "${escapeHtml(valDisplay)}"</div>`);
        break;
      }
      case "click": {
        const comp = t.data.component ? ` [${escapeHtml(t.data.component)}]` : "";
        const txt = t.data.text ? ` "${escapeHtml(String(t.data.text))}"` : "";
        lines.push(`<div class="ef-history-line"><span class="ef-history-type">click</span> ${time} ${escapeHtml(String(t.data.tagName ?? ""))}${comp}${txt}</div>`);
        break;
      }
    }
  }

  if (lines.length === 0) return "";

  return `
    <details class="ef-meta-toggle">
      <summary>Session history (last ${lines.length} events)</summary>
      <div class="ef-history-list">${lines.join("")}</div>
    </details>`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function shortenURL(url: string): string {
  if (!url) return "(initial page)";
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash || "/";
  } catch {
    return url.length > 80 ? url.slice(0, 77) + "..." : url;
  }
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
