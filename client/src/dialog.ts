// dialog.ts — submission-first feedback dialog: the GitHub-issue card is the
// primary surface, with an optional live style editor sidebar behind it, plus
// the login/grant dialogs.

import {
  APIError,
  AuthCancelledError,
  describeAPIError,
  withAuthRetry,
} from "./api";
import type { FeedbackComment, ExportIssueResult } from "./api";
import type {
  FeedbackIntent,
  IntentAction,
  ScopeBreadth,
  StyleChange,
} from "./envelope";
import { syncThemeTo } from "./theme";
import { mountStyleEditor } from "./styleEditor";
import { layoutAxis, type DropTarget } from "./structure";
import type { ThemeTokens } from "./tokens";
import {
  applyTokenToTarget,
  clearCommitted,
  clearTextForTarget,
  clearTokenForTarget,
  commitChanges,
  flash as flashTarget,
  getAllChanges,
  getChangeCount,
  getChangeCountFor,
  getChangesFor,
  getCommittedEntries,
  getTargets as getSelectionTargets,
  isPickMode,
  notifySelectionChange,
  onHighlightChange,
  onSelectionChange,
  refreshOutlines,
  removeCommittedAt,
  removeTarget as removeSelectionTarget,
  revertPending,
  setHighlight,
  setPickMode,
  setTextForTarget,
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

// ── Draft persistence (in-memory + sessionStorage) ────────────────────────────
// Persists only the text fields (comment, issue title, type) keyed by page URL
// + selector. Storage is best-effort: failures never break submission.

interface DraftState {
  comment: string;
  title: string;
  type: FeedbackType;
}

function draftKey(selector: string): string {
  try {
    return `__ef_draft__:${window.location.href}|${selector}`;
  } catch {
    return `__ef_draft__:${selector}`;
  }
}

function saveDraft(selector: string, draft: DraftState): void {
  try {
    sessionStorage.setItem(draftKey(selector), JSON.stringify(draft));
  } catch { /* storage unavailable */ }
}

function loadDraft(selector: string): DraftState | null {
  try {
    const raw = sessionStorage.getItem(draftKey(selector));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      comment: typeof parsed.comment === "string" ? parsed.comment : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      type: parsed.type === "bug" ? "bug" : "enhancement",
    };
  } catch {
    return null;
  }
}

function clearDraft(selector: string): void {
  try { sessionStorage.removeItem(draftKey(selector)); } catch { /* ignore */ }
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
      --ef-card-bg: oklch(1 0 0);
      --ef-card-shadow: 0 12px 48px rgba(0,0,0,0.28);
      --ef-border: oklch(0.93 0.006 274);
      --ef-border-subtle: oklch(0.975 0.004 274);
      --ef-control-border: color-mix(in oklab, oklch(0.93 0.006 274) 80%, oklch(0.30 0.018 274) 20%);
      --ef-input-border: color-mix(in oklab, oklch(0.93 0.006 274) 68%, oklch(0.30 0.018 274) 32%);
      --ef-heading: oklch(0.30 0.018 274);
      --ef-text: color-mix(in oklab, oklch(0.30 0.018 274) 85%, oklch(1 0 0) 15%);
      --ef-text-soft: color-mix(in oklab, oklch(0.30 0.018 274) 76%, oklch(1 0 0) 24%);
      --ef-text-strong: color-mix(in oklab, oklch(0.30 0.018 274) 92%, oklch(1 0 0) 8%);
      --ef-muted: color-mix(in oklab, oklch(0.30 0.018 274) 40%, oklch(1 0 0) 60%);
      --ef-muted-strong: color-mix(in oklab, oklch(0.30 0.018 274) 55%, oklch(1 0 0) 45%);
      --ef-muted-soft: color-mix(in oklab, oklch(0.30 0.018 274) 50%, oklch(1 0 0) 50%);
      --ef-chip-fg: color-mix(in oklab, oklch(0.30 0.018 274) 65%, oklch(1 0 0) 35%);
      --ef-surface: oklch(0.975 0.004 274);
      --ef-surface-alt: oklch(0.93 0.006 274);
      --ef-surface-select: oklch(0.975 0.004 274);
      --ef-control-bg: oklch(1 0 0);
      --ef-hover-bg: oklch(0.975 0.004 274);
      --ef-control-border-hover: color-mix(in oklab, oklch(0.93 0.006 274) 55%, oklch(0.30 0.018 274) 45%);
      --ef-btn-secondary-bg: oklch(0.975 0.004 274);
      --ef-btn-secondary-hover-bg: oklch(0.93 0.006 274);
      --ef-btn-secondary-text: oklch(0.30 0.018 274);
      --ef-primary: oklch(0.60 0.12 78);
      --ef-primary-hover: oklch(0.56 0.115 78);
      --ef-primary-disabled: color-mix(in oklab, oklch(0.60 0.12 78) 45%, oklch(1 0 0) 55%);
      --ef-primary-content: oklch(0.2 0.04 78);
      --ef-focus-ring: oklch(0.60 0.12 78 / 0.15);
      --ef-focus-ring-input: oklch(0.60 0.12 78 / 0.12);
      --ef-focus-ring-chip: oklch(0.60 0.12 78 / 0.2);
      --ef-chip-on-bg: color-mix(in oklab, oklch(0.60 0.12 78) 15%, oklch(1 0 0) 85%);
      --ef-chip-on-text: oklch(0.50 0.115 78);
      --ef-error: oklch(0.55 0.19 26);
      --ef-accent: oklch(0.58 0.13 162);
      --ef-accent-content: oklch(0.17 0.04 162);
      --ef-accent-soft: oklch(0.58 0.13 162 / 0.12);
      --ef-swatch-checker: oklch(0.93 0.006 274);
      --ef-swatch-border: oklch(0.30 0.018 274 / 0.15);
      --ef-code-bg: oklch(0.135 0.012 274);
      --ef-code-border: oklch(0.175 0.014 274);
      --ef-code-text: oklch(0.93 0.008 265);
      --ef-bug-bg: color-mix(in oklab, oklch(0.55 0.19 26) 12%, oklch(1 0 0) 88%);
      --ef-bug: oklch(0.55 0.19 26);
      --ef-enh-bg: color-mix(in oklab, oklch(0.52 0.12 240) 12%, oklch(1 0 0) 88%);
      --ef-enh: oklch(0.52 0.12 240);
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
      width: 50vw;
      min-width: min(480px, calc(100vw - 32px));
      max-width: min(900px, calc(100vw - 32px));
      max-height: 85vh;
      box-shadow: var(--ef-card-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Only the card of the active view is visible. Both stay mounted so typed
       text, chip state and live style edits survive a view swap. */
    #__ef_dialog__ .ef-card[hidden] { display: none !important; }
    /* Submit view: the issue card is always centered and the modal layer draws
       its own backdrop, so the root steps aside (no double dimming) and never
       docks or reflows the host page. */
    #__ef_dialog__[data-view="submit"] {
      background: transparent;
      pointer-events: none;
    }
    #__ef_dialog__[data-view="submit"] .ef-issue-modal { pointer-events: auto; }
    /* Editor steps aside while the user picks an element on the page. */
    #__ef_dialog__.ef-modal-picking { display: none !important; }
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
      /* Compact single line in the editor header — never grows the header. */
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Scrollable editor body ───────────────────────────────────────────── */
    /* The editor is a single scrolling column under its header. */
    #__ef_dialog__ .ef-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    #__ef_dialog__ .ef-design-body {
      padding: 16px 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 22px;
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
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px 20px;
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
    #__ef_dialog__ .ef-btn-primary { background: var(--ef-primary); color: var(--ef-primary-content); }
    #__ef_dialog__ .ef-btn-primary:hover { background: var(--ef-primary-hover); }
    #__ef_dialog__ .ef-btn-primary:disabled { background: var(--ef-primary-disabled); cursor: default; }
    #__ef_dialog__ .ef-btn-secondary { background: var(--ef-btn-secondary-bg); color: var(--ef-btn-secondary-text); }
    #__ef_dialog__ .ef-btn-secondary:hover { background: var(--ef-btn-secondary-hover-bg); }

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
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    #__ef_dialog__ .ef-intent-label {
      font-size: 10px;
      font-weight: 700;
      color: var(--ef-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      width: 100%;
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
      padding-left: 0;
      line-height: 1.4;
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

    /* ── Auth layer ───────────────────────────────────────────────────────────
       Login / grant prompts are a fixed overlay appended inside #__ef_dialog__,
       stacked above the issue modal so re-auth never replaces the dialog's
       innerHTML (an open draft survives). Removed independently of the rest. */
    #__ef_dialog__ .ef-auth-layer {
      position: fixed;
      inset: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--ef-backdrop);
      pointer-events: auto;
    }
    #__ef_dialog__ .ef-auth-layer[hidden] { display: none; }

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
      min-width: 0;
      max-width: 100%;
      height: 100%;
      max-height: 100vh;
      border-radius: 0;
      box-shadow: -8px 0 40px rgba(0,0,0,0.22);
    }
    @media (max-width: 520px) {
      #__ef_dialog__.ef-docked { width: 100vw; }
    }
    /* Docked rail sits alongside the page: reserve its width so content reflows
       instead of being overlaid. */
    html.ef-dock-active { margin-right: var(--ef-dock-w, 400px) !important; }
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

    /* ── Targets (per-element tabs) ────────────────────────────────────────── */
    #__ef_dialog__ .ef-targets {
      padding: 12px 18px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-target-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    #__ef_dialog__ .ef-target-tablist {
      display: contents;
    }
    #__ef_dialog__ .ef-target-tab {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--ef-surface);
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      padding: 4px 4px 4px 7px;
      max-width: 100%;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    #__ef_dialog__ .ef-target-tab:hover { border-color: var(--ef-control-border-hover); }
    /* Reverse hover: the pointer is over this target's element on the page. */
    #__ef_dialog__ .ef-target-tab--peek { border-color: var(--ef-primary); }
    /* The explicit "unset" control reads as an action, not as a value. */
    #__ef_dialog__ .ef-token-default,
    #__ef_dialog__ .ef-select-default {
      color: var(--ef-muted-strong);
      font-style: italic;
    }
    #__ef_dialog__ .ef-token-default.ef-token-on,
    #__ef_dialog__ .ef-select-default.ef-token-on {
      color: var(--ef-primary);
    }
    #__ef_dialog__ .ef-target-tab[aria-selected="true"] {
      background: var(--ef-chip-on-bg);
      border-color: var(--ef-primary);
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
    }
    #__ef_dialog__ .ef-target-tab:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-target-num {
      min-width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
      background: var(--ef-accent);
      color: var(--ef-accent-content);
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      padding: 0 3px;
      box-sizing: border-box;
    }
    #__ef_dialog__ .ef-target-tab[aria-selected="true"] .ef-target-num {
      background: var(--ef-primary);
      color: var(--ef-primary-content);
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
      gap: 16px;
    }
    #__ef_dialog__ .ef-style-empty {
      font-size: 12px;
      color: var(--ef-muted);
      padding: 2px 0 4px;
    }
    #__ef_dialog__ .ef-style-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--ef-border-subtle);
    }
    #__ef_dialog__ .ef-style-target-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ef-muted);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-style-target-sel {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: var(--ef-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Where the element sits in its parent + the "drag to move" affordance. */
    #__ef_dialog__ .ef-style-structure {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 8px 0 12px;
      border-bottom: 1px solid var(--ef-border-subtle);
    }
    #__ef_dialog__ .ef-style-position {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: var(--ef-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-style-drag-hint {
      margin-left: auto;
      font-size: 10px;
      color: var(--ef-muted);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-prop-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-prop-label {
      flex: 0 0 auto;
      width: 94px;
      padding-top: 5px;
      font-size: 11px;
      font-weight: 600;
      color: var(--ef-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-prop-control {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    /* Direct-text row: a single-line input + Reset, same chrome as dropdowns. */
    #__ef_dialog__ .ef-text-field {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-text-input {
      flex: 1;
      min-width: 0;
      padding: 4px 9px;
      border: 1.5px solid var(--ef-control-border);
      border-radius: 6px;
      background: var(--ef-control-bg);
      color: var(--ef-text);
      font-family: inherit;
      font-size: 12px;
      line-height: 1.5;
    }
    #__ef_dialog__ .ef-text-input:focus {
      outline: none;
      border-color: var(--ef-primary);
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-text-reset {
      flex-shrink: 0;
      background: transparent;
      border: none;
      padding: 0;
      color: var(--ef-primary);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
    }
    #__ef_dialog__ .ef-text-reset:hover { text-decoration: underline; }
    #__ef_dialog__ .ef-text-reset[hidden] { display: none; }
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
    /* ── Icon rows (glyph buttons) ─────────────────────────────────────────── */
    #__ef_dialog__ .ef-icon-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    #__ef_dialog__ .ef-icon-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      justify-content: center;
      border-radius: 8px;
    }
    #__ef_dialog__ .ef-icon-btn svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #__ef_dialog__ .ef-icon-btn:hover {
      border-color: var(--ef-control-border-hover);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-icon-btn.ef-token-on {
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
    #__ef_dialog__ .ef-custom-toggle {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 20px;
      border: 1.5px dashed var(--ef-control-border);
      background: transparent;
      color: var(--ef-muted-strong);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-custom-toggle:hover {
      border-color: var(--ef-control-border-hover);
      background: var(--ef-hover-bg);
      color: var(--ef-text-strong);
    }
    #__ef_dialog__ .ef-custom-toggle:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-custom-field[hidden] { display: none; }
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
    #__ef_dialog__ .ef-style-section {
      border-top: 1px solid var(--ef-border-subtle);
      padding-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #__ef_dialog__ .ef-style-section + .ef-style-section {
      margin-top: 14px;
    }
    #__ef_dialog__ .ef-style-section:first-child {
      border-top: none;
      padding-top: 0;
      margin-top: 0;
    }
    #__ef_dialog__ .ef-style-section-body {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    #__ef_dialog__ .ef-style-section > summary {
      font-size: 11px;
      font-weight: 600;
      color: var(--ef-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #__ef_dialog__ .ef-style-section > summary::-webkit-details-marker { display: none; }
    #__ef_dialog__ .ef-style-section > summary::before {
      content: "▶";
      font-size: 8px;
      transition: transform 0.15s;
      display: inline-block;
    }
    #__ef_dialog__ .ef-style-section[open] > summary::before { transform: rotate(90deg); }
    #__ef_dialog__ .ef-style-hidden-note {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding-block: 10px 0;
      border-top: 1px solid var(--ef-border-subtle);
      font-size: 11px;
    }
    #__ef_dialog__ .ef-hidden-reasons {
      color: var(--ef-muted);
      flex: 1;
      min-width: 0;
      line-height: 1.4;
    }
    #__ef_dialog__ .ef-show-all {
      background: transparent;
      border: none;
      padding: 0;
      color: var(--ef-primary);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-show-all:hover { text-decoration: underline; }
    #__ef_dialog__ .ef-select {
      position: relative;
    }
    #__ef_dialog__ .ef-select-trigger {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 5px 9px;
      border: 1.5px solid var(--ef-control-border);
      border-radius: 6px;
      background: var(--ef-control-bg);
      color: var(--ef-muted-strong);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.1s, background 0.1s;
    }
    #__ef_dialog__ .ef-select-trigger:hover {
      border-color: var(--ef-control-border-hover);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-select-trigger:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-select-caret {
      margin-left: auto;
      color: var(--ef-muted);
      font-size: 10px;
      line-height: 1;
    }
    #__ef_dialog__ .ef-select-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      z-index: 20;
      margin: 0;
      padding: 4px;
      list-style: none;
      background: var(--ef-card-bg);
      border: 1px solid var(--ef-border);
      border-radius: 6px;
      box-shadow: var(--ef-card-shadow);
      max-height: 220px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-select-option {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      border-radius: 5px;
      font-size: 12px;
      color: var(--ef-text);
      cursor: pointer;
      outline: none;
    }
    #__ef_dialog__ .ef-select-option:hover,
    #__ef_dialog__ .ef-select-option:focus-visible {
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-select-option.ef-token-on {
      background: var(--ef-chip-on-bg);
      color: var(--ef-chip-on-text);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-select-sep {
      height: 1px;
      margin: 4px 2px;
      background: var(--ef-border-subtle);
      list-style: none;
    }
    #__ef_dialog__ .ef-select-custom {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      color: var(--ef-primary);
      cursor: pointer;
      outline: none;
    }
    #__ef_dialog__ .ef-select-custom:hover,
    #__ef_dialog__ .ef-select-custom:focus-visible {
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-select-custom-edit {
      padding: 4px 4px 2px;
      list-style: none;
    }
    #__ef_dialog__ .ef-select-custom-edit[hidden] { display: none; }
    #__ef_dialog__ .ef-custom-input {
      width: 100%;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-strong);
      outline: none;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-custom-input:focus {
      border-color: var(--ef-primary);
      background: var(--ef-control-bg);
      box-shadow: 0 0 0 3px var(--ef-focus-ring-input);
    }
    #__ef_dialog__ .ef-custom-input[aria-invalid="true"] {
      border-color: var(--ef-error);
    }

    /* ── Changes summary ───────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-changes {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    #__ef_dialog__ .ef-changes-block {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #__ef_dialog__ .ef-changes-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 24px;
    }
    #__ef_dialog__ .ef-changes-head .ef-section-label { margin-bottom: 0; }
    #__ef_dialog__ .ef-changes-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-btn-sm {
      padding: 3px 11px;
      font-size: 12px;
      border-radius: 6px;
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
    #__ef_dialog__ .ef-changes-empty {
      font-size: 11px;
      color: var(--ef-muted);
      font-style: italic;
    }

    /* ── Committed changes (global) ─────────────────────────────────────────
       Always rendered — every committed edit across all elements, independent
       of the active target. */
    #__ef_dialog__ .ef-committed {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid var(--ef-border-subtle);
      padding-top: 16px;
    }
    #__ef_dialog__ .ef-committed-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 220px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-committed-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      border: 1px solid var(--ef-border-subtle);
      border-radius: 7px;
      padding: 6px 8px;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-committed-item.ef-stale {
      border-style: dashed;
      border-color: var(--ef-error);
    }
    #__ef_dialog__ .ef-committed-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-committed-sel {
      flex: 1;
      min-width: 0;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: var(--ef-text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-committed-badge {
      flex-shrink: 0;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ef-error);
      border: 1px solid var(--ef-error);
      border-radius: 4px;
      padding: 0 4px;
      line-height: 1.5;
    }
    #__ef_dialog__ .ef-committed-remove {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--ef-muted);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 0 4px;
      border-radius: 4px;
      font-family: inherit;
    }
    #__ef_dialog__ .ef-committed-remove:hover {
      color: var(--ef-error);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-committed-remove:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-committed-diff {
      display: flex;
      gap: 5px;
      align-items: baseline;
      flex-wrap: wrap;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: var(--ef-text-soft);
    }
    #__ef_dialog__ .ef-arrow { color: var(--ef-muted); }

    /* ── Issue submission card (primary view) ───────────────────────────────
       The report opens here first. Reuses the card language of the login/grant
       cards (centered, --ef-card-bg, --ef-card-shadow). */
    #__ef_dialog__ .ef-issue-modal {
      position: fixed;
      inset: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--ef-backdrop);
      pointer-events: auto;
    }
    #__ef_dialog__ .ef-issue-modal[hidden] { display: none; }
    #__ef_dialog__ .ef-issue-card {
      background: var(--ef-card-bg);
      border-radius: 12px;
      width: min(640px, calc(100vw - 32px));
      max-height: min(86vh, 780px);
      box-shadow: var(--ef-card-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #__ef_dialog__ .ef-issue-card:focus { outline: none; }
    #__ef_dialog__ .ef-issue-head {
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-issue-head h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-issue-head-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #__ef_dialog__ .ef-issue-head-row h2 { flex: 1; min-width: 0; }
    /* Live count of style edits riding along with this report. */
    #__ef_dialog__ .ef-change-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 9px;
      border-radius: 20px;
      border: 1px solid color-mix(in oklab, var(--ef-primary) 45%, transparent);
      background: var(--ef-chip-on-bg);
      color: var(--ef-chip-on-text);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-change-chip[hidden] { display: none; }
    #__ef_dialog__ .ef-issue-sub {
      margin: 3px 0 0;
      font-size: 12px;
      color: var(--ef-muted);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
    }
    #__ef_dialog__ .ef-issue-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px 20px 18px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    #__ef_dialog__ .ef-issue-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #__ef_dialog__ .ef-issue-foot {
      padding: 12px 20px;
      border-top: 1px solid var(--ef-border);
      background: var(--ef-surface);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    @media (max-width: 520px) {
      #__ef_dialog__ .ef-issue-modal { padding: 0; }
      #__ef_dialog__ .ef-issue-card {
        width: 100vw;
        max-width: 100vw;
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
      }
      #__ef_dialog__ .ef-issue-foot { flex-wrap: wrap; }
      /* Title takes the full line so the chip + Edit element stay readable. */
      #__ef_dialog__ .ef-issue-head-row { flex-wrap: wrap; row-gap: 6px; }
      #__ef_dialog__ .ef-issue-head-row h2 { flex: 1 0 100%; }
      /* Editor sheet: full-screen while centered. */
      #__ef_dialog__ .ef-card {
        width: 100vw;
        min-width: 0;
        max-width: 100vw;
        height: 100vh;
        max-height: 100vh;
        border-radius: 0;
      }
    }

    /* ── Dark theme ─────────────────────────────────────────────────────────
       Keyed off data-ef-theme, mirrored onto the overlay root by theme.ts.
       Overriding the tokens above keeps every declaration theme-agnostic. */
    html[data-ef-theme="dark"] #__ef_dialog__,
    #__ef_dialog__[data-ef-theme="dark"] {
      --ef-backdrop: rgba(0,0,0,0.68);
      --ef-card-bg: oklch(0.215 0.016 274);
      --ef-card-shadow: 0 12px 48px rgba(0,0,0,0.6);
      --ef-border: oklch(0.135 0.012 274);
      --ef-border-subtle: oklch(0.175 0.014 274);
      --ef-control-border: color-mix(in oklab, oklch(0.135 0.012 274) 75%, oklch(0.93 0.008 265) 25%);
      --ef-input-border: color-mix(in oklab, oklch(0.135 0.012 274) 70%, oklch(0.93 0.008 265) 30%);
      --ef-heading: oklch(0.93 0.008 265);
      --ef-text: color-mix(in oklab, oklch(0.93 0.008 265) 90%, oklch(0.215 0.016 274) 10%);
      --ef-text-soft: color-mix(in oklab, oklch(0.93 0.008 265) 80%, oklch(0.215 0.016 274) 20%);
      --ef-text-strong: oklch(0.93 0.008 265);
      --ef-muted: color-mix(in oklab, oklch(0.93 0.008 265) 40%, oklch(0.215 0.016 274) 60%);
      --ef-muted-strong: color-mix(in oklab, oklch(0.93 0.008 265) 55%, oklch(0.215 0.016 274) 45%);
      --ef-muted-soft: color-mix(in oklab, oklch(0.93 0.008 265) 50%, oklch(0.215 0.016 274) 50%);
      --ef-chip-fg: color-mix(in oklab, oklch(0.93 0.008 265) 65%, oklch(0.215 0.016 274) 35%);
      --ef-surface: oklch(0.175 0.014 274);
      --ef-surface-alt: oklch(0.175 0.014 274);
      --ef-surface-select: oklch(0.175 0.014 274);
      --ef-control-bg: oklch(0.215 0.016 274);
      --ef-hover-bg: oklch(0.175 0.014 274);
      --ef-control-border-hover: color-mix(in oklab, oklch(0.135 0.012 274) 55%, oklch(0.93 0.008 265) 45%);
      --ef-btn-secondary-bg: oklch(0.175 0.014 274);
      --ef-btn-secondary-hover-bg: oklch(0.135 0.012 274);
      --ef-btn-secondary-text: oklch(0.93 0.008 265);
      --ef-primary: oklch(0.74 0.135 78);
      --ef-primary-hover: oklch(0.79 0.14 78);
      --ef-primary-disabled: color-mix(in oklab, oklch(0.74 0.135 78) 35%, oklch(0.215 0.016 274) 65%);
      --ef-primary-content: oklch(0.2 0.04 78);
      --ef-focus-ring: oklch(0.74 0.135 78 / 0.25);
      --ef-focus-ring-input: oklch(0.74 0.135 78 / 0.2);
      --ef-focus-ring-chip: oklch(0.74 0.135 78 / 0.3);
      --ef-chip-on-bg: color-mix(in oklab, oklch(0.74 0.135 78) 20%, oklch(0.215 0.016 274) 80%);
      --ef-chip-on-text: oklch(0.82 0.14 78);
      --ef-error: oklch(0.63 0.2 26);
      --ef-accent: oklch(0.76 0.15 162);
      --ef-accent-content: oklch(0.17 0.04 162);
      --ef-accent-soft: oklch(0.76 0.15 162 / 0.16);
      --ef-swatch-checker: oklch(0.135 0.012 274);
      --ef-swatch-border: oklch(0.93 0.008 265 / 0.18);
      --ef-code-bg: oklch(0.135 0.012 274);
      --ef-code-border: color-mix(in oklab, oklch(0.135 0.012 274) 70%, oklch(0.93 0.008 265) 30%);
      --ef-code-text: oklch(0.93 0.008 265);
      --ef-bug-bg: color-mix(in oklab, oklch(0.63 0.2 26) 20%, oklch(0.215 0.016 274) 80%);
      --ef-bug: oklch(0.63 0.2 26);
      --ef-enh-bg: color-mix(in oklab, oklch(0.69 0.115 240) 20%, oklch(0.215 0.016 274) 80%);
      --ef-enh: oklch(0.69 0.115 240);
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
// Key handler owned by the submit dialog. closeDialog() detaches it so a
// mode-driven teardown (e.g. the activation hotkey → idle) doesn't leave a
// stray Escape listener that would re-invoke onCancel on a closed dialog.
let dialogKeyHandler: ((e: KeyboardEvent) => void) | null = null;
// Teardown for the live selection subscription owned by the submit dialog.
let dialogCleanup: (() => void) | null = null;
// True while the issue submission card is the active view. The editor's Tab
// trap and Escape handler stand down while the card owns the keyboard.
let issueModalOpen = false;
// True while an auth (login/grant) layer is shown. The panel and issue modal
// keyboard traps stand down while the auth layer owns the keyboard.
let authLayerOpen = false;
// Pending prompt layers (bottom → top). closeDialog() resolves every one as
// cancelled so no caller is left hanging when the dialog is torn down.
const authLayerCancels: Array<() => void> = [];

function getFocusable(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Remove the card Tab trap, if one is installed. Called on every view swap and
 * by closeDialog() so repeated activateDialog() calls cannot stack capture
 * listeners (each would trap Tab against a different card).
 */
function deactivateFocusTrap(): void {
  if (!dialogKeydown) return;
  document.removeEventListener("keydown", dialogKeydown, true);
  dialogKeydown = null;
}

/**
 * Wire focus restoration for a dialog card. Captures the element that
 * currently has focus so closeDialog() can restore it and moves focus to the
 * card itself (a stable, non-keyboard-triggering target).
 *
 * Tab containment is only applied in modal mode (`opts.modal !== false`). The
 * docked rail is non-modal, so Tab must move out of it into the page normally.
 */
function activateDialog(
  card: HTMLElement,
  opts?: { modal?: boolean; preserveFocusReturn?: boolean; focus?: boolean }
): void {
  // When re-restoring a modal after an inline pick, keep the original opener as
  // the focus-return target instead of the (now hidden) Add button.
  if (!opts?.preserveFocusReturn) {
    focusReturnEl = (document.activeElement as HTMLElement | null) ?? null;
  }

  // Always drop the previous trap first: one card owns Tab at a time.
  deactivateFocusTrap();

  const modal = opts?.modal !== false;
  if (!modal) {
    if (opts?.focus !== false) card.focus();
    return;
  }

  dialogKeydown = (e: KeyboardEvent) => {
    // The issue modal (and the auth layer) owns the keyboard while open.
    if (issueModalOpen || authLayerOpen) return;
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

  if (opts?.focus !== false) card.focus();
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
  onExport: (ids: number[], type: FeedbackType, issueTopic: string) => Promise<ExportIssueResult>;
  /**
   * Called when a submit/export hits 401. Resolves true if the user
   * re-authenticated (operation retried), false if they declined.
   */
  ensureAuth: () => Promise<boolean>;
  onCancel: () => void;
  /** Called after the dialog closes on a successful submit/export. */
  onComplete?: () => void;
  /**
   * Called on every view change: "submit" (issue/submission card, page is not
   * pickable) or "edit" (live style editor, page picking is active).
   */
  onEditingChange?: (view: "submit" | "edit") => void;
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

/** Shows the element feedback dialog: existing comments + compose area. */
export function showSubmitDialog(opts: SubmitFeedbackOptions): void {
  injectStyles();
  const dialog = getOrCreateDialog();

  // ── View + dock state (default docked; persisted across pages) ─────────────
  // One DOM root holds both surfaces and swaps between them:
  //   "submit" — the issue/submission card, always centered over the page.
  //   "edit"   — the live style editor, docked to the side or centered.
  // Swapping only flips attributes, so typed text and live edits survive.
  let view: "submit" | "edit" = "submit";
  let docked = readDockedPref();
  // True between clicking "Add element" in the undocked editor and the pick
  // finishing. The dialog hides itself (ef-modal-picking) and suspends its Tab
  // trap so the host page is clickable; the selection subscription restores it.
  let awaitingPick = false;
  const DOCK_MAX = 400;
  const DOCK_MIN_WIDTH = 520;
  const dockWidth = () => Math.min(DOCK_MAX, window.innerWidth);
  /** Dock applies to the editor view only — the issue card is always centered. */
  const effectiveDock = () => view === "edit" && docked && window.innerWidth > DOCK_MIN_WIDTH;
  const applyDockReflow = () => {
    const root = document.documentElement;
    if (effectiveDock()) {
      root.classList.add("ef-dock-active");
      root.style.setProperty("--ef-dock-w", `${dockWidth()}px`);
    } else {
      root.classList.remove("ef-dock-active");
      root.style.removeProperty("--ef-dock-w");
    }
  };
  const applyDockState = (card: HTMLElement | null) => {
    const dockedNow = effectiveDock();
    dialog.classList.toggle("ef-docked", dockedNow);
    if (card) card.setAttribute("aria-modal", dockedNow ? "false" : "true");
    applyDockReflow();
    // The reserved rail width reflows the host page, so repaint the selection
    // outlines to keep them aligned with their elements.
    refreshOutlines();
  };

  const tokens: ThemeTokens = opts.tokens ?? { version: 1, groups: [], source: "fallback" };

  // Live accessors — default to the selection module singletons.
  const currentTargets = (): TargetEntry[] =>
    opts.getTargets ? opts.getTargets() : getSelectionTargets();
  // All applied changes across every target — pending + committed — so the
  // feedback record and the fallback comment include frozen edits too.
  const allChanges = (): StyleChange[] => getAllChanges();

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

  const expectedRowHTML = suggestions.length > 0 ? `
        <div class="ef-intent-row">
          <span class="ef-intent-label">Expected</span>
          <div class="ef-chips" id="__ef_expected__">
            ${suggestions.map((s) => `<button type="button" class="ef-chip${s.value === "__below__" ? " ef-chip-muted" : ""}" data-expected="${s.value}" data-sentence="${escapeHtml(s.sentence)}" aria-pressed="false">${escapeHtml(s.label)}</button>`).join("")}
          </div>
        </div>` : "";

  // Subtitle for the issue modal header: repo · element.
  const issueSubParts: string[] = [];
  if (opts.repo) issueSubParts.push(opts.repo);
  issueSubParts.push(opts.selector);
  const issueSub = issueSubParts.join(" · ");

  dialog.innerHTML = `
    <div class="ef-card" role="dialog" aria-modal="true" aria-labelledby="__ef_title__" tabindex="-1" hidden inert aria-hidden="true">
      <div class="ef-header">
        <div class="ef-header-top">
          <h2 id="__ef_title__">${title}</h2>
          <div class="ef-user-pill">
            <img src="${escapeHtml(opts.user.avatarUrl)}" alt="">
            <span>${escapeHtml(opts.user.login)}</span>
          </div>
          <button class="ef-dock-btn" id="__ef_dock__" type="button" title="Dock to the side" aria-label="Dock to the side"></button>
        </div>
        <div class="ef-selector" id="__ef_editor_selector__" title="${escapeHtml(opts.selector)}">${escapeHtml(opts.selector)}</div>
      </div>
      ${componentPickerHTML}
      ${targetStripHTML}
      <div class="ef-body">
        <div class="ef-targets" id="__ef_targets__"></div>
        <div class="ef-design-body">
          <div id="__ef_style_editor__"></div>
          <div class="ef-changes" id="__ef_changes__"></div>
        </div>
      </div>
      <div class="ef-footer">
        <div class="ef-footer-spacer"></div>
        <button type="button" class="ef-btn-secondary" id="__ef_cancel__">Cancel</button>
        <button type="button" class="ef-btn-primary" id="__ef_back_to_issue__">Back to issue</button>
      </div>
    </div>
    <div class="ef-issue-modal" id="__ef_issue_modal__" hidden>
      <div class="ef-issue-card" role="dialog" aria-modal="true" aria-labelledby="__ef_issue_title__" tabindex="-1">
        <div class="ef-issue-head">
          <div class="ef-issue-head-row">
            <h2 id="__ef_issue_title__">Create GitHub issue</h2>
            <span class="ef-change-chip" id="__ef_change_count__" hidden></span>
            <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_edit_element__" aria-label="Edit element styles">Edit element</button>
          </div>
          <p class="ef-issue-sub">${escapeHtml(issueSub)}</p>
        </div>
        <div class="ef-issue-body">
          <div class="ef-issue-section">
            ${commentsHTML}
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
          <div class="ef-issue-section">
            <details class="ef-meta-toggle" id="__ef_issue_context__">
              <summary>Context that will be attached</summary>
              <div class="ef-meta-grid">${metaHTML}</div>
            </details>
            <details class="ef-meta-toggle" id="__ef_issue_html__">
              <summary>Element HTML</summary>
              ${outerHTML
                ? `<pre class="ef-html-preview">${highlightHTML(outerHTML)}</pre>`
                : `<div class="ef-changes-empty">No element HTML captured.</div>`}
            </details>
            ${buildSessionHistoryHTML(ctx)}
          </div>
        </div>
        <div class="ef-issue-foot">
          <button type="button" class="ef-btn-secondary" id="__ef_issue_cancel__">Cancel</button>
          <button type="button" class="ef-btn-secondary" id="__ef_edit_element_foot__" aria-label="Edit element styles">Edit element</button>
          <div class="ef-footer-spacer"></div>
          <button type="button" class="ef-btn-secondary" id="__ef_submit__">Save</button>
          <button type="button" class="ef-btn-primary" id="__ef_issue_submit__">Create issue</button>
        </div>
      </div>
    </div>
  `;

  const card = dialog.querySelector<HTMLElement>(".ef-card")!;
  // Remember where the reporter came from so closeDialog() restores focus.
  // (View swaps pass preserveFocusReturn so they never overwrite this.)
  focusReturnEl = (document.activeElement as HTMLElement | null) ?? null;

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
    renderDockBtn();
    if (view !== "edit") return;
    applyDockState(card);
    // Re-arm the trap to match the new mode (docked = non-modal) but leave
    // focus on the toggle the user just pressed.
    activateDialog(card, {
      modal: !effectiveDock(),
      preserveFocusReturn: true,
      focus: false,
    });
    dockBtn.focus();
  });

  const textarea = dialog.querySelector<HTMLTextAreaElement>("#__ef_comment__")!;
  const submitBtn = dialog.querySelector<HTMLButtonElement>("#__ef_submit__")!;
  const cancelBtn = dialog.querySelector<HTMLButtonElement>("#__ef_cancel__")!;
  const backToIssueBtn = dialog.querySelector<HTMLButtonElement>("#__ef_back_to_issue__")!;
  const errDiv = dialog.querySelector<HTMLElement>("#__ef_err__")!;

  // ── Both surfaces live in the same root; only attributes swap ───────────────
  const modal = dialog.querySelector<HTMLElement>("#__ef_issue_modal__")!;
  const modalCard = dialog.querySelector<HTMLElement>(".ef-issue-card")!;
  const issueCancelBtn = dialog.querySelector<HTMLButtonElement>("#__ef_issue_cancel__")!;
  const issueSubmitBtn = dialog.querySelector<HTMLButtonElement>("#__ef_issue_submit__")!;
  const editBtn = dialog.querySelector<HTMLButtonElement>("#__ef_edit_element__")!;
  const editFootBtn = dialog.querySelector<HTMLButtonElement>("#__ef_edit_element_foot__")!;
  const changeChip = dialog.querySelector<HTMLElement>("#__ef_change_count__")!;
  const editorSelector = dialog.querySelector<HTMLElement>("#__ef_editor_selector__")!;

  // Tab containment + Escape for the modal layer. Capture phase so it runs
  // ahead of the editor's own handlers. Only bound while the submit view is up.
  const modalKey = (e: KeyboardEvent): void => {
    // The auth layer owns the keyboard while it is up.
    if (authLayerOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // The issue card is the whole report: Escape cancels it.
      cancelReport();
      return;
    }
    if (e.key !== "Tab") return;
    const items = getFocusable(modalCard);
    if (items.length === 0) { e.preventDefault(); modalCard.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === modalCard || !modalCard.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  /** Live count of style edits that will ride along with this report. */
  const renderChangeCount = (): void => {
    const n = allChanges().length;
    const label = n === 1 ? "1 style change" : `${n} style changes`;
    changeChip.textContent = n === 0 ? "" : label;
    changeChip.hidden = n === 0;
    changeChip.title = n === 0 ? "" : `${label} included with this report`;
  };

  /**
   * Swap between the issue card and the style editor. Nothing inside either
   * surface is re-rendered, so typed text, chips and live edits survive.
   */
  const setView = (next: "submit" | "edit"): void => {
    view = next;
    dialog.dataset.view = next;

    if (next === "submit") {
      // The editor trap goes first: the issue card owns Tab while it is up.
      deactivateFocusTrap();
      // Bring the modal online before moving focus into it.
      modal.hidden = false;
      modal.removeAttribute("aria-hidden");
      modal.toggleAttribute("inert", false);
      issueModalOpen = true;
      // The issue card is never docked and never reflows the host page.
      applyDockState(card);
      modalCard.focus();
      // Only now take the editor out of the accessibility tree.
      card.setAttribute("aria-hidden", "true");
      card.toggleAttribute("inert", true);
      card.hidden = true;
      document.addEventListener("keydown", modalKey, true);
      renderChangeCount();
    } else {
      document.removeEventListener("keydown", modalKey, true);
      issueModalOpen = false;
      // Bring the editor online before the modal leaves the a11y tree.
      card.hidden = false;
      card.removeAttribute("aria-hidden");
      card.toggleAttribute("inert", false);
      applyDockState(card);
      // Docked = non-modal (page stays interactive); centered = modal + trap.
      activateDialog(card, { modal: !effectiveDock(), preserveFocusReturn: true });
      modal.setAttribute("aria-hidden", "true");
      modal.toggleAttribute("inert", true);
      modal.hidden = true;
      renderEditorSelector();
    }
    opts.onEditingChange?.(next);
  };

  /** Return to the issue card, keeping every typed field and pending edit. */
  const backToSubmit = (): void => {
    if (view !== "edit") return;
    if (isPickMode()) setPickMode(false);
    setView("submit");
    // Round trip: land back on the button that opened the editor.
    editBtn.focus();
  };

  /**
   * Cancel the whole report from either view: drop the persisted draft, undo
   * uncommitted edits and close. Committed edits stay on the page.
   */
  const cancelReport = (): void => {
    if (draftTimer !== null) { window.clearTimeout(draftTimer); draftTimer = null; }
    clearDraft(opts.selector);
    removeKey();
    revertPending();
    closeDialog();
    opts.onCancel();
  };

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

  // ── Draft persistence wiring ────────────────────────────────────────────────
  // Debounced save of the text fields (comment / title / type) on input, and a
  // single restore when the dialog is built. Storage is best-effort only.
  // Crucially the restore does NOT run on view swaps, so returning from the
  // editor can never overwrite text typed more recently than the saved draft.
  const topicInput = dialog.querySelector<HTMLInputElement>("#__ef_topic__");
  let draftTimer: number | null = null;
  // Comment text that was already POSTed by the create-issue flow. Kept across
  // an export failure so clicking "Create issue" again exports the same item
  // instead of creating a duplicate comment. Cleared when the text changes.
  let submittedComment: string | null = null;
  let submittedId: number | null = null;

  const scheduleDraftSave = (): void => {
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      draftTimer = null;
      saveDraft(opts.selector, {
        comment: textarea.value,
        title: topicInput?.value ?? "",
        type: getType(),
      });
    }, 300);
  };

  const restoreDraft = (): void => {
    const draft = loadDraft(opts.selector);
    if (!draft) return;
    if (draft.comment) textarea.value = draft.comment;
    if (draft.title && topicInput) topicInput.value = draft.title;
    if (draft.type) {
      const radio = dialog.querySelector<HTMLInputElement>(
        `input[name='__ef_type__'][value='${draft.type}']`
      );
      if (radio && !radio.checked) {
        radio.checked = true;
        // Let the existing change handler re-seed the action verb.
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  };

  textarea.addEventListener("input", () => {
    // Editing after a failed export means the old comment is no longer the
    // draft: drop both the dedupe marker and its id so a retry exports only
    // the new text.
    submittedComment = null;
    submittedId = null;
    scheduleDraftSave();
  });
  if (topicInput) topicInput.addEventListener("input", scheduleDraftSave);

  // ── Intent micro-form state + wiring ───────────────────────────────────────
  const actionWrap = dialog.querySelector<HTMLElement>("#__ef_action__")!;
  const expectedWrap = dialog.querySelector<HTMLElement>("#__ef_expected__");
  const scopeWrap = dialog.querySelector<HTMLElement>("#__ef_scope__")!;
  const scopeHint = dialog.querySelector<HTMLElement>("#__ef_scope_hint__")!;

  // ── Targets + live style editor + changes summary ───────────────────────────
  const bodyEl = dialog.querySelector<HTMLElement>(".ef-body")!;
  const targetsHost = dialog.querySelector<HTMLElement>("#__ef_targets__")!;
  const styleHost = dialog.querySelector<HTMLElement>("#__ef_style_editor__")!;
  const changesHost = dialog.querySelector<HTMLElement>("#__ef_changes__")!;

  // Active per-element tab in the editor sidebar.
  let activeTargetIdx = 0;
  /** Last target that received a select-flash — see renderSelection. */
  let lastFlashedEl: Element | null = null;
  const activeTarget = (): TargetEntry | null => currentTargets()[activeTargetIdx] ?? null;
  const clampActiveTarget = (): void => {
    const n = currentTargets().length;
    if (n === 0) activeTargetIdx = 0;
    else if (activeTargetIdx > n - 1) activeTargetIdx = n - 1;
    else if (activeTargetIdx < 0) activeTargetIdx = 0;
  };

  const targetLabel = (t: TargetEntry): string => {
    if (t.dataComponent) return t.dataComponent;
    const tail = t.selector.split(">").pop()?.trim();
    return tail || t.selector;
  };

  /** Compact selector line in the editor header (context for what is edited). */
  const renderEditorSelector = (): void => {
    const t = activeTarget();
    const sel = t?.selector ?? opts.selector;
    editorSelector.textContent = sel;
    editorSelector.title = sel;
  };

  const renderTargets = () => {
    const targets = currentTargets();
    const picking = isPickMode();
    const addBtn = `<button type="button" class="ef-target-add${picking ? " ef-picking" : ""}" id="__ef_add_target__">+ Add element</button>`;
    const tabsHTML = targets
      .map((t, i) => {
        const on = i === activeTargetIdx;
        return `<div class="ef-target-tab" role="tab" tabindex="${on ? 0 : -1}" aria-selected="${on}" data-idx="${i}" title="${escapeHtml(t.selector)}"><span class="ef-target-num">${i + 1}</span><span class="ef-target-name">${escapeHtml(targetLabel(t))}</span><button type="button" class="ef-target-remove" data-idx="${i}" aria-label="Remove target">×</button></div>`;
      })
      .join("");
    targetsHost.innerHTML = `
      <div class="ef-section-label">Targets</div>
      <div class="ef-target-tabs">
        <div class="ef-target-tablist" role="tablist" aria-label="Selected elements">${tabsHTML}</div>
        ${addBtn}
      </div>`;
    targetsHost.querySelector<HTMLButtonElement>("#__ef_add_target__")?.addEventListener("click", () => {
      if (!effectiveDock()) {
        // Centered editor: hide it, suspend the Tab trap, and let the user click
        // an element on the page. The selection subscription restores us.
        awaitingPick = true;
        setPickMode(true);
        dialog.classList.add("ef-modal-picking");
        deactivateFocusTrap();
        return;
      }
      setPickMode(!isPickMode());
      renderTargets();
    });
    targetsHost.querySelectorAll<HTMLElement>(".ef-target-tab").forEach((tab) => {
      const idx = parseInt(tab.dataset.idx ?? "-1", 10);
      const tabTarget = currentTargets()[idx];
      const activate = () => {
        if (idx < 0 || idx === activeTargetIdx) return;
        activeTargetIdx = idx;
        renderSelection();
      };
      tab.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".ef-target-remove")) return;
        activate();
      });
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      // Hovering/focusing a target label is the ONLY thing that outlines the
      // element on the page (see selection.setHighlight) — a permanent box
      // would sit on top of the very style the reporter is judging.
      if (tabTarget) {
        tab.addEventListener("mouseenter", () => setHighlight(tabTarget.el));
        tab.addEventListener("mouseleave", () => setHighlight(null));
        tab.addEventListener("focusin", () => setHighlight(tabTarget.el));
        tab.addEventListener("focusout", (e) => {
          if (!tab.contains(e.relatedTarget as Node | null)) setHighlight(null);
        });
      }
    });
    targetsHost.querySelectorAll<HTMLButtonElement>(".ef-target-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Don't also activate the tab we're removing.
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx ?? "-1", 10);
        const t = currentTargets()[idx];
        if (!t) return;
        // Keep the active element stable when an earlier tab is removed; the
        // selection-change subscription re-renders + clamps the index.
        if (idx < activeTargetIdx) activeTargetIdx -= 1;
        removeSelectionTarget(t.el);
      });
    });
  };

  const renderStyle = () => {
    const t = activeTarget();
    mountStyleEditor(styleHost, tokens, t, t ? getChangeCountFor(t.el) : 0, {
      onApply: (group, token) => {
        const cur = activeTarget();
        if (cur) applyTokenToTarget(cur.el, group, token);
      },
      onClear: (group) => {
        const cur = activeTarget();
        if (!cur) return;
        // Nothing recorded means the value comes from the page's own markup —
        // say so instead of silently stripping the host's class.
        if (!clearTokenForTarget(cur.el, group)) {
          showToast("That value comes from the page markup, not an overlay edit.");
        }
      },
      onRerender: () => renderStyle(),
      onTextInput: (value) => {
        const cur = activeTarget();
        if (cur) setTextForTarget(cur.el, value);
      },
      onTextCommit: () => {
        // Defer the re-render: the blur that triggers this can precede a click
        // on Commit / Revert / a target tab, and re-mounting now would remove
        // the button under the pointer and swallow the click.
        setTimeout(() => notifySelectionChange(), 0);
      },
      onTextReset: () => {
        const cur = activeTarget();
        if (!cur) return;
        if (!clearTextForTarget(cur.el)) {
          showToast("This text comes from the page markup, not an overlay edit.");
        }
      },
    });
  };

  const renderChanges = () => {
    const t = activeTarget();
    const pending = t ? getChangesFor(t.el) : [];
    const pendingCount = pending.length;
    // Commit freezes every pending edit across targets, not just the active one.
    const pendingElsewhere = Math.max(0, getChangeCount() - pendingCount);
    const committed = getCommittedEntries();

    const pendingList =
      pendingCount === 0
        ? `<div class="ef-changes-empty">No pending edits on this element. Commit to freeze them.</div>`
        : `<ul class="ef-changes-list">
            ${pending.map((c) => {
              const groupLabel = c.move != null ? "Position" : c.group === "text" ? "Text" : c.group;
              return `<li><span class="ef-change-group">${escapeHtml(groupLabel)}</span><span class="ef-change-before">${escapeHtml(c.before || "—")}</span><span class="ef-arrow">→</span><span class="ef-change-after">${escapeHtml(c.after)}</span></li>`;
            }).join("")}
          </ul>`;

    const committedList =
      committed.length === 0
        ? `<div class="ef-changes-empty">No committed changes yet.</div>`
        : `<ul class="ef-committed-list">
            ${committed.map((c, i) => `
              <li class="ef-committed-item${c.stale ? " ef-stale" : ""}">
                <div class="ef-committed-meta">
                  <span class="ef-committed-sel" title="${escapeHtml(c.selector)}">${escapeHtml(c.selector)}</span>
                  ${c.stale ? `<span class="ef-committed-badge">not found</span>` : ""}
                  <button type="button" class="ef-committed-remove" data-idx="${i}" aria-label="Remove committed change">×</button>
                </div>
                <div class="ef-committed-diff">
                  <span class="ef-change-group">${escapeHtml(c.groupLabel || c.group)}</span>
                  <span class="ef-change-before">${escapeHtml(c.before || "—")}</span>
                  <span class="ef-arrow">→</span>
                  <span class="ef-change-after">${escapeHtml(c.after)}</span>
                </div>
              </li>`).join("")}
          </ul>`;

    changesHost.innerHTML = `
      <div class="ef-changes-block">
        <div class="ef-changes-head">
          <div class="ef-section-label">Changes (${pendingCount})</div>
          <div class="ef-changes-actions">
            <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_revert_pending__"${pendingCount === 0 ? " disabled" : ""}>Revert</button>
            <button type="button" class="ef-btn-primary ef-btn-sm" id="__ef_commit__"${pendingCount === 0 ? " disabled" : ""}>Commit</button>
          </div>
        </div>
        ${pendingList}
        ${pendingElsewhere > 0 ? `<div class="ef-hint">${pendingElsewhere} pending edit${pendingElsewhere !== 1 ? "s" : ""} on other element${pendingElsewhere !== 1 ? "s" : ""} will also be committed.</div>` : ""}
      </div>
      <div class="ef-committed" id="__ef_committed__">
        <div class="ef-changes-head">
          <div class="ef-section-label">Committed changes (${committed.length})</div>
          ${committed.length > 0 ? `<button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_committed_clear__">Remove all</button>` : ""}
        </div>
        ${committedList}
      </div>`;

    changesHost.querySelector<HTMLButtonElement>("#__ef_revert_pending__")?.addEventListener("click", () => {
      revertPending();
      renderSelection();
    });
    changesHost.querySelector<HTMLButtonElement>("#__ef_commit__")?.addEventListener("click", () => {
      commitChanges();
      renderSelection();
    });
    changesHost.querySelector<HTMLButtonElement>("#__ef_committed_clear__")?.addEventListener("click", () => {
      clearCommitted();
      renderSelection();
    });
    changesHost.querySelectorAll<HTMLButtonElement>(".ef-committed-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx ?? "-1", 10);
        if (idx >= 0) {
          removeCommittedAt(idx);
          renderSelection();
        }
      });
    });
  };

  const renderSelection = () => {
    clampActiveTarget();
    // Click-to-select feedback: briefly outline the newly active target. There
    // is no permanent outline (it would hide the style being previewed), so the
    // flash is what tells the reporter which element the editor is bound to.
    const activeEl = activeTarget()?.el ?? null;
    if (activeEl && activeEl !== lastFlashedEl) flashTarget(activeEl);
    lastFlashedEl = activeEl;
    // Re-rendering replaces innerHTML, which would collapse the "Current
    // classes" disclosure and jump scroll positions. Capture + restore them so
    // live edits don't yank the editor around.
    const bodyScroll = bodyEl.scrollTop;
    const detailsOpen = !!styleHost.querySelector<HTMLDetailsElement>(".ef-style-classes")?.open;
    const classListScroll =
      styleHost.querySelector<HTMLElement>(".ef-style-class-list")?.scrollTop ?? 0;
    const changesScroll =
      changesHost.querySelector<HTMLElement>(".ef-changes-list")?.scrollTop ?? 0;
    const committedScroll =
      changesHost.querySelector<HTMLElement>(".ef-committed-list")?.scrollTop ?? 0;

    renderTargets();
    renderStyle();
    renderChanges();

    if (detailsOpen) {
      const d = styleHost.querySelector<HTMLDetailsElement>(".ef-style-classes");
      if (d) d.open = true;
    }
    const newClassList = styleHost.querySelector<HTMLElement>(".ef-style-class-list");
    if (newClassList) newClassList.scrollTop = classListScroll;
    const newChanges = changesHost.querySelector<HTMLElement>(".ef-changes-list");
    if (newChanges) newChanges.scrollTop = changesScroll;
    const newCommitted = changesHost.querySelector<HTMLElement>(".ef-committed-list");
    if (newCommitted) newCommitted.scrollTop = committedScroll;
    bodyEl.scrollTop = bodyScroll;
    renderEditorSelector();
  };

  /**
   * Default verb: a recorded move wins over the type-derived default, so a
   * report that is (mostly) a reorder reads as a move.
   */
  const defaultAction = (): IntentAction =>
    getAllChanges().some((c) => c.move != null) ? "move" : inferAction(getType());

  let action: IntentAction = defaultAction();
  let actionTouched = false;
  let expected = "";
  let breadth: ScopeBreadth = "element";

  const renderActions = () => {
    actionWrap.innerHTML = INTENT_ACTIONS.map((a) =>
      `<button type="button" class="ef-chip${a.value === action ? " ef-chip-on" : ""}" data-action="${a.value}" aria-pressed="${a.value === action}">${a.label}</button>`
    ).join("");
  };
  renderActions();

  // A move recorded while the modal is open re-seeds the verb, unless the
  // reporter already chose one.
  const unsubActionSeed = onSelectionChange(() => {
    if (actionTouched) return;
    const next = defaultAction();
    if (next === action) return;
    action = next;
    renderActions();
  });

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
      scheduleDraftSave();
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
      scopeHint.textContent = `Editing ${n} elements individually — switch tabs in Design.`;
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

  /** Build the structured intent passed to onSubmit as the third argument. */
  const buildIntent = (): FeedbackIntent => {
    const targets = currentTargets();
    const changes = allChanges();
    const targetSelectors =
      targets.length > 0 ? targets.map((t) => t.selector) : [opts.selector];
    const intent: FeedbackIntent = {
      kind: getType(),
      action,
      expected: expected.trim() || undefined,
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
    if (raw) return raw; // a typed note always wins
    const parts: string[] = [];
    if (expected.trim()) parts.push(expected.trim());
    // A changes-only report is valid: summarise the applied live edits so Save
    // and Export both accept it (the server supports this case).
    const changes = allChanges();
    if (changes.length > 0) {
      const desc = changes
        .map((c) => `${c.group} ${c.before || "—"} → ${c.after}`)
        .join("; ");
      parts.push(`Applied live changes: ${desc}`);
    }
    return parts.join(" — ");
  };

  // No autofocus: the intent chips are the primary surface, and focusing the
  // (now last) textarea would scroll them out of view and pop the mobile keyboard.

  // Escape follows the current view: the issue card cancels the whole report,
  // the editor steps back to the card, and an unfinished page pick just ends.
  const onKey = (e: KeyboardEvent) => {
    // The issue card owns Escape while it is up (its capture handler also stops
    // propagation, but guard here too in case of ordering). The auth layer
    // likewise owns Escape.
    if (issueModalOpen || authLayerOpen) return;
    if (e.key !== "Escape") return;
    if (awaitingPick) {
      // Cancel the pick but keep the dialog: the selection subscription
      // restores the editor once pick mode ends.
      setPickMode(false);
      return;
    }
    if (view === "edit") {
      // Keep every pending edit; just return to the issue card.
      backToSubmit();
      return;
    }
    cancelReport();
  };
  const removeKey = () => {
    document.removeEventListener("keydown", onKey);
    if (dialogKeyHandler === onKey) dialogKeyHandler = null;
  };
  document.addEventListener("keydown", onKey);
  dialogKeyHandler = onKey;

  // Editor: Cancel throws away the whole report (draft + uncommitted edits).
  cancelBtn.addEventListener("click", () => {
    cancelReport();
  });

  // Editor: back to the issue card, keeping text, chips and pending edits.
  backToIssueBtn.addEventListener("click", () => {
    backToSubmit();
  });

  // Issue card: "Edit element" opens the style editor (header + footer).
  editBtn.addEventListener("click", () => {
    setView("edit");
  });
  editFootBtn.addEventListener("click", () => {
    setView("edit");
  });

  // Issue card: Cancel throws away the whole report, same as the editor's.
  issueCancelBtn.addEventListener("click", () => {
    cancelReport();
  });

  // Modal: Save submits the feedback without creating a GitHub issue.
  submitBtn.addEventListener("click", async () => {
    const comment = collectComment();
    if (!comment) { errDiv.textContent = "Add a note or choose what you expected."; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    errDiv.textContent = "";
    try {
      await withAuthRetry(
        () => opts.onSubmit(comment, getType(), buildIntent()),
        opts.ensureAuth
      )();
      clearDraft(opts.selector);
      removeKey();
      closeDialog();
      opts.onComplete?.();
    } catch (err) {
      // Declined re-auth: keep the draft, show an inline prompt, re-enable.
      if (err instanceof AuthCancelledError) {
        errDiv.textContent = "Sign in to continue";
      } else {
        errDiv.textContent = describeAPIError(err);
      }
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });

  // Modal: Create issue runs the current export path — submit a new comment
  // first (when there is one), then export the parent comment IDs. Nothing is
  // closed until the export actually succeeds.
  issueSubmitBtn.addEventListener("click", async () => {
    issueSubmitBtn.disabled = true;
    issueSubmitBtn.textContent = "Creating…";
    submitBtn.disabled = true;
    errDiv.textContent = "";

    const comment = collectComment();
    const type = getType();
    const topic = getIssueTopic();
    let ids = [...existingIds];
    // A comment created by an earlier attempt (whose export failed) still
    // belongs in this export.
    if (submittedId !== null && !ids.includes(submittedId)) ids.push(submittedId);

    try {
      if (comment && comment !== submittedComment) {
        // Submit the new comment first, then include its ID in the export.
        const newId = await withAuthRetry(
          () => opts.onSubmit(comment, type, buildIntent()),
          opts.ensureAuth
        )();
        if (typeof newId === "number") ids = [...ids, newId];
        // Remembered so a failed export can be retried without a duplicate.
        submittedComment = comment;
        if (typeof newId === "number") submittedId = newId;
      }
      if (ids.length === 0) {
        errDiv.textContent = "Nothing to export — add a note or choose what you expected.";
        issueSubmitBtn.disabled = false;
        issueSubmitBtn.textContent = "Create issue";
        submitBtn.disabled = false;
        return;
      }
      // Await the export before closing: a 401 re-prompts for sign-in and
      // retries; a 403 app_access_required is handled in the catch below.
      await withAuthRetry(
        () => opts.onExport(ids, type, topic),
        opts.ensureAuth
      )();
      clearDraft(opts.selector);
      removeKey();
      closeDialog();
      showToast("Issue created successfully!");
      opts.onComplete?.();
    } catch (err) {
      if (err instanceof AuthCancelledError) {
        errDiv.textContent = "Sign in to continue";
        issueSubmitBtn.disabled = false;
        issueSubmitBtn.textContent = "Create issue";
        submitBtn.disabled = false;
        return;
      }
      if (err instanceof APIError && err.code === "app_access_required") {
        // Keep the modal open and prompt for repo access; retry the export
        // after access is granted, then close on success.
        const b = (err.body ?? {}) as { repo?: string; authorize_url?: string };
        const granted = await showGrantAccessDialog({
          repo: b.repo ?? "this repository",
          authorizeUrl: b.authorize_url ?? "",
          onRetry: () =>
            withAuthRetry(() => opts.onExport(ids, type, topic), opts.ensureAuth)(),
        });
        if (granted) {
          clearDraft(opts.selector);
          removeKey();
          closeDialog();
          showToast("Issue created successfully!");
          opts.onComplete?.();
        } else {
          issueSubmitBtn.disabled = false;
          issueSubmitBtn.textContent = "Create issue";
          submitBtn.disabled = false;
        }
        return;
      }
      errDiv.textContent = describeAPIError(err);
      issueSubmitBtn.disabled = false;
      issueSubmitBtn.textContent = "Create issue";
      submitBtn.disabled = false;
    }
  });

  // Initial render + keep selection-driven sections live as the user picks.
  let prevTargetCount = currentTargets().length;
  renderSelection();
  renderScopeHint();
  const unsubSelection = onSelectionChange(() => {
    const count = currentTargets().length;
    // A new element landed: focus its tab so the editor targets it.
    if (count > prevTargetCount) activeTargetIdx = count - 1;
    prevTargetCount = count;
    renderSelection();
    renderScopeHint();
    // Keep the issue card's edit count live while the editor is open.
    if (view === "edit") renderChangeCount();
    // A pick just finished: show the editor again and restore modal focus.
    if (awaitingPick && !isPickMode()) {
      awaitingPick = false;
      dialog.classList.remove("ef-modal-picking");
      applyDockState(card);
      if (!effectiveDock()) activateDialog(card, { modal: true, preserveFocusReturn: true });
    }
  });

  // Reverse hover: outline the target on the page and peek its tab in the panel.
  const unsubHighlight = onHighlightChange((el) => {
    const tabs = targetsHost.querySelectorAll<HTMLElement>(".ef-target-tab");
    const list = currentTargets();
    tabs.forEach((tab) => {
      const t = list[parseInt(tab.dataset.idx ?? "-1", 10)];
      tab.classList.toggle("ef-target-tab--peek", !!el && !!t && t.el === el);
    });
  });

  // Keep the reserved dock rail width (and outlines) in step with the viewport.
  // Crossing the 520px breakpoint flips the editor between the docked rail and
  // the centered sheet, so the Tab trap has to follow.
  let lastEffectiveDock = effectiveDock();
  const onResize = () => {
    const dockedNow = effectiveDock();
    const changed = dockedNow !== lastEffectiveDock;
    lastEffectiveDock = dockedNow;
    if (changed && view === "edit" && !awaitingPick) {
      applyDockState(card);
      activateDialog(card, { modal: !dockedNow, preserveFocusReturn: true, focus: false });
      return;
    }
    applyDockReflow();
    refreshOutlines();
  };
  window.addEventListener("resize", onResize);

  dialogCleanup = () => {
    unsubSelection();
    unsubHighlight();
    unsubActionSeed();
    setHighlight(null);
    endDragVisual();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", modalKey, true);
    deactivateFocusTrap();
  };

  // Backdrop click cancels the report — centered editor only. The docked rail
  // and the submit view are click-through at the root (pointer-events: none),
  // so this never fires while docked.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && view === "edit" && !effectiveDock() && !awaitingPick) {
      cancelReport();
    }
  });

  // Restore the persisted draft exactly once per open. Doing it here (instead of
  // on every view swap) keeps newer text intact when returning from the editor.
  restoreDraft();
  renderChangeCount();
  setView("submit");
}

// ── Auth layer (overlay, not innerHTML replacement) ──────────────────────────
// Login/grant prompts append a `.ef-auth-layer` inside #__ef_dialog__ and remove
// only that layer when done. The submit/issue dialog and any typed draft survive.

function appendAuthLayer(): HTMLElement {
  injectStyles();
  const dialog = getOrCreateDialog();
  const layer = document.createElement("div");
  layer.className = "ef-auth-layer";
  dialog.appendChild(layer);
  authLayerOpen = true;
  return layer;
}

/** Remove one layer and recompute whether any auth layer is still open. */
function removeAuthLayer(layer: HTMLElement): void {
  layer.remove();
  const dialog = document.getElementById(DIALOG_ID);
  authLayerOpen = !!dialog?.querySelector(".ef-auth-layer");
}

function topAuthLayer(): HTMLElement | null {
  const layers = document.querySelectorAll<HTMLElement>(
    `#${DIALOG_ID} .ef-auth-layer`
  );
  return layers.length ? layers[layers.length - 1] : null;
}

/** Tab containment scoped to the topmost auth card; returns the detach function. */
function trapAuthFocus(layer: HTMLElement, card: HTMLElement): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    if (topAuthLayer() !== layer) return;
    const items = getFocusable(card);
    if (items.length === 0) { e.preventDefault(); card.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !card.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", handler, true);
  return () => document.removeEventListener("keydown", handler, true);
}

/** Escape-to-cancel listener for the top auth layer; returns the detach function. */
function addAuthEscape(layer: HTMLElement, onEsc: () => void): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (topAuthLayer() !== layer) return;
      e.preventDefault();
      e.stopPropagation();
      onEsc();
    }
  };
  document.addEventListener("keydown", handler, true);
  return () => document.removeEventListener("keydown", handler, true);
}

export interface PromptLoginOptions {
  onLogin: () => Promise<void>;
  message?: string;
}

/**
 * Login prompt as an overlay layer. Resolves `true` after a successful
 * `onLogin`, `false` on cancel — in both cases removing only the layer and
 * leaving any underlying submit/issue dialog and typed content intact.
 */
export function promptLogin(opts: PromptLoginOptions): Promise<boolean> {
  const previousFocus = document.activeElement as HTMLElement | null;
  const layer = appendAuthLayer();
  layer.innerHTML = `
    <div class="ef-login-card" role="dialog" aria-modal="true" aria-labelledby="__ef_login_title__" tabindex="-1">
      <h2 id="__ef_login_title__">Sign in with GitHub</h2>
      <p>${escapeHtml(opts.message ?? "Authentication required to submit feedback.")}</p>
      <div class="ef-login-actions">
        <button class="ef-btn-secondary" id="__ef_auth_cancel__">Cancel</button>
        <button class="ef-btn-primary" id="__ef_auth_login__">Sign in with GitHub</button>
      </div>
      <div class="ef-error" id="__ef_auth_err__" style="margin-top:8px"></div>
    </div>
  `;

  const card = layer.querySelector<HTMLElement>(".ef-login-card")!;
  const loginBtn = layer.querySelector<HTMLButtonElement>("#__ef_auth_login__")!;
  const cancelBtn = layer.querySelector<HTMLButtonElement>("#__ef_auth_cancel__")!;
  const errDiv = layer.querySelector<HTMLElement>("#__ef_auth_err__")!;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let detachTrap: () => void = () => {};
    let detachEsc: () => void = () => {};
    let cancel = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const idx = authLayerCancels.indexOf(cancel);
      if (idx >= 0) authLayerCancels.splice(idx, 1);
      detachTrap();
      detachEsc();
      removeAuthLayer(layer);
      // Give focus back to the control/dialog under this layer; fall back to
      // the issue card when that control was disabled for the request.
      const canRestore =
        previousFocus !== null &&
        document.contains(previousFocus) &&
        !(previousFocus as HTMLButtonElement).disabled;
      const remainingLayer = topAuthLayer();
      const target = canRestore
        ? previousFocus
        : remainingLayer?.querySelector<HTMLElement>(".ef-login-card") ??
          // Whichever surface the reporter is on (issue card or editor).
          document.querySelector<HTMLElement>(
            ".ef-issue-card, .ef-card:not([hidden])"
          ) ??
          document.getElementById(DIALOG_ID);
      target?.focus();
      resolve(ok);
    };
    cancel = () => finish(false);
    authLayerCancels.push(cancel);
    detachTrap = trapAuthFocus(layer, card);
    detachEsc = addAuthEscape(layer, () => finish(false));

    loginBtn.addEventListener("click", async () => {
      loginBtn.disabled = true;
      loginBtn.textContent = "Opening…";
      errDiv.textContent = "";
      try {
        await opts.onLogin();
        finish(true);
      } catch (err) {
        loginBtn.disabled = false;
        loginBtn.textContent = "Sign in with GitHub";
        errDiv.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    cancelBtn.addEventListener("click", () => finish(false));
    layer.addEventListener("click", (e) => { if (e.target === layer) finish(false); });
    card.focus();
  });
}

export interface LoginDialogOptions {
  onLogin: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Initial (pre-dialog) auth gate. Reuses the same layer as `promptLogin`, but
 * since nothing sits underneath it also removes the now-empty dialog root.
 */
export function showLoginDialog(opts: LoginDialogOptions): void {
  void promptLogin({ onLogin: opts.onLogin }).then((ok) => {
    closeDialog();
    if (!ok) opts.onCancel();
  });
}

export function closeDialog(): void {
  // Always release the reserved dock rail (safe no-op when never docked).
  const root = document.documentElement;
  root.classList.remove("ef-dock-active");
  root.style.removeProperty("--ef-dock-w");

  // Drop the issue-modal keyboard state so a later reopen starts clean.
  issueModalOpen = false;
  authLayerOpen = false;

  // Prompt layers still waiting for input must resolve rather than leak their
  // keyboard handlers and leave callers hanging.
  if (authLayerCancels.length) {
    const cancels = authLayerCancels.splice(0);
    for (const cancel of cancels) cancel();
  }

  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return;
  if (dialogKeydown) {
    document.removeEventListener("keydown", dialogKeydown, true);
    dialogKeydown = null;
  }
  if (dialogKeyHandler) {
    document.removeEventListener("keydown", dialogKeyHandler);
    dialogKeyHandler = null;
  }
  if (dialogCleanup) {
    dialogCleanup();
    dialogCleanup = null;
  }
  endDragVisual();
  dialog.remove();
  // Return focus to the control that opened the dialog, if it still exists.
  const ret = focusReturnEl;
  focusReturnEl = null;
  if (ret && document.contains(ret) && typeof ret.focus === "function") {
    try { ret.focus(); } catch { /* element may have been removed */ }
  }
}

// ── Drag visuals (moving an element on the page) ──────────────────────────────
// index.ts owns the gesture — threshold, gating, click swallowing. This module
// owns the three transient layers it draws: a chip that follows the cursor and
// names the element, an insertion line at the drop point, and a dashed box
// around the container that would receive it. All three are overlay chrome with
// `pointer-events: none`, so `elementFromPoint` never returns them.

const DRAG_GHOST_ID = "__ef_drag_ghost__";
const DRAG_LINE_ID = "__ef_drag_line__";
const DRAG_BOX_ID = "__ef_drag_box__";
const DRAG_COLOR = "#4f86f7"; // blue — the pick/insert colour

function fixedLayer(id: string, styles: Record<string, string>): HTMLDivElement {
  const el = document.createElement("div");
  el.id = id;
  const base: Record<string, string> = {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483646",
    boxSizing: "border-box",
    display: "none",
  };
  Object.assign(el.style, base, styles);
  return el;
}

/** Create the drag layers. Called once the pointer passes the drag threshold. */
export function startDragVisual(label: string): void {
  endDragVisual();
  const ghost = fixedLayer(DRAG_GHOST_ID, {
    padding: "3px 8px",
    borderRadius: "6px",
    background: "rgba(17, 24, 39, 0.92)",
    color: "#fff",
    font: "600 11px/1.4 ui-sans-serif, system-ui, sans-serif",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.28)",
    whiteSpace: "nowrap",
  });
  ghost.textContent = `Moving ${label}`;
  document.body.appendChild(ghost);
  document.body.appendChild(
    fixedLayer(DRAG_BOX_ID, {
      border: `1px dashed ${DRAG_COLOR}`,
      borderRadius: "3px",
    })
  );
  document.body.appendChild(
    fixedLayer(DRAG_LINE_ID, { background: DRAG_COLOR, borderRadius: "1px" })
  );
}

/**
 * Follow the pointer and draw the resolved drop: the ghost at the cursor, the
 * insertion line where the element would land, and the receiving container.
 * `drop === null` means the current position is not a legal target.
 */
export function updateDragVisual(
  x: number,
  y: number,
  dragged: Element,
  drop: DropTarget | null
): void {
  const ghost = document.getElementById(DRAG_GHOST_ID);
  const line = document.getElementById(DRAG_LINE_ID);
  const box = document.getElementById(DRAG_BOX_ID);
  if (!ghost || !line || !box) return; // the drag ended underneath us

  ghost.style.display = "block";
  ghost.style.left = `${x + 14}px`;
  ghost.style.top = `${y + 16}px`;

  if (!drop) {
    line.style.display = "none";
    box.style.display = "none";
    return;
  }

  const cRect = drop.container.getBoundingClientRect();
  box.style.display = "block";
  box.style.left = `${cRect.left}px`;
  box.style.top = `${cRect.top}px`;
  box.style.width = `${cRect.width}px`;
  box.style.height = `${cRect.height}px`;

  // The line sits on the edge the element would be inserted at: before-sibling's
  // leading edge, or the last child's trailing edge when it would be appended.
  const ref = drop.before ?? drop.container.lastElementChild;
  const r = ref && ref !== dragged ? ref.getBoundingClientRect() : null;
  if (layoutAxis(drop.container) === "x") {
    const at = r ? (drop.before ? r.left : r.right) : cRect.left;
    Object.assign(line.style, {
      display: "block",
      left: `${at - 1}px`,
      top: `${cRect.top}px`,
      width: "2px",
      height: `${cRect.height}px`,
    });
  } else {
    const at = r ? (drop.before ? r.top : r.bottom) : cRect.top;
    Object.assign(line.style, {
      display: "block",
      left: `${cRect.left}px`,
      top: `${at - 1}px`,
      width: `${cRect.width}px`,
      height: "2px",
    });
  }
}

/** Remove the drag layers (drop, cancel, mode change, dialog close). */
export function endDragVisual(): void {
  for (const id of [DRAG_GHOST_ID, DRAG_LINE_ID, DRAG_BOX_ID]) {
    document.getElementById(id)?.remove();
  }
}

export interface GrantAccessOptions {
  repo: string;
  authorizeUrl: string;
  onRetry?: () => Promise<unknown>;
}

/**
 * Prompts the user to grant the feedback GitHub App access to the repo.
 * Shown when `POST /issue/export` returns 403 app_access_required. Returns a
 * promise resolving `true` when the retry succeeds and `false` on cancel —
 * preserving the underlying issue modal and its draft either way.
 */
export function showGrantAccessDialog(opts: GrantAccessOptions): Promise<boolean> {
  const previousFocus = document.activeElement as HTMLElement | null;
  const layer = appendAuthLayer();
  layer.innerHTML = `
    <div class="ef-login-card" role="dialog" aria-modal="true" aria-labelledby="__ef_grant_title__" tabindex="-1">
      <h2 id="__ef_grant_title__">App access required</h2>
      <p>The feedback app does not have access to <code>${escapeHtml(opts.repo)}</code>.</p>
      <div class="ef-login-actions">
        <button class="ef-btn-secondary" id="__ef_grant_cancel__">Cancel</button>
        <button class="ef-btn-primary" id="__ef_grant__">Grant access</button>
        <button class="ef-btn-primary" id="__ef_retry__">Retry</button>
      </div>
      <div class="ef-error" id="__ef_grant_err__" style="margin-top:8px"></div>
    </div>
  `;

  const card = layer.querySelector<HTMLElement>(".ef-login-card")!;
  const grantBtn = layer.querySelector<HTMLButtonElement>("#__ef_grant__")!;
  const retryBtn = layer.querySelector<HTMLButtonElement>("#__ef_retry__")!;
  const cancelBtn = layer.querySelector<HTMLButtonElement>("#__ef_grant_cancel__")!;
  const errDiv = layer.querySelector<HTMLElement>("#__ef_grant_err__")!;

  // With no authorize URL there is nothing to grant — show Retry directly.
  const showGrant = !!opts.authorizeUrl;
  grantBtn.style.display = showGrant ? "" : "none";
  retryBtn.style.display = showGrant ? "none" : "";

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let detachTrap: () => void = () => {};
    let detachEsc: () => void = () => {};
    let cancel = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const idx = authLayerCancels.indexOf(cancel);
      if (idx >= 0) authLayerCancels.splice(idx, 1);
      detachTrap();
      detachEsc();
      removeAuthLayer(layer);
      // Give focus back to the control/dialog under this layer; fall back to
      // the issue card when that control was disabled for the request.
      const canRestore =
        previousFocus !== null &&
        document.contains(previousFocus) &&
        !(previousFocus as HTMLButtonElement).disabled;
      const remainingLayer = topAuthLayer();
      const target = canRestore
        ? previousFocus
        : remainingLayer?.querySelector<HTMLElement>(".ef-login-card") ??
          // Whichever surface the reporter is on (issue card or editor).
          document.querySelector<HTMLElement>(
            ".ef-issue-card, .ef-card:not([hidden])"
          ) ??
          document.getElementById(DIALOG_ID);
      target?.focus();
      resolve(ok);
    };
    cancel = () => finish(false);
    authLayerCancels.push(cancel);
    detachTrap = trapAuthFocus(layer, card);
    detachEsc = addAuthEscape(layer, () => finish(false));

    grantBtn.addEventListener("click", () => {
      if (opts.authorizeUrl) window.open(opts.authorizeUrl, "_blank", "noopener");
      grantBtn.style.display = "none";
      retryBtn.style.display = "";
      errDiv.textContent = "";
      retryBtn.focus();
    });

    retryBtn.addEventListener("click", async () => {
      if (!opts.onRetry) { finish(false); return; }
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      errDiv.textContent = "";
      try {
        await opts.onRetry();
        finish(true);
      } catch (err) {
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
        // Still missing access → keep the layer open silently; the user can
        // retry again. A declined re-auth keeps it open too. Other failures
        // surface inline so the draft is never obscured.
        if (err instanceof APIError && err.code === "app_access_required") return;
        if (err instanceof AuthCancelledError) return;
        errDiv.textContent = describeAPIError(err);
      }
    });

    cancelBtn.addEventListener("click", () => finish(false));
    layer.addEventListener("click", (e) => { if (e.target === layer) finish(false); });
    card.focus();
  });
}

const TOAST_ID = "__ef_toast__";

function injectToastStyles(): void {
  if (document.getElementById(TOAST_ID + "_styles")) return;
  const style = document.createElement("style");
  style.id = TOAST_ID + "_styles";
  style.textContent = `
    #${TOAST_ID} {
      /* Theme tokens — light defaults; overridden under [data-ef-theme="dark"]. */
      --ef-toast-bg: oklch(0.215 0.016 274);
      --ef-toast-text: oklch(0.93 0.008 265);
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
      --ef-toast-bg: oklch(0.175 0.014 274);
      --ef-toast-text: oklch(0.93 0.008 265);
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
