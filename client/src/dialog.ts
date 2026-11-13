// dialog.ts — submission-first feedback dialog: the GitHub-issue card is the
// primary surface, with an optional live style editor sidebar behind it, plus
// the login/grant dialogs.

import {
  APIError,
  AuthCancelledError,
  describeAPIError,
  withAuthRetry,
} from "./api";
import type {
  APIClient,
  FeedbackComment,
  ExportIssueResult,
  IssueBadge,
  MemoryStatus,
} from "./api";
import {
  deleteDraft,
  emptyDraft,
  findDraftBySelector,
  listDrafts,
  migrateLegacyDrafts,
  saveDraft,
  updateDraft,
  type DraftRecord,
  type FeedbackType,
} from "./drafts";
import type {
  FeedbackIntent,
  IntentAction,
  StyleChange,
} from "./envelope";
import { syncThemeTo } from "./theme";
import { mountStyleEditor } from "./styleEditor";
import {
  buildChatContext,
  loadChat,
  mountChat,
  pickedVariant,
  saveChat,
  withPick,
  type ChatPanel,
  type ChatTurn,
  type ReportSuggestion,
} from "./chat";
import {
  buildDesignAttachment,
  buildVariantDocument,
  collectHostStyles,
  variantRef,
  type Gallery,
  type GalleryVariant,
} from "./gallery";
import { layoutAxis, type DropTarget } from "./structure";
import type { ThemeTokens } from "./tokens";
import {
  addTarget as addSelectionTarget,
  applyTokenToTarget,
  beginDraft,
  clearCommitted,
  clearTextForTarget,
  clearTokenForTarget,
  discardDraft,
  flash as flashTarget,
  getChangeCountFor,
  getChanges,
  getChangesFor,
  getCommittedEntries,
  getDraftChangeCount,
  getTargets as getSelectionTargets,
  isPickMode,
  notifySelectionChange,
  onHighlightChange,
  onSelectionChange,
  refreshOutlines,
  removeTarget as removeSelectionTarget,
  revertPending,
  setHighlight,
  setPickMode,
  setTextForTarget,
  suspendDraft,
  type TargetEntry,
} from "./selection";

const DIALOG_ID = "__ef_dialog__";
const STYLE_ID = "__ef_styles__";
const DOCKED_KEY = "__ef_dialog_docked__";
const DESTINATION_KEY = "__ef_report_destination__";

/**
 * Where the primary report action sends the feedback: GitHub (issue export),
 * Memory (the connected project), or Session (an order-box-fronted coding
 * agent session).
 */
type ReportDestination = "github" | "memory" | "session";

/** Narrows an arbitrary string (a dataset value) to a destination. */
function isReportDestination(value: string | undefined): value is ReportDestination {
  return value === "github" || value === "memory" || value === "session";
}

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

/**
 * Persisted report destination. Memory and Session are only valid remembered
 * values while each is configured for this host; otherwise fall back to
 * `fallback` — which is Session on a host that has one but no signed-in
 * reporter, and GitHub everywhere else.
 */
function readDestinationPref(
  allowMemory: boolean,
  allowSession = false,
  fallback: ReportDestination = "github"
): ReportDestination {
  try {
    const v = localStorage.getItem(DESTINATION_KEY);
    if (v === "memory" && allowMemory) return "memory";
    if (v === "session" && allowSession) return "session";
  } catch {
    // Storage may be unavailable (private mode / sandboxed iframe).
  }
  return fallback;
}

function writeDestinationPref(destination: ReportDestination): void {
  try {
    localStorage.setItem(DESTINATION_KEY, destination);
  } catch {
    // Storage may be unavailable (private mode / sandboxed iframe).
  }
}

// Draft text/targets live in ./drafts (page-scoped registry); live style edits
// are owned by ./selection and suspended/resumed per draft id.

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
      /* Centered (undocked) the card shrink-wraps its content; keep a floor so
         a short tab does not collapse the whole window. Never exceed the max. */
      min-height: min(560px, 85vh);
      max-height: 85vh;
      box-shadow: var(--ef-card-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Only the card of the active view is visible. Both stay mounted so typed
       text, chip state and live style edits survive a view swap. */
    #__ef_dialog__ .ef-card[hidden] { display: none !important; }
    /* The pane is always docked-capable; the root keeps a backdrop only when the
       card is centered (undocked), where it behaves as a modal sheet. */
    #__ef_dialog__.ef-docked { background: transparent; pointer-events: none; }
    /* Pane steps aside while the user picks an element on the page. */
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
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
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
      background: var(--ef-surface);
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

    /* ── Chips (Chat suggestions) ──────────────────────────────────────────── */
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

    /* ── Pane tabs (Feedback · Edit · Changes · Chat) ─────────────────────── */
    #__ef_dialog__ .ef-tabs {
      display: flex;
      gap: 2px;
      padding: 0 12px;
      border-bottom: 1px solid var(--ef-border);
      background: var(--ef-surface);
      flex-shrink: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    #__ef_dialog__ .ef-tabs::-webkit-scrollbar { display: none; }
    #__ef_dialog__ .ef-tab {
      appearance: none;
      border: 0;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      background: transparent;
      color: var(--ef-muted-strong);
      font: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      padding: 8px 10px 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-tab:hover { color: var(--ef-heading); }
    #__ef_dialog__ .ef-tab[aria-selected="true"] {
      color: var(--ef-primary);
      border-bottom-color: var(--ef-primary);
    }
    #__ef_dialog__ .ef-tab:focus-visible {
      outline: 2px solid var(--ef-primary);
      outline-offset: -2px;
      border-radius: 4px;
    }
    #__ef_dialog__ .ef-tab-count {
      min-width: 15px;
      height: 15px;
      padding: 0 4px;
      border-radius: 8px;
      background: var(--ef-chip-on-bg);
      color: var(--ef-chip-on-text);
      font-size: 9px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #__ef_dialog__ .ef-tab-count[hidden] { display: none; }
    #__ef_dialog__ .ef-tabs[hidden] { display: none; }

    /* Breadcrumb back to the page-level report list. */
    #__ef_dialog__ .ef-header-crumb {
      display: flex;
      margin-bottom: 4px;
    }
    #__ef_dialog__ .ef-header-crumb[hidden] { display: none; }
    #__ef_dialog__ .ef-crumbs {
      appearance: none;
      border: 1px solid var(--ef-control-border);
      background: var(--ef-btn-secondary-bg);
      color: var(--ef-text-soft);
      border-radius: 6px;
      font: inherit;
      font-size: 10px;
      font-weight: 700;
      padding: 3px 7px;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-crumbs:hover {
      background: var(--ef-btn-secondary-hover-bg);
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-crumbs[hidden] { display: none; }

    /* ── All reports (page-level master list) ──────────────────────────────── */
    #__ef_dialog__ .ef-reports {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-reports[hidden] { display: none; }
    #__ef_dialog__ .ef-reports-body {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 14px 16px;
    }
    #__ef_dialog__ .ef-reports-empty {
      font-size: 11px;
      line-height: 1.55;
      color: var(--ef-muted-strong);
      padding: 6px 0;
    }
    #__ef_dialog__ .ef-report-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #__ef_dialog__ .ef-report-item {
      display: flex;
      align-items: stretch;
      gap: 4px;
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      background: var(--ef-control-bg);
      overflow: hidden;
    }
    #__ef_dialog__ .ef-report-main {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      padding: 8px 10px;
      cursor: pointer;
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #__ef_dialog__ .ef-report-main:hover { background: var(--ef-hover-bg); }
    #__ef_dialog__ .ef-report-main:disabled { cursor: default; opacity: 0.6; }
    #__ef_dialog__ .ef-report-main:focus-visible {
      outline: 2px solid var(--ef-primary);
      outline-offset: -2px;
    }
    #__ef_dialog__ .ef-report-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--ef-heading);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-report-meta {
      font-size: 10px;
      color: var(--ef-muted-strong);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: baseline;
    }
    #__ef_dialog__ .ef-report-sel {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 9px;
      color: var(--ef-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-report-cancel {
      appearance: none;
      border: 0;
      border-left: 1px solid var(--ef-border);
      background: transparent;
      color: var(--ef-muted-strong);
      font: inherit;
      font-size: 10px;
      font-weight: 600;
      padding: 0 10px;
      cursor: pointer;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-report-cancel:hover {
      background: var(--ef-bug-bg);
      color: var(--ef-bug);
    }
    #__ef_dialog__ .ef-report-cancel[data-confirm="true"] {
      background: var(--ef-bug-bg);
      color: var(--ef-bug);
    }
    #__ef_dialog__ .ef-report-cancel:disabled { opacity: 0.5; cursor: default; }
    #__ef_dialog__ .ef-report-status {
      font-weight: 700;
      color: var(--ef-accent);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #__ef_dialog__ .ef-report-state {
      font-weight: 700;
      color: var(--ef-muted-strong);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #__ef_dialog__ .ef-report-state[data-state="open"] { color: var(--ef-accent); }
    #__ef_dialog__ .ef-report-state[data-state="closed"] {
      color: var(--ef-muted);
      text-decoration: line-through;
    }
    #__ef_dialog__ .ef-filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: var(--ef-muted-strong);
      cursor: pointer;
      user-select: none;
    }
    #__ef_dialog__ .ef-filter-toggle input {
      margin: 0;
      accent-color: var(--ef-primary);
    }
    #__ef_dialog__ .ef-report-issue {
      color: var(--ef-primary);
      font-weight: 600;
      text-decoration: none;
    }
    #__ef_dialog__ .ef-report-issue:hover { text-decoration: underline; }
    #__ef_dialog__ .ef-reports-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px 14px;
      border-top: 1px solid var(--ef-border-subtle);
    }

    /* Panels hold their own scroll region so a long report never scrolls the
       tab bar out of reach. */
    #__ef_dialog__ .ef-panels {
      flex: 1;
      min-height: 0;
      display: flex;
    }
    #__ef_dialog__ .ef-panel {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    #__ef_dialog__ .ef-panel[hidden] { display: none; }
    #__ef_dialog__ .ef-panels[hidden] { display: none; }
    #__ef_dialog__ .ef-report,
    #__ef_dialog__ .ef-design {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    #__ef_dialog__ .ef-report[hidden],
    #__ef_dialog__ .ef-design[hidden] { display: none; }
    /* The Changes panel owns the whole tab, so it scrolls itself. */
    #__ef_dialog__ #__ef_panel_changes__ .ef-changes {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      border-top: 0;
    }

    /* ── Chat (report composer) ─────────────────────────────────────────────── */
    #__ef_dialog__ .ef-chat {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    #__ef_dialog__ .ef-chat-ctx {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 7px 16px;
      border-bottom: 1px solid var(--ef-border-subtle);
      font-size: 10px;
      color: var(--ef-muted);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-chat-ctx-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ef-muted);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-chat-ctx-sel {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 46%;
    }
    #__ef_dialog__ .ef-chat-ctx-meta {
      margin-left: auto;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-chat-log {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #__ef_dialog__ .ef-chat-empty {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 6px;
    }
    #__ef_dialog__ .ef-chat-empty-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-chat-empty-sub {
      margin: 0;
      font-size: 11px;
      line-height: 1.5;
      color: var(--ef-muted-strong);
    }
    #__ef_dialog__ .ef-chat-suggest {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    #__ef_dialog__ .ef-chat-turn {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-chat-user { align-items: flex-end; }
    #__ef_dialog__ .ef-chat-bubble {
      font-size: 12px;
      line-height: 1.5;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--ef-surface);
      color: var(--ef-text);
      max-width: 92%;
      white-space: pre-wrap;
      word-break: break-word;
    }
    #__ef_dialog__ .ef-chat-user .ef-chat-bubble {
      background: var(--ef-chip-on-bg);
      color: var(--ef-chip-on-text);
    }
    #__ef_dialog__ .ef-chat-assistant .ef-chat-bubble {
      background: transparent;
      padding: 0;
      max-width: 100%;
    }
    #__ef_dialog__ .ef-chat-error .ef-chat-bubble { color: var(--ef-error); }
    #__ef_dialog__ .ef-report-card {
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--ef-surface);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #__ef_dialog__ .ef-report-card-head {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-report-fields {
      margin: 0;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 3px 10px;
      font-size: 11px;
    }
    #__ef_dialog__ .ef-report-fields dt {
      color: var(--ef-muted-strong);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-report-fields dd {
      margin: 0;
      color: var(--ef-text-soft);
      word-break: break-word;
    }
    #__ef_dialog__ .ef-report-missing {
      margin: 0;
      font-size: 11px;
      color: var(--ef-muted);
      font-style: italic;
    }
    /* ── Design gallery ──────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-gallery-card {
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      padding: 10px;
      background: var(--ef-surface);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #__ef_dialog__ .ef-gallery-card-head {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-gallery-options {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 11px;
    }
    #__ef_dialog__ .ef-gallery-options li {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--ef-text-soft);
    }
    #__ef_dialog__ .ef-gallery-options li.is-picked {
      color: var(--ef-text-strong);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-gallery-option-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-gallery-option-badge {
      flex-shrink: 0;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ef-accent);
      background: var(--ef-accent-soft);
      border-radius: 999px;
      padding: 1px 6px;
    }
    #__ef_dialog__ .ef-gallery-card .ef-btn-secondary {
      align-self: flex-start;
    }
    #__ef_dialog__ .ef-variant-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--ef-border);
      border-left: 3px solid var(--ef-accent);
      border-radius: 6px;
      background: var(--ef-accent-soft);
      padding: 6px 8px;
      margin: 8px 0;
      font-size: 11px;
      color: var(--ef-text-soft);
    }
    #__ef_dialog__ .ef-variant-chip[hidden] {
      display: none;
    }
    #__ef_dialog__ .ef-variant-chip-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-variant-chip-name {
      font-weight: 600;
      color: var(--ef-text-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-variant-chip-actions {
      margin-left: auto;
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-gallery-layer {
      /* Fixed, not absolute: the pane can be docked to a 400px rail, and the
         gallery must still cover the viewport. The docked root also turns
         pointer events off, so this layer re-enables them for itself. */
      position: fixed;
      inset: 0;
      z-index: 30;
      pointer-events: auto;
      background: var(--ef-backdrop);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    #__ef_dialog__ .ef-gallery-modal {
      display: flex;
      flex-direction: column;
      width: min(1180px, 100%);
      max-height: 100%;
      background: var(--ef-card-bg);
      border-radius: 12px;
      box-shadow: var(--ef-card-shadow);
      overflow: hidden;
    }
    #__ef_dialog__ .ef-gallery-head {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-gallery-eyebrow {
      margin: 0 0 2px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-gallery-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-gallery-head-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-gallery-size {
      display: flex;
      border: 1px solid var(--ef-border);
      border-radius: 6px;
      overflow: hidden;
    }
    #__ef_dialog__ .ef-gallery-size-btn {
      border: 0;
      background: var(--ef-control-bg);
      color: var(--ef-chip-fg);
      font: inherit;
      font-size: 11px;
      padding: 4px 8px;
      cursor: pointer;
    }
    #__ef_dialog__ .ef-gallery-size-btn[aria-pressed="true"] {
      background: var(--ef-primary);
      color: var(--ef-primary-content);
      font-weight: 600;
    }
    #__ef_dialog__ .ef-gallery-close {
      border: 1px solid var(--ef-border);
      background: var(--ef-control-bg);
      color: var(--ef-chip-fg);
      border-radius: 6px;
      width: 26px;
      height: 26px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
    }
    #__ef_dialog__ .ef-gallery-grid {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      padding: 14px 16px;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-gallery-tile {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      background: var(--ef-card-bg);
      overflow: hidden;
      min-width: 0;
    }
    #__ef_dialog__ .ef-gallery-tile.is-picked {
      border-color: var(--ef-accent);
      box-shadow: 0 0 0 2px var(--ef-accent-soft);
    }
    #__ef_dialog__ .ef-gallery-grid.is-zoomed {
      grid-template-columns: 1fr;
    }
    #__ef_dialog__ .ef-gallery-grid.is-zoomed .ef-gallery-tile:not(.is-zoomed) {
      display: none;
    }
    #__ef_dialog__ .ef-gallery-frame {
      height: 240px;
      background: var(--ef-surface-alt);
      display: flex;
      justify-content: center;
      overflow: hidden;
    }
    #__ef_dialog__ .ef-gallery-tile.is-zoomed .ef-gallery-frame {
      height: min(60vh, 640px);
    }
    #__ef_dialog__ .ef-gallery-iframe {
      border: 0;
      width: 100%;
      height: 100%;
      background: var(--ef-card-bg);
    }
    #__ef_dialog__ .ef-gallery-grid[data-width="mobile"] .ef-gallery-iframe {
      width: 390px;
      max-width: 100%;
      border-left: 1px solid var(--ef-border);
      border-right: 1px solid var(--ef-border);
    }
    #__ef_dialog__ .ef-gallery-tile-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid var(--ef-border);
    }
    #__ef_dialog__ .ef-gallery-tile-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #__ef_dialog__ .ef-gallery-tile-head h4 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--ef-heading);
    }
    #__ef_dialog__ .ef-gallery-tile-notes {
      margin: 0;
      font-size: 11px;
      line-height: 1.45;
      color: var(--ef-muted-strong);
    }
    #__ef_dialog__ .ef-gallery-tile-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    #__ef_dialog__ .ef-gallery-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid var(--ef-border);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-gallery-note {
      margin: 0;
      font-size: 10px;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-gallery-foot-spacer {
      flex: 1;
    }
    #__ef_dialog__ .ef-chat-compose {
      border-top: 1px solid var(--ef-border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-chat-compose textarea {
      resize: vertical;
      min-height: 44px;
      max-height: 160px;
    }
    #__ef_dialog__ .ef-chat-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
    #__ef_dialog__ .ef-chat-note {
      margin: 0;
      padding: 0 16px 10px;
      font-size: 10px;
      color: var(--ef-muted);
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
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
      padding: 10px 8px 12px 16px;
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

    /* ── Live style editor ─────────────────────────────────────────────────────
       Property-inspector layout: a labelled field grid inside collapsible
       sections. Fields pair into two columns; segmented groups keep their
       intrinsic width and never stretch. Sizes follow a design tool's inspector
       (26px controls, 10px labels, 8px gutters) in this overlay's palette. */
    #__ef_dialog__ .ef-style-editor {
      display: flex;
      flex-direction: column;
    }
    #__ef_dialog__ .ef-style-empty {
      font-size: 12px;
      color: var(--ef-muted);
      padding: 4px 16px 12px;
    }
    #__ef_dialog__ .ef-style-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 8px 6px 16px;
      min-width: 0;
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
      min-width: 0;
      cursor: default;
    }
    /* Where the element sits in its parent + the "drag to move" affordance. */
    #__ef_dialog__ .ef-style-context {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px 10px 16px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-style-position {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: var(--ef-text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    #__ef_dialog__ .ef-style-drag-hint {
      font-size: 10px;
      color: var(--ef-muted);
      flex-shrink: 0;
    }

    /* ── Sections ─────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-style-section {
      border-top: 1px solid var(--ef-border);
    }
    #__ef_dialog__ .ef-section-head {
      display: flex;
      align-items: center;
      height: 34px;
      padding: 0 8px 0 16px;
      gap: 4px;
    }
    #__ef_dialog__ .ef-section-toggle {
      flex: 1;
      min-width: 0;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      border: none;
      background: none;
      color: var(--ef-text);
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }
    #__ef_dialog__ .ef-section-toggle:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
      border-radius: 4px;
    }
    #__ef_dialog__ .ef-section-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: var(--ef-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-section-chevron {
      display: inline-flex;
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      color: var(--ef-muted);
      transition: transform 0.12s ease;
    }
    #__ef_dialog__ .ef-section-chevron svg {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #__ef_dialog__ .ef-style-section:not(.ef-section-collapsed) .ef-section-chevron {
      transform: rotate(90deg);
    }
    #__ef_dialog__ .ef-section-reset {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--ef-muted);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.45;
      transition: opacity 0.12s, color 0.12s, background 0.12s;
    }
    #__ef_dialog__ .ef-section-reset svg {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
    }
    #__ef_dialog__ .ef-section-reset:hover:not(:disabled) {
      opacity: 1;
      color: var(--ef-text-strong);
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-section-reset:disabled {
      opacity: 0;
      visibility: hidden;
      cursor: default;
    }
    #__ef_dialog__ .ef-section-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 8px;
      padding: 4px 8px 14px 16px;
    }
    #__ef_dialog__ .ef-section-collapsed .ef-section-body {
      display: none;
    }

    /* ── Fields ───────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-prop-row {
      grid-column: 1 / -1;
      min-width: 0;
    }
    #__ef_dialog__ .ef-prop-row--half {
      grid-column: span 1;
    }
    #__ef_dialog__ .ef-prop-head {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 14px;
      margin-bottom: 5px;
      min-width: 0;
    }
    #__ef_dialog__ .ef-prop-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--ef-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    #__ef_dialog__ .ef-prop-reset {
      margin-left: auto;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--ef-muted);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s, background 0.12s;
    }
    #__ef_dialog__ .ef-prop-reset svg {
      width: 12px;
      height: 12px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
    }
    #__ef_dialog__ .ef-prop-row:hover .ef-prop-reset,
    #__ef_dialog__ .ef-prop-row:focus-within .ef-prop-reset {
      opacity: 0.9;
    }
    #__ef_dialog__ .ef-prop-row .ef-prop-reset:hover,
    #__ef_dialog__ .ef-prop-reset:focus-visible {
      opacity: 1;
      color: var(--ef-text-strong);
      background: var(--ef-hover-bg);
      outline: none;
    }
    #__ef_dialog__ .ef-prop-control {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #__ef_dialog__ .ef-prop-row--segmented .ef-prop-control {
      align-items: flex-start;
    }

    /* Direct-text field: the element's own editable text, above the sections. */
    #__ef_dialog__ .ef-text-row {
      padding: 0 8px 12px 16px;
    }
    #__ef_dialog__ .ef-text-input {
      width: 100%;
      height: 26px;
      padding: 0 9px;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      background: var(--ef-control-bg);
      color: var(--ef-text);
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    #__ef_dialog__ .ef-text-input:hover {
      border-color: var(--ef-control-border-hover);
    }
    #__ef_dialog__ .ef-text-input:focus {
      border-color: var(--ef-primary);
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
    }
    #__ef_dialog__ .ef-text-reset[hidden] {
      display: none;
    }
    #__ef_dialog__ .ef-text-reset:not([hidden]) {
      opacity: 0.6;
    }

    /* ── Value field (select) ─────────────────────────────────────────────── */
    #__ef_dialog__ .ef-select {
      position: relative;
      min-width: 0;
    }
    #__ef_dialog__ .ef-select-trigger {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      height: 26px;
      padding: 0 7px 0 8px;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      background: var(--ef-control-bg);
      color: var(--ef-text);
      font-size: 11px;
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
    #__ef_dialog__ .ef-select-trigger:focus-visible,
    #__ef_dialog__ .ef-select-trigger[aria-expanded="true"] {
      outline: none;
      border-color: var(--ef-primary);
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
    }
    #__ef_dialog__ .ef-select-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* An unset field reads as a placeholder; an applied value is the only thing
       that gets full-strength text. */
    #__ef_dialog__ .ef-prop-row:not(.ef-is-set) .ef-select-label {
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-select-caret {
      display: inline-flex;
      width: 10px;
      height: 10px;
      flex-shrink: 0;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-select-caret svg {
      width: 10px;
      height: 10px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #__ef_dialog__ .ef-select-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 3px);
      z-index: 20;
      margin: 0;
      padding: 4px;
      list-style: none;
      background: var(--ef-card-bg);
      border: 1px solid var(--ef-border);
      border-radius: 8px;
      box-shadow: var(--ef-card-shadow);
      max-height: 240px;
      overflow-y: auto;
    }
    #__ef_dialog__ .ef-select-option {
      display: flex;
      align-items: center;
      gap: 7px;
      height: 24px;
      padding: 0 7px;
      border-radius: 5px;
      font-size: 11px;
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
      height: 24px;
      padding: 0 7px;
      border-radius: 5px;
      font-size: 11px;
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
      padding: 4px 2px 2px;
      list-style: none;
    }
    #__ef_dialog__ .ef-select-custom-edit[hidden] { display: none; }
    #__ef_dialog__ .ef-custom-input {
      width: 100%;
      height: 26px;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      padding: 0 8px;
      font-size: 11px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: var(--ef-text-strong);
      outline: none;
      background: var(--ef-surface);
    }
    #__ef_dialog__ .ef-custom-input:focus {
      border-color: var(--ef-primary);
      background: var(--ef-control-bg);
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
    }
    #__ef_dialog__ .ef-custom-input[aria-invalid="true"] {
      border-color: var(--ef-error);
    }

    /* ── Segmented groups (icon cells) ────────────────────────────────────── */
    #__ef_dialog__ .ef-segmented {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: stretch;
      gap: 1px;
      padding: 1px;
      max-width: 100%;
      background: var(--ef-control-border);
      border-radius: 7px;
      overflow: hidden;
    }
    #__ef_dialog__ .ef-segmented .ef-icon-btn {
      width: 27px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: var(--ef-control-bg);
      color: var(--ef-muted-strong);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-segmented .ef-icon-btn:hover {
      background: var(--ef-hover-bg);
      color: var(--ef-text-strong);
    }
    #__ef_dialog__ .ef-segmented .ef-icon-btn:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px var(--ef-focus-ring-chip);
    }
    #__ef_dialog__ .ef-segmented .ef-icon-btn.ef-token-on {
      background: var(--ef-chip-on-bg);
      color: var(--ef-chip-on-text);
      box-shadow: inset 0 0 0 1px var(--ef-primary);
    }
    #__ef_dialog__ .ef-segmented .ef-icon-btn svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #__ef_dialog__ .ef-cell-text {
      font-size: 10px;
      font-weight: 600;
      padding: 0 4px;
      white-space: nowrap;
    }

    /* ── Chip rows (host manifests that ask for render: "chips") ───────────── */
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

    /* ── Hidden-settings note ─────────────────────────────────────────────── */
    #__ef_dialog__ .ef-style-hidden-note {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 8px 10px 16px;
      border-top: 1px solid var(--ef-border);
      font-size: 11px;
    }
    #__ef_dialog__ .ef-hidden-reasons {
      color: var(--ef-muted);
      flex: 1;
      min-width: 0;
      line-height: 1.4;
    }
    #__ef_dialog__ .ef-show-all {
      height: 22px;
      padding: 0 8px;
      border: 1px solid var(--ef-control-border);
      border-radius: 6px;
      background: transparent;
      color: var(--ef-text-soft);
      font-size: 10px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-show-all:hover {
      border-color: var(--ef-control-border-hover);
      background: var(--ef-hover-bg);
      color: var(--ef-text-strong);
    }
    #__ef_dialog__ .ef-show-all:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--ef-focus-ring-input);
    }

    /* ── Current classes (section-style disclosure) ───────────────────────── */
    #__ef_dialog__ .ef-style-classes {
      border-top: 1px solid var(--ef-border);
    }
    #__ef_dialog__ .ef-style-classes summary {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      padding: 0 16px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    #__ef_dialog__ .ef-style-classes summary::-webkit-details-marker { display: none; }
    #__ef_dialog__ .ef-style-classes[open] .ef-section-chevron {
      transform: rotate(90deg);
    }
    #__ef_dialog__ .ef-style-class-list {
      padding: 0 16px 12px;
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
      font-size: 10.5px;
      color: var(--ef-text-soft);
      word-break: break-all;
    }
    #__ef_dialog__ .ef-style-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* Phones: a 400px rail keeps two columns, but a ~380px screen cannot fit a
       6-cell icon track in one, so the field grid collapses to a single column. */
    @media (max-width: 420px) {
      #__ef_dialog__ .ef-section-body {
        grid-template-columns: 1fr;
      }
      #__ef_dialog__ .ef-prop-row--half {
        grid-column: 1 / -1;
      }
    }

    /* ── Changes summary ───────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-changes {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px 8px 18px 16px;
      border-top: 1px solid var(--ef-border);
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
    /* Labels stay whole; the row wraps between buttons, never inside one. */
    #__ef_dialog__ .ef-issue-foot .ef-btn-secondary,
    #__ef_dialog__ .ef-issue-foot .ef-btn-primary { white-space: nowrap; }
    /* The 400px rail has ~370px of footer: tighten it so the four actions fit
       on one line instead of stacking. */
    #__ef_dialog__.ef-docked .ef-issue-foot { padding: 10px 14px; gap: 6px; }
    #__ef_dialog__.ef-docked .ef-issue-foot .ef-btn-secondary,
    #__ef_dialog__.ef-docked .ef-issue-foot .ef-btn-primary {
      padding-left: 10px;
      padding-right: 10px;
    }
    #__ef_dialog__ .ef-destination {
      position: relative;
      display: inline-flex;
      margin-right: 2px;
    }
    #__ef_dialog__ .ef-destination[hidden] { display: none; }
    /* A session-only host opens without a GitHub account, so the Save action
       (which needs one) is hidden rather than offering a dead end. */
    #__ef_dialog__ #__ef_submit__[hidden] { display: none; }
    #__ef_dialog__ .ef-destination-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding-right: 10px;
    }
    #__ef_dialog__ .ef-destination-caret {
      font-size: 10px;
      line-height: 1;
      color: var(--ef-muted);
    }
    #__ef_dialog__ .ef-destination-menu {
      position: absolute;
      left: 0;
      bottom: calc(100% + 6px);
      z-index: 20;
      min-width: 148px;
      margin: 0;
      padding: 4px;
      list-style: none;
      border: 1px solid var(--ef-border);
      border-radius: 10px;
      background: var(--ef-card-bg);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    }
    #__ef_dialog__ .ef-destination-menu[hidden] { display: none; }
    #__ef_dialog__ .ef-destination-menu [role="option"] {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 8px 10px;
      border-radius: 7px;
      color: var(--ef-text);
      font-size: 13px;
      cursor: pointer;
      outline: none;
    }
    #__ef_dialog__ .ef-destination-menu [role="option"]:hover,
    #__ef_dialog__ .ef-destination-menu [role="option"]:focus-visible {
      background: var(--ef-hover-bg);
    }
    #__ef_dialog__ .ef-destination-menu [role="option"][aria-selected="true"]::after {
      content: "✓";
      color: var(--ef-primary);
      font-weight: 600;
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
      #__ef_dialog__ .ef-issue-foot { flex-wrap: wrap; row-gap: 8px; }
      #__ef_dialog__ .ef-issue-foot .ef-footer-spacer { display: none; }
      /* Primary action owns its own row on a phone. */
      #__ef_dialog__ .ef-issue-foot #__ef_issue_submit__ { flex: 1 0 100%; }
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
// True while an auth (login/grant) layer is shown. The pane's Tab trap stands
// down while the auth layer owns the keyboard.
let authLayerOpen = false;
// A layer above the card (the design gallery) that owns Tab while it is open.
let topLayerEl: HTMLElement | null = null;
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
    // The auth layer owns the keyboard while it is open.
    if (authLayerOpen) return;
    if (e.key !== "Tab") return;
    // A layer above the card (the gallery) traps Tab inside itself.
    const scope = topLayerEl && topLayerEl.isConnected ? topLayerEl : card;
    const items = getFocusable(scope);
    if (items.length === 0) { e.preventDefault(); scope.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === scope || !scope.contains(active)) {
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

export type { FeedbackType } from "./drafts";

/** Submitted feedback + open GitHub issues for the current page. */
export interface PageReports {
  comments: FeedbackComment[];
  issues: IssueBadge[];
}

export interface SubmitFeedbackOptions {
  selector: string;
  existingComments: FeedbackComment[];
  context: Record<string, unknown>;
  /**
   * Signed-in GitHub reporter, when there is one. Absent on hosts that only
   * offer the Session destination (order-box), which needs no GitHub login.
   */
  user?: { login: string; avatarUrl: string };
  defaultIssueTopic: string;
  repo: string;
  branch?: string;
  appVersion?: string;
  environment?: string;
  /** Public Memory destination probe for this repo (connected + mode). */
  memory?: MemoryStatus;
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
  /**
   * Stable page key used by the draft registry (matches the API's page URL
   * matching mode). Defaults to the current document href.
   */
  pageKey?: string;
  /** Submitted feedback + issues for the All reports list. */
  loadPageReports?: () => Promise<PageReports>;
  /** Re-bind the pane to another element after picking a report from the list. */
  onOpenReport?: (selector: string) => void;
  /** Submits a comment; resolves with the new feedback ID when known. */
  onSubmit: (comment: string, type: FeedbackType, intent: FeedbackIntent, memorySync?: boolean) => Promise<number | void>;
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
   * Called on every mode change: "submit" (report form, page is not pickable)
   * or "edit" (live style editor, page picking is active).
   */
  onEditingChange?: (view: "submit" | "edit") => void;
  /**
   * Opt-in Chat tab (report composer). Present only when the host sets
   * `data-chat`; the pane then shows Feedback · Changes · Chat.
   */
  chat?: { api: APIClient };
  /**
   * Session destination: the order-box-fronted coding-agent session this
   * report can be delivered into. Present only when the host sets both
   * `data-order-box` and `data-order-session`.
   */
  session?: { id: string };
  /**
   * Delivers the report into `session` (order-box). Called instead of
   * `onSubmit`/`onExport` when the Session destination is chosen; the message
   * carries the reporter's note plus the captured element, the edits they made
   * and the console errors.
   */
  onSendOrder?: (
    comment: string,
    type: FeedbackType,
    intent: FeedbackIntent,
    title: string
  ) => Promise<{ at: string; screenshot?: string; note?: string }>;
}

/** Default action verb for a feedback type (bug → fix, enhancement → change). */
function inferAction(type: FeedbackType): IntentAction {
  return type === "bug" ? "fix" : "change";
}

/** Shows the element feedback dialog: existing comments + compose area. */
export function showSubmitDialog(opts: SubmitFeedbackOptions): void {
  injectStyles();
  const dialog = getOrCreateDialog();

  // ── Pane + dock state (default docked; persisted across pages) ──────────────
  // One docked pane holds three tabs — Feedback (report form + live style
  // editor), Changes and (opt-in) Chat. Switching only flips attributes, so
  // typed text, chip state and live edits survive.
  let docked = readDockedPref();
  // True between clicking "Add element" in the undocked editor and the pick
  // finishing. The dialog hides itself (ef-modal-picking) and suspends its Tab
  // trap so the host page is clickable; the selection subscription restores it.
  let awaitingPick = false;
  // True once the report is deliberately discarded or submitted — the cleanup
  // hook must not re-persist a draft that no longer exists.
  let discarding = false;
  const DOCK_MAX = 400;
  const DOCK_MIN_WIDTH = 520;
  const dockWidth = () => Math.min(DOCK_MAX, window.innerWidth);
  /** Dock applies to the whole pane; below the breakpoint it becomes a sheet. */
  const effectiveDock = () => docked && window.innerWidth > DOCK_MIN_WIDTH;
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
  // Changes belonging to the live draft only. Committed edits from earlier
  // reports are the baseline and never ride along with this one.
  const allChanges = (): StyleChange[] => getChanges();

  // ── Draft identity ────────────────────────────────────────────────────────
  // Every open report is backed by a draft record. Reopening the same element
  // resumes its draft; otherwise a fresh record is created on first edit.
  const pageKey =
    opts.pageKey ?? (typeof window !== "undefined" ? window.location.href : "");
  migrateLegacyDrafts(pageKey, typeof window !== "undefined" ? [window.location.href] : []);

  const collectTargets = (): DraftRecord["targets"] =>
    currentTargets().map((t) => ({
      selector: t.selector,
      ...(t.dataComponent ? { dataComponent: t.dataComponent } : {}),
    }));

  const existingDraft = findDraftBySelector(pageKey, opts.selector);
  let draft: DraftRecord =
    existingDraft ??
    emptyDraft(pageKey, opts.selector, collectTargets(), opts.defaultIssueTopic);
  let draftStored = !!existingDraft;
  beginDraft(draft.id);

  // Re-select every element the draft touched. index.ts seeds the element that
  // was clicked; the rest of the multi-selection lives in the draft.
  if (existingDraft) {
    for (const t of existingDraft.targets) {
      if (t.selector === opts.selector) continue;
      if (currentTargets().some((x) => x.selector === t.selector)) continue;
      let targetEl: Element | null = null;
      try {
        targetEl = typeof document !== "undefined" ? document.querySelector(t.selector) : null;
      } catch {
        targetEl = null;
      }
      if (targetEl) addSelectionTarget(targetEl, t.selector, t.dataComponent);
    }
  }

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
  if (opts.environment) chips.push(`<span class="ef-target-chip"><span class="ef-target-chip-label">env</span>${escapeHtml(opts.environment)}</span>`);
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

  // Subtitle for the issue modal header: repo · element.
  // "ask" is the only mode where the reporter chooses. "auto" syncs server-side
  // without a control; "off"/absent shows nothing.
  const memoryAsk = !!opts.memory && opts.memory.connected && opts.memory.mode === "ask";

  // Session destination (`data-order-box` + `data-order-session`): the report
  // becomes one message in a coding-agent session instead of an issue.
  const sessionAsk = !!opts.session && !!opts.onSendOrder;
  const sessionShort = opts.session ? opts.session.id.slice(0, 8) : "";

  // The dropdown is the single choice for where the primary action sends the
  // report: GitHub (issue export), Memory (the connected destination) or a
  // Session (order-box). The last choice is remembered per browser; Memory is
  // only offered in Ask mode. With no signed-in reporter the Session is the
  // only destination that can be used without a login, so it is the default —
  // otherwise the primary button would read "Create issue" and hide the channel.
  const destinationFallback: ReportDestination =
    !opts.user && sessionAsk ? "session" : "github";
  let destination: ReportDestination = readDestinationPref(
    memoryAsk,
    sessionAsk,
    destinationFallback
  );
  const destinationLabel = (value: ReportDestination): string => {
    if (value === "memory") return "Memory";
    if (value === "session") return `Session ${sessionShort}`;
    return "GitHub";
  };
  const primaryLabel = (): string => {
    if (destination === "memory") return "Send to Memory";
    if (destination === "session") return "Send to session";
    return "Create issue";
  };

  // The Chat tab is opt-in per host (`data-chat`). Without it the pane keeps the
  // two tabs it always had: Feedback and Changes.
  const chatEnabled = !!opts.chat;
  const tabsHTML = `
    <button class="ef-tab" id="__ef_tab_feedback__" role="tab" data-tab="feedback" aria-selected="true" aria-controls="__ef_panel_feedback__" tabindex="0">Feedback${existing.length > 0 ? `<span class="ef-tab-count" title="${existing.length} existing comment${existing.length === 1 ? "" : "s"}">${existing.length}</span>` : ""}</button>
    <button class="ef-tab" id="__ef_tab_edit__" role="tab" data-tab="edit" aria-selected="false" aria-controls="__ef_panel_edit__" tabindex="-1" aria-label="Edit element styles" title="Edit element styles">Edit</button>
    <button class="ef-tab" id="__ef_tab_changes__" role="tab" data-tab="changes" aria-selected="false" aria-controls="__ef_panel_changes__" tabindex="-1">Changes<span class="ef-tab-count" id="__ef_count_changes__" hidden></span></button>
    ${chatEnabled ? `<button class="ef-tab" id="__ef_tab_chat__" role="tab" data-tab="chat" aria-selected="false" aria-controls="__ef_panel_chat__" tabindex="-1">Chat</button>` : ""}`;

  dialog.innerHTML = `
    <div class="ef-card" role="dialog" aria-modal="true" aria-labelledby="__ef_title__" tabindex="-1">
      <div class="ef-header">
        <div class="ef-header-crumb" id="__ef_header_crumb__">
          <button type="button" class="ef-crumbs" id="__ef_all_reports__">← All reports</button>
        </div>
        <div class="ef-header-top">
          <h2 id="__ef_title__">${title}</h2>
          <span class="ef-change-chip" id="__ef_change_count__" hidden></span>
          ${opts.user
            ? `<div class="ef-user-pill">
            <img src="${escapeHtml(opts.user.avatarUrl)}" alt="">
            <span>${escapeHtml(opts.user.login)}</span>
          </div>`
            : ""}
          <button class="ef-dock-btn" id="__ef_dock__" type="button" title="Dock to the side" aria-label="Dock to the side"></button>
        </div>
      </div>
      <div class="ef-tabs" role="tablist" aria-label="Overlay views">${tabsHTML}</div>
      <div class="ef-panels">
        <section class="ef-panel" id="__ef_panel_feedback__" role="tabpanel" aria-labelledby="__ef_tab_feedback__">
          <div class="ef-report" id="__ef_report__">
            <div class="ef-issue-body">
              <div class="ef-issue-section">
                ${commentsHTML}
                <div class="ef-topic-row">
                  <label class="ef-topic-label" for="__ef_topic__">Report title</label>
                  <input class="ef-topic-input" id="__ef_topic__" type="text" value="${escapeHtml(opts.defaultIssueTopic)}">
                </div>
                <div class="ef-type-toggle">
                  <input type="radio" name="__ef_type__" id="__ef_type_bug__" value="bug">
                  <label for="__ef_type_bug__">🐛 Bug</label>
                  <input type="radio" name="__ef_type__" id="__ef_type_enh__" value="enhancement" checked>
                  <label for="__ef_type_enh__">✨ Enhancement</label>
                </div>
                <div class="ef-variant-chip" id="__ef_variant_chip__" hidden>
                  <span class="ef-variant-chip-label">Design</span>
                  <span class="ef-variant-chip-name" id="__ef_variant_name__"></span>
                  <div class="ef-variant-chip-actions">
                    <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_variant_view__">View</button>
                    <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_variant_clear__">Remove</button>
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
              <div class="ef-footer-spacer"></div>
              <button type="button" class="ef-btn-secondary" id="__ef_submit__"${opts.user || !sessionAsk ? "" : " hidden"}>Save</button>
              <div class="ef-destination" id="__ef_destination__" ${memoryAsk || sessionAsk ? "" : "hidden"}>
                <button type="button" class="ef-btn-secondary ef-destination-trigger" id="__ef_destination_trigger__" aria-haspopup="listbox" aria-expanded="false" aria-label="Report destination">
                  <span class="ef-destination-value">${destinationLabel(destination)}</span>
                  <span class="ef-destination-caret" aria-hidden="true">▾</span>
                </button>
                <ul class="ef-destination-menu" id="__ef_destination_menu__" role="listbox" aria-label="Report destination" hidden>
                  <li role="option" data-destination="github" aria-selected="${destination === "github"}" tabindex="-1">GitHub</li>
                  ${memoryAsk ? `<li role="option" data-destination="memory" aria-selected="${destination === "memory"}" tabindex="-1">Memory</li>` : ""}
                  ${sessionAsk ? `<li role="option" data-destination="session" aria-selected="${destination === "session"}" tabindex="-1" title="Deliver this report to session ${escapeHtml(opts.session!.id)}">Session ${escapeHtml(sessionShort)}</li>` : ""}
                </ul>
              </div>
              <button type="button" class="ef-btn-primary" id="__ef_issue_submit__">${primaryLabel()}</button>
            </div>
          </div>
        </section>
        <section class="ef-panel" id="__ef_panel_edit__" role="tabpanel" aria-labelledby="__ef_tab_edit__" hidden>
          <div class="ef-design" id="__ef_design__">
            ${componentPickerHTML}
            ${targetStripHTML}
            <div class="ef-body">
              <div class="ef-targets" id="__ef_targets__"></div>
              <div class="ef-design-body">
                <div id="__ef_style_editor__"></div>
              </div>
            </div>
            <div class="ef-footer">
              <button type="button" class="ef-btn-secondary" id="__ef_discard_draft__" title="Delete this draft and revert its live edits">Discard draft</button>
              <div class="ef-footer-spacer"></div>
            </div>
          </div>
        </section>
        <section class="ef-panel" id="__ef_panel_changes__" role="tabpanel" aria-labelledby="__ef_tab_changes__" hidden>
          <div class="ef-changes" id="__ef_changes__"></div>
        </section>
        ${chatEnabled
          ? `<section class="ef-panel" id="__ef_panel_chat__" role="tabpanel" aria-labelledby="__ef_tab_chat__" hidden>
               <div class="ef-chat" id="__ef_chat__"></div>
             </section>`
          : ""}
      </div>
      <div class="ef-reports" id="__ef_reports__" role="region" aria-label="All reports on this page" hidden></div>
    </div>
  `;

  const card = dialog.querySelector<HTMLElement>(".ef-card")!;
  // Remember where the reporter came from so closeDialog() restores focus.
  // (Tab/panel swaps pass preserveFocusReturn so they never overwrite this.)
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
  const errDiv = dialog.querySelector<HTMLElement>("#__ef_err__")!;

  // ── One pane, four panels; only attributes/hidden states swap ──────────────
  const issueCancelBtn = dialog.querySelector<HTMLButtonElement>("#__ef_issue_cancel__")!;
  const issueSubmitBtn = dialog.querySelector<HTMLButtonElement>("#__ef_issue_submit__")!;
  const destinationWrap = dialog.querySelector<HTMLElement>("#__ef_destination__");
  const destinationTrigger = dialog.querySelector<HTMLButtonElement>("#__ef_destination_trigger__");
  const destinationMenu = dialog.querySelector<HTMLUListElement>("#__ef_destination_menu__");
  const destinationValue = dialog.querySelector<HTMLElement>(".ef-destination-value");

  const closeDestinationMenu = (focusTrigger = false): void => {
    if (!destinationMenu || !destinationTrigger || destinationMenu.hidden) return;
    destinationMenu.hidden = true;
    destinationTrigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) destinationTrigger.focus();
  };

  const destinationOptions = (): HTMLElement[] =>
    destinationMenu
      ? Array.from(destinationMenu.querySelectorAll<HTMLElement>('[role="option"]'))
      : [];

  const openDestinationMenu = (focus: "selected" | "first" | "last" = "selected"): void => {
    if (!destinationMenu || !destinationTrigger) return;
    destinationMenu.hidden = false;
    destinationTrigger.setAttribute("aria-expanded", "true");
    const options = destinationOptions();
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true");
    const target = focus === "last"
      ? options[options.length - 1]
      : focus === "first"
        ? options[0]
        : selected ?? options[0];
    target?.focus();
  };

  const setDestination = (next: ReportDestination): void => {
    // The primary action is in flight; keep its destination stable.
    if (issueSubmitBtn.disabled) return;
    destination = next;
    writeDestinationPref(destination);
    if (destinationValue) destinationValue.textContent = destinationLabel(destination);
    for (const option of destinationOptions()) {
      option.setAttribute("aria-selected", option.dataset.destination === destination ? "true" : "false");
    }
    issueSubmitBtn.textContent = primaryLabel();
    closeDestinationMenu(true);
  };

  if (destinationWrap && destinationTrigger && destinationMenu) {
    destinationTrigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (destinationMenu.hidden) openDestinationMenu("selected");
      else closeDestinationMenu(true);
    });
    destinationTrigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openDestinationMenu(event.key === "ArrowUp" ? "last" : "selected");
      }
    });
    destinationMenu.addEventListener("click", (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
      if (!option || !destinationMenu.contains(option)) return;
      const next = option.dataset.destination;
      if (isReportDestination(next)) setDestination(next);
    });
    destinationMenu.addEventListener("keydown", (event) => {
      const options = destinationOptions();
      const current = options.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!options.length) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        options[(current + delta + options.length) % options.length].focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        if (!active || active.getAttribute("role") !== "option") return;
        const next = active.dataset.destination;
        if (isReportDestination(next)) setDestination(next);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeDestinationMenu(true);
      } else if (event.key === "Tab") {
        closeDestinationMenu(false);
      }
    });
    dialog.addEventListener("click", (event) => {
      if (!destinationMenu.hidden && !destinationWrap.contains(event.target as Node)) {
        closeDestinationMenu(false);
      }
    });
  }

  const changeChip = dialog.querySelector<HTMLElement>("#__ef_change_count__")!;
  const discardBtn = dialog.querySelector<HTMLButtonElement>("#__ef_discard_draft__")!;

  type TabKey = "feedback" | "edit" | "changes" | "chat";
  let tab: TabKey = "feedback";
  type ViewKey = "report" | "reports";
  let view: ViewKey = "report";

  const tabsEl = dialog.querySelector<HTMLElement>(".ef-tabs")!;
  const panelsEl = dialog.querySelector<HTMLElement>(".ef-panels")!;
  const reportsEl = dialog.querySelector<HTMLElement>("#__ef_reports__")!;
  const backToReportsBtn = dialog.querySelector<HTMLButtonElement>("#__ef_all_reports__")!;
  const crumbRow = dialog.querySelector<HTMLElement>("#__ef_header_crumb__")!;
  const titleEl = dialog.querySelector<HTMLElement>("#__ef_title__")!;

  const tabButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".ef-tab"));
  const panelFor = (key: TabKey): HTMLElement | null =>
    dialog.querySelector<HTMLElement>(`#__ef_panel_${key}__`);

  /** Live count of style edits that will ride along with this report. */
  const renderChangeCount = (): void => {
    const n = allChanges().length;
    const label = n === 1 ? "1 style change" : `${n} style changes`;
    changeChip.textContent = n === 0 ? "" : label;
    changeChip.hidden = n === 0;
    changeChip.title = n === 0 ? "" : `${label} included with this report`;

    // The Changes tab carries the same count as a badge.
    const badge = dialog.querySelector<HTMLElement>("#__ef_count_changes__");
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
  };

  /** Filled in once the chat panel mounts (it needs the live change list). */
  let refreshChat = (): void => {};

  /**
   * Switch the visible tab. Panels stay mounted, so typed text, chip state and
   * live style edits survive a switch in either direction.
   */
  const setTab = (next: TabKey): void => {
    if (tab === next) return;
    tab = next;
    dialog.dataset.tab = next;
    for (const btn of tabButtons) {
      const on = btn.dataset.tab === next;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
    }
    for (const btn of tabButtons) {
      const panel = panelFor(btn.dataset.tab as TabKey);
      if (panel) panel.hidden = btn.dataset.tab !== next;
    }
    if (next === "chat") refreshChat();
    if (next === "edit") {
      // Entering the editor must show the live target set and selector.
      renderSelection();
    } else if (isPickMode()) {
      setPickMode(false);
    }
    // Page picking follows the Edit tab: reviewing changes or talking to the
    // agent must not add elements when the reporter clicks the page.
    opts.onEditingChange?.(next === "edit" ? "edit" : "submit");
  };

  // ── Page-level report registry (master list) ────────────────────────────────
  let pageReports: PageReports | null = null;
  let pageReportsError = false;
  let reportsLoading = false;
  let reportsArmed: string | null = null;
  let reportsArmTimer: number | null = null;
  /** Hide submitted reports whose linked GitHub issue is closed. */
  let hideClosedReports = false;

  const relativeTime = (ts: number): string => {
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };

  /** Format a server timestamp as relative time, falling back to raw text. */
  const timeAgo = (iso: string | undefined): string => {
    if (!iso) return "";
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? iso : relativeTime(ts);
  };

  const issueStateOf = (value: string | undefined): "open" | "closed" | "" => {
    const s = (value ?? "").toLowerCase();
    return s === "open" || s === "closed" ? s : "";
  };

  const draftHeadline = (d: DraftRecord): string => {
    const line = d.comment.split("\n").map((l) => l.trim()).find(Boolean);
    return line || d.title.trim() || "Untitled draft";
  };

  const elementExists = (selector: string): boolean => {
    try {
      return typeof document !== "undefined" && !!document.querySelector(selector);
    } catch {
      return false;
    }
  };

  const draftRowsHTML = (drafts: DraftRecord[]): string => {
    if (drafts.length === 0) {
      return `<div class="ef-reports-empty">No drafts in progress.</div>`;
    }
    return `<ul class="ef-report-list">
      ${drafts.map((d) => {
        const changes = getDraftChangeCount(d.id);
        const found = elementExists(d.selector);
        const meta = [
          d.type === "bug" ? "🐛 Bug" : "✨ Enhancement",
          `${d.targets.length} element${d.targets.length === 1 ? "" : "s"}`,
          `${changes} change${changes === 1 ? "" : "s"}`,
          relativeTime(d.updatedAt),
        ];
        if (!found) meta.push("element not found");
        return `<li class="ef-report-item" data-kind="draft">
          <button type="button" class="ef-report-main" data-resume="${escapeHtml(d.id)}" ${found ? "" : "disabled"} title="${escapeHtml(d.selector)}">
            <span class="ef-report-title">${escapeHtml(draftHeadline(d))}</span>
            <span class="ef-report-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("")}</span>
            <span class="ef-report-sel">${escapeHtml(d.selector)}</span>
          </button>
          <button type="button" class="ef-report-cancel" data-cancel="${escapeHtml(d.id)}" ${reportsArmed === d.id ? 'data-confirm="true"' : ""} aria-label="${reportsArmed === d.id ? "Confirm delete draft" : "Delete draft"}">${reportsArmed === d.id ? "Confirm" : "Cancel"}</button>
        </li>`;
      }).join("")}
    </ul>`;
  };

  const issueStateBadgeHTML = (state: string | undefined): string => {
    const s = issueStateOf(state);
    if (!s) return "";
    return `<span class="ef-report-state" data-state="${s}">${s === "open" ? "Open" : "Closed"}</span>`;
  };

  const submittedRowsHTML = (): string => {
    if (opts.loadPageReports && pageReports === null) {
      return `<div class="ef-reports-empty">${pageReportsError ? "Could not load submitted reports." : "Loading submitted reports…"}</div>`;
    }
    if (!pageReports) return "";
    const { comments, issues } = pageReports;
    if (comments.length === 0 && issues.length === 0) {
      return `<div class="ef-reports-empty">Nothing submitted on this page yet.</div>`;
    }
    const rows: string[] = [];
    for (const c of comments) {
      const issue = issues.find((i) => i.selector === c.selector);
      const state = issueStateOf(c.issue_state ?? issue?.state);
      // "Hide closed" drops reports whose GitHub issue is already done.
      if (hideClosedReports && state === "closed") continue;
      const status = c.status && c.status !== "open"
        ? `<span class="ef-report-status">${escapeHtml(c.status)}</span>`
        : "";
      const issueNumber = c.issue_number ?? issue?.issue_number;
      const issueLink = (c.issue_url || issue?.issue_url)
        ? `<a class="ef-report-issue" href="${escapeHtml(c.issue_url ?? issue!.issue_url)}" target="_blank" rel="noopener noreferrer">Issue${issueNumber ? ` #${issueNumber}` : ""}</a>`
        : "";
      const excerpt = c.comment.length > 140 ? `${c.comment.slice(0, 137)}…` : c.comment;
      rows.push(`<li class="ef-report-item" data-kind="submitted">
        <button type="button" class="ef-report-main" data-open="${escapeHtml(c.selector)}" title="${escapeHtml(c.selector)}">
          <span class="ef-report-title">${escapeHtml(excerpt)}</span>
          <span class="ef-report-meta">
            <span>@${escapeHtml(c.github_user)}</span>
            <span title="${escapeHtml(c.created_at)}">${escapeHtml(timeAgo(c.created_at))}</span>
            ${issueStateBadgeHTML(state)}
            ${status}
            ${issueLink}
          </span>
          <span class="ef-report-sel">${escapeHtml(c.selector)}</span>
        </button>
      </li>`);
    }
    // Issues that exist without a matching feedback row still deserve a line.
    for (const i of issues) {
      if (comments.some((c) => c.selector === i.selector)) continue;
      rows.push(`<li class="ef-report-item" data-kind="submitted">
        <button type="button" class="ef-report-main" data-open="${escapeHtml(i.selector)}" title="${escapeHtml(i.selector)}">
          <span class="ef-report-title">${escapeHtml(i.title)}</span>
          <span class="ef-report-meta">
            <span title="${escapeHtml(i.created_at ?? "")}">${escapeHtml(timeAgo(i.created_at))}</span>
            ${issueStateBadgeHTML(i.state ?? "open")}
            <a class="ef-report-issue" href="${escapeHtml(i.issue_url)}" target="_blank" rel="noopener noreferrer">#${i.issue_number}</a>
          </span>
          <span class="ef-report-sel">${escapeHtml(i.selector)}</span>
        </button>
      </li>`);
    }
    if (rows.length === 0) {
      return `<div class="ef-reports-empty">No submitted reports match this filter.</div>`;
    }
    return `<ul class="ef-report-list">${rows.join("")}</ul>`;
  };

  const bindReports = (drafts: DraftRecord[]): void => {
    reportsEl.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.resume ?? "";
        const target = drafts.find((d) => d.id === id);
        if (!target) return;
        if (!opts.onOpenReport) return;
        opts.onOpenReport(target.selector);
      });
    });
    reportsEl.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.cancel ?? "";
        if (reportsArmed !== id) {
          reportsArmed = id;
          renderReports();
          if (reportsArmTimer !== null) window.clearTimeout(reportsArmTimer);
          reportsArmTimer = window.setTimeout(() => {
            reportsArmTimer = null;
            if (reportsArmed === id) {
              reportsArmed = null;
              renderReports();
            }
          }, 4000);
          return;
        }
        if (reportsArmTimer !== null) {
          window.clearTimeout(reportsArmTimer);
          reportsArmTimer = null;
        }
        reportsArmed = null;
        deleteDraft(pageKey, id);
        discardDraft(id);
        renderReports();
      });
    });
    reportsEl.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const selector = btn.dataset.open ?? "";
        opts.onOpenReport?.(selector);
      });
    });
    reportsEl.querySelector<HTMLInputElement>("#__ef_hide_closed__")?.addEventListener("change", (event) => {
      hideClosedReports = (event.target as HTMLInputElement).checked;
      renderReports();
    });
    reportsEl.querySelector<HTMLButtonElement>("#__ef_clear_applied__")?.addEventListener("click", () => {
      clearCommitted();
      renderReports();
    });
    reportsEl.querySelector<HTMLButtonElement>("#__ef_reports_close__")?.addEventListener("click", () => {
      closeDialog();
      opts.onCancel();
    });
  };

  const renderReports = (): void => {
    if (view !== "reports") return;
    if (reportsArmed && !listDrafts(pageKey).some((d) => d.id === reportsArmed)) {
      reportsArmed = null;
    }
    const drafts = listDrafts(pageKey);
    const committed = getCommittedEntries();
    reportsEl.innerHTML = `
      <div class="ef-reports-body">
        <section>
          <div class="ef-changes-head">
            <div class="ef-section-label">In progress (${drafts.length})</div>
          </div>
          ${draftRowsHTML(drafts)}
        </section>
        <section>
          <div class="ef-changes-head">
            <div class="ef-section-label">Submitted</div>
            <label class="ef-filter-toggle" title="Hide reports whose GitHub issue is closed">
              <input type="checkbox" id="__ef_hide_closed__"${hideClosedReports ? " checked" : ""} />
              Hide closed
            </label>
          </div>
          ${submittedRowsHTML()}
        </section>
      </div>
      <div class="ef-reports-foot">
        ${committed.length > 0
          ? `<button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_clear_applied__">Clear applied changes (${committed.length})</button>
             <span class="ef-hint">Committed style edits from earlier reports</span>`
          : ""}
        <div class="ef-footer-spacer"></div>
        <button type="button" class="ef-btn-secondary" id="__ef_reports_close__">Close</button>
      </div>`;
    bindReports(drafts);

    if (opts.loadPageReports && pageReports === null && !reportsLoading) {
      reportsLoading = true;
      void opts.loadPageReports()
        .then((r) => { pageReports = r; })
        .catch(() => { pageReportsError = true; })
        .finally(() => {
          reportsLoading = false;
          if (view === "reports") renderReports();
        });
    }
  };

  /** Suspend the live draft: persist text + edits, revert the page to baseline. */
  const suspendActiveDraft = (): void => {
    if (draftTimer !== null) { window.clearTimeout(draftTimer); draftTimer = null; }
    syncDraft();
    if (isPickMode()) setPickMode(false);
    suspendDraft();
  };

  const setView = (next: ViewKey): void => {
    view = next;
    dialog.dataset.view = next;
    const listing = next === "reports";
    crumbRow.hidden = listing;
    tabsEl.hidden = listing;
    panelsEl.hidden = listing;
    reportsEl.hidden = !listing;
    titleEl.textContent = listing ? "All reports" : title;
    if (listing) {
      suspendActiveDraft();
      // Reset tab state without firing another mode change.
      tab = "feedback";
      dialog.dataset.tab = "feedback";
      for (const btn of tabButtons) {
        const on = btn.dataset.tab === "feedback";
        btn.setAttribute("aria-selected", on ? "true" : "false");
        btn.tabIndex = on ? 0 : -1;
      }
      for (const btn of tabButtons) {
        const panel = panelFor(btn.dataset.tab as TabKey);
        if (panel) panel.hidden = btn.dataset.tab !== "feedback";
      }
      opts.onEditingChange?.("submit");
      renderReports();
    } else {
      reportsArmed = null;
      if (tab === "edit") opts.onEditingChange?.("edit");
    }
  };

  backToReportsBtn.addEventListener("click", () => setView("reports"));

  // Tab bar: click + roving-tabindex arrow keys.
  tabButtons.forEach((btn) => {
    // Keep focus on the tab: moving it into the panel would fire the target
    // label's focus handler and leave a permanent outline over the page.
    btn.addEventListener("click", () => setTab(btn.dataset.tab as TabKey));
    btn.addEventListener("keydown", (e) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const idx = tabButtons.indexOf(btn);
      let nextIdx = idx;
      if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
      else if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabButtons.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabButtons.length - 1;
      const target = tabButtons[nextIdx];
      setTab(target.dataset.tab as TabKey);
      target.focus();
    });
  });

  /**
   * Cancel the whole report: drop the draft record, revert its live edits and
   * close. Committed edits from earlier reports stay on the page.
   */
  const cancelReport = (): void => {
    if (draftTimer !== null) { window.clearTimeout(draftTimer); draftTimer = null; }
    discarding = true;
    deleteDraft(pageKey, draft.id);
    discardDraft(draft.id);
    removeKey();
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
  // The draft record is created lazily on the first meaningful edit, so merely
  // reading comments never litters the All reports list. Once stored, text and
  // targets are updated on a short debounce.
  const topicInput = dialog.querySelector<HTMLInputElement>("#__ef_topic__");
  let draftTimer: number | null = null;
  // Comment text that was already POSTed by the create-issue flow. Kept across
  // an export failure so clicking "Create issue" again exports the same item
  // instead of creating a duplicate comment. Cleared when the text changes.
  let submittedComment: string | null = null;
  let submittedId: number | null = null;

  const draftSnapshot = (): DraftRecord => ({
    ...draft,
    targets: collectTargets(),
    comment: textarea.value,
    title: topicInput?.value ?? draft.title,
    type: getType(),
  });

  /** Store the draft now (first edit / style change). */
  const promoteDraft = (): void => {
    if (draftStored) return;
    draft = draftSnapshot();
    saveDraft(draft);
    draftStored = true;
  };

  /** Push the current form state into the stored draft. */
  const syncDraft = (): void => {
    if (!draftStored) return;
    draft = draftSnapshot();
    updateDraft(pageKey, draft.id, {
      comment: draft.comment,
      title: draft.title,
      type: draft.type,
      targets: draft.targets,
      selector: draft.selector,
    });
  };

  const scheduleDraftSave = (): void => {
    promoteDraft();
    if (draftTimer !== null) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      draftTimer = null;
      syncDraft();
    }, 300);
  };

  const restoreDraft = (): void => {
    if (draft.comment) textarea.value = draft.comment;
    if (draft.title && topicInput) topicInput.value = draft.title;
    if (draft.type === "bug") {
      const radio = dialog.querySelector<HTMLInputElement>(
        `input[name='__ef_type__'][value='bug']`
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
    // Only the live draft's edits are shown. Committed (baseline) edits from
    // earlier reports are managed from the All reports list.
    const changes = getChanges();
    const count = changes.length;

    const list =
      count === 0
        ? `<div class="ef-changes-empty">No changes in this draft yet.</div>`
        : `<ul class="ef-changes-list">
            ${changes.map((c) => {
              const groupLabel = c.move != null ? "Position" : c.group === "text" ? "Text" : c.group;
              return `<li><span class="ef-change-group">${escapeHtml(groupLabel)}</span><span class="ef-change-before">${escapeHtml(c.before || "—")}</span><span class="ef-arrow">→</span><span class="ef-change-after">${escapeHtml(c.after)}</span></li>`;
            }).join("")}
          </ul>`;

    changesHost.innerHTML = `
      <div class="ef-changes-block">
        <div class="ef-changes-head">
          <div class="ef-section-label">This draft (${count})</div>
          <div class="ef-changes-actions">
            <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_revert_pending__"${count === 0 ? " disabled" : ""}>Revert all</button>
          </div>
        </div>
        ${list}
        <div class="ef-hint">Saving or creating the issue commits these edits. Leaving the draft reverts the page until you reopen it.</div>
      </div>`;

    changesHost.querySelector<HTMLButtonElement>("#__ef_revert_pending__")?.addEventListener("click", () => {
      revertPending();
      renderSelection();
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
    bodyEl.scrollTop = bodyScroll;
  };

  /**
   * Default verb: a recorded move wins over the type-derived default, so a
   * report that is (mostly) a reorder reads as a move.
   */
  const defaultAction = (): IntentAction =>
    getChanges().some((c) => c.move != null) ? "move" : inferAction(getType());

  let action: IntentAction = defaultAction();
  // Chat can propose an action; a later selection-driven move must not clobber it.
  let actionFromChat = false;
  // Expected/actual have no free-text fields in the form. A chat proposal may
  // supply them, and they ride along in the intent when it does.
  let expected = "";
  let agentActual = "";

  // A move recorded while the pane is open re-seeds the verb.
  const unsubActionSeed = onSelectionChange(() => {
    if (actionFromChat) return;
    action = defaultAction();
  });

  dialog.querySelectorAll<HTMLInputElement>("input[name='__ef_type__']").forEach((inp) => {
    inp.addEventListener("change", () => {
      action = inferAction(getType());
      actionFromChat = false;
      scheduleDraftSave();
    });
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
      actual: agentActual.trim() || undefined,
      scope: {
        // Multi-target editing is a genuine multi selection.
        breadth: targetSelectors.length > 1 ? "multi" : "element",
        targets: targetSelectors,
      },
    };
    if (changes.length > 0) intent.changes = changes;
    // A picked design travels as evidence with the report. It is not applied to
    // the page and never becomes a repository change.
    const pick = pickedVariant(chatTurns);
    if (pick) {
      const design = buildDesignAttachment(pick.gallery, pick.variant.id);
      if (design) intent.design = design;
    }
    return intent;
  };

  /**
   * Comment text for the legacy explanation field. Falls back to the chat
   * proposal's expected sentence and/or the applied live edits so a
   * change-only report still satisfies the server's non-empty comment contract.
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

  // ── Chat tab (opt-in): a report composer, not an editor ────────────────────
  // The agent fills the same fields the form already has. It never touches the
  // page: this module's edit primitives (applyTokenToTarget, setTextForTarget,
  // commitChanges) are not reachable from here, and the transcript is local.

  /** Selector whose transcript this pane is showing. */
  const chatKey = (): string => currentTargets()[0]?.selector ?? opts.selector;
  let chatTurns: ChatTurn[] = [];
  let chatLoadedFor = "";
  let chatPanel: ChatPanel | null = null;
  let chatLastCount = -1;

  /** Redacted, field-level context sent with each turn. */
  const chatContext = (): Record<string, unknown> => {
    const t = currentTargets()[0];
    const el: Element | null = t?.el ?? null;
    const computed: Record<string, string> = {};
    if (el) {
      const cs = getComputedStyle(el);
      for (const key of [
        "display",
        "position",
        "color",
        "backgroundColor",
        "fontSize",
        "fontWeight",
        "padding",
        "margin",
        "borderRadius",
      ]) {
        const css = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        const v = cs.getPropertyValue(css);
        if (v) computed[key] = v;
      }
    }
    const raw = (opts.context ?? {}) as Record<string, unknown>;
    const src = raw.source as Record<string, unknown> | undefined;
    const pick = pickedVariant(chatTurns);
    return buildChatContext({
      selector: t?.selector ?? opts.selector,
      url: typeof raw.url === "string" ? raw.url : window.location.href,
      tagName: el?.tagName,
      dataComponent:
        el?.closest("[data-component]")?.getAttribute("data-component") ?? undefined,
      source: src
        ? {
            file: typeof src.file === "string" ? src.file : undefined,
            line: typeof src.line === "number" ? src.line : undefined,
            component: typeof src.component === "string" ? src.component : undefined,
            confidence: typeof src.confidence === "string" ? src.confidence : undefined,
          }
        : undefined,
      computedStyles: computed,
      changes: (t ? getChangesFor(t.el) : []).map((c) => ({
        group: c.group,
        before: c.before,
        after: c.after,
      })),
      targetCount: currentTargets().length,
      ...(pick ? { selectedVariant: variantRef(pick.variant) } : {}),
    });
  };

  /**
   * Apply a validated proposal to the form and return the reporter to it.
   * Nothing is submitted: the reporter reviews, edits and presses Save or
   * Create issue themselves.
   */
  const applyReport = (r: ReportSuggestion): void => {
    setTab("feedback");

    const radio = dialog.querySelector<HTMLInputElement>(
      `input[name="__ef_type__"][value="${r.type}"]`
    );
    if (radio) radio.checked = true;

    action = r.action;
    actionFromChat = true;

    if (r.expected !== undefined) expected = r.expected;
    agentActual = r.actual ?? "";
    if (r.comment !== undefined) textarea.value = r.comment;
    if (r.title !== undefined && topicInput) topicInput.value = r.title;
    // Scope is derived from the live target selection on submit.

    errDiv.textContent = "";
    scheduleDraftSave();
    showToast("Report filled from chat");
    textarea.focus();
  };

  // ── Design gallery ─────────────────────────────────────────────────────────
  // The agent proposes variants; the reporter previews them in script-free
  // iframes and picks one. The pick is evidence attached to the report — it is
  // never applied to the page.
  const variantChip = dialog.querySelector<HTMLElement>("#__ef_variant_chip__");
  const variantName = dialog.querySelector<HTMLElement>("#__ef_variant_name__");
  let galleryLayer: HTMLElement | null = null;
  let galleryOpener: HTMLElement | null = null;

  const refreshVariantChip = (): void => {
    if (!variantChip || !variantName) return;
    const pick = pickedVariant(chatTurns);
    if (!pick) {
      variantChip.hidden = true;
      variantName.textContent = "";
      variantName.removeAttribute("title");
      return;
    }
    variantChip.hidden = false;
    variantName.textContent = pick.variant.label;
    variantName.title = pick.variant.notes ?? pick.variant.label;
  };

  const closeGallery = (): void => {
    if (!galleryLayer) return;
    topLayerEl = null;
    galleryLayer.remove();
    galleryLayer = null;
    // Return focus to whatever opened the layer, if it is still in the DOM.
    if (galleryOpener?.isConnected) galleryOpener.focus();
    galleryOpener = null;
  };

  variantChip?.querySelector("#__ef_variant_view__")?.addEventListener("click", () => {
    const pick = pickedVariant(chatTurns);
    if (!pick) return;
    setTab("chat");
    openGallery(pick.turnIndex);
  });
  variantChip?.querySelector("#__ef_variant_clear__")?.addEventListener("click", () => {
    const pick = pickedVariant(chatTurns);
    if (!pick) return;
    setPick(pick.turnIndex, null);
  });

  /** Repaint the chip, the chat card and (when open) the modal tiles. */
  const paintPick = (turnIndex: number): void => {
    refreshVariantChip();
    chatPanel?.render();
    if (!galleryLayer) return;
    const picked = chatTurns[turnIndex]?.picked;
    galleryLayer.querySelectorAll<HTMLElement>(".ef-gallery-tile").forEach((tile) => {
      const on = tile.dataset.variant === picked;
      tile.classList.toggle("is-picked", on);
      const pickBtn = tile.querySelector<HTMLButtonElement>("[data-pick]");
      if (pickBtn) pickBtn.textContent = on ? "Chosen" : "Use this";
      const head = tile.querySelector<HTMLElement>(".ef-gallery-tile-head");
      const badge = head?.querySelector<HTMLElement>(".ef-gallery-option-badge");
      if (on && head && !badge) {
        head.insertAdjacentHTML("beforeend", '<span class="ef-gallery-option-badge">Chosen</span>');
      } else if (!on && badge) {
        badge.remove();
      }
    });
  };

  const setPick = (turnIndex: number, variantId: string | null): void => {
    chatTurns = withPick(chatTurns, turnIndex, variantId);
    saveChat(chatLoadedFor, chatTurns);
    paintPick(turnIndex);
  };

  const openGallery = (turnIndex: number): void => {
    const turn = chatTurns[turnIndex];
    const gallery = turn?.gallery;
    if (!gallery || !turn) return;
    closeGallery();

    const host = collectHostStyles(document);
    const picked = turn.picked;
    galleryOpener = document.activeElement as HTMLElement | null;

    const layer = document.createElement("div");
    layer.className = "ef-gallery-layer";
    layer.innerHTML = `
      <div class="ef-gallery-modal" role="dialog" aria-modal="true" aria-label="Design options">
        <header class="ef-gallery-head">
          <div>
            <p class="ef-gallery-eyebrow">Design options</p>
            <h3 class="ef-gallery-title">${escapeHtml(gallery.title ?? "Pick the layout you want")}</h3>
          </div>
          <div class="ef-gallery-head-actions">
            <div class="ef-gallery-size" role="group" aria-label="Preview width">
              <button type="button" class="ef-gallery-size-btn" data-gallery-width="desktop" aria-pressed="true">Desktop</button>
              <button type="button" class="ef-gallery-size-btn" data-gallery-width="mobile" aria-pressed="false">390 px</button>
            </div>
            <button type="button" class="ef-gallery-close" data-gallery-close aria-label="Close gallery">✕</button>
          </div>
        </header>
        <div class="ef-gallery-grid" data-width="desktop">
          ${gallery.variants
            .map(
              (v) => `
            <article class="ef-gallery-tile${v.id === picked ? " is-picked" : ""}" data-variant="${escapeHtml(v.id)}">
              <div class="ef-gallery-frame"></div>
              <div class="ef-gallery-tile-body">
                <div class="ef-gallery-tile-head">
                  <h4>${escapeHtml(v.label)}</h4>
                  ${v.id === picked ? '<span class="ef-gallery-option-badge">Chosen</span>' : ""}
                </div>
                ${v.notes ? `<p class="ef-gallery-tile-notes">${escapeHtml(v.notes)}</p>` : ""}
                <div class="ef-gallery-tile-actions">
                  <button type="button" class="ef-btn-primary ef-btn-sm" data-pick="${escapeHtml(v.id)}">${v.id === picked ? "Chosen" : "Use this"}</button>
                  <button type="button" class="ef-btn-secondary ef-btn-sm" data-zoom="${escapeHtml(v.id)}">Expand</button>
                </div>
              </div>
            </article>`
            )
            .join("")}
        </div>
        <footer class="ef-gallery-foot">
          <p class="ef-gallery-note">Preview only — the page has not changed. Your pick is attached to the report as evidence.</p>
          <div class="ef-gallery-foot-spacer"></div>
          <button type="button" class="ef-btn-secondary ef-btn-sm" data-gallery-close>Done</button>
        </footer>
      </div>`;

    // Documents are built per tile so each iframe gets exactly one variant.
    layer.querySelectorAll<HTMLElement>(".ef-gallery-tile").forEach((tile) => {
      const variant = gallery.variants.find((v) => v.id === tile.dataset.variant);
      const frame = tile.querySelector<HTMLElement>(".ef-gallery-frame");
      if (!variant || !frame) return;
      const iframe = document.createElement("iframe");
      iframe.className = "ef-gallery-iframe";
      // No allow-* tokens: opaque origin, no scripts, no forms, no navigation.
      iframe.setAttribute("sandbox", "");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("title", `Preview: ${variant.label}`);
      iframe.srcdoc = buildVariantDocument(variant, host);
      frame.appendChild(iframe);
    });

    layer.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target === layer) {
        closeGallery();
        return;
      }
      if (target.closest("[data-gallery-close]")) {
        closeGallery();
        return;
      }
      const widthBtn = target.closest<HTMLElement>("[data-gallery-width]");
      if (widthBtn) {
        const next = widthBtn.dataset.galleryWidth === "mobile" ? "mobile" : "desktop";
        const grid = layer.querySelector<HTMLElement>(".ef-gallery-grid");
        if (grid) grid.dataset.width = next;
        layer.querySelectorAll<HTMLElement>("[data-gallery-width]").forEach((btn) => {
          btn.setAttribute("aria-pressed", btn.dataset.galleryWidth === next ? "true" : "false");
        });
        return;
      }
      const pickBtn = target.closest<HTMLElement>("[data-pick]");
      if (pickBtn?.dataset.pick) {
        const id = pickBtn.dataset.pick;
        setPick(turnIndex, chatTurns[turnIndex]?.picked === id ? null : id);
        return;
      }
      const zoomBtn = target.closest<HTMLElement>("[data-zoom]");
      if (zoomBtn?.dataset.zoom) {
        const grid = layer.querySelector<HTMLElement>(".ef-gallery-grid");
        const tile = zoomBtn.closest<HTMLElement>(".ef-gallery-tile");
        const already = tile?.classList.contains("is-zoomed") ?? false;
        layer.querySelectorAll<HTMLElement>(".ef-gallery-tile").forEach((t) => t.classList.remove("is-zoomed"));
        grid?.classList.toggle("is-zoomed", !already);
        if (!already && tile) tile.classList.add("is-zoomed");
        layer.querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) => {
          const on = !already && b.dataset.zoom === zoomBtn.dataset.zoom;
          b.textContent = on ? "Collapse" : "Expand";
        });
      }
    });

    dialog.appendChild(layer);
    galleryLayer = layer;
    topLayerEl = layer;
    layer.querySelector<HTMLElement>("[data-gallery-close]")?.focus();
  };

  const mountChatPanel = (): void => {
    if (!chatEnabled || !opts.chat) return;
    const host = dialog.querySelector<HTMLElement>("#__ef_chat__");
    if (!host) return;
    chatLoadedFor = chatKey();
    chatTurns = loadChat(chatLoadedFor);
    chatPanel = mountChat(host, {
      api: opts.chat.api,
      repo: opts.repo,
      getContext: chatContext,
      getSummary: () => ({
        selector: currentTargets()[0]?.selector ?? opts.selector,
        pendingChanges: allChanges().length,
      }),
      getTurns: () => chatTurns,
      setTurns: (turns) => {
        chatTurns = turns;
        saveChat(chatLoadedFor, turns);
      },
      onUseReport: applyReport,
      onOpenGallery: (turnIndex) => openGallery(turnIndex),
    });
    refreshVariantChip();
    chatLastCount = allChanges().length;
  };

  refreshChat = () => {
    if (!chatEnabled) return;
    // A different element has its own conversation: remount rather than
    // carrying a transcript across a context boundary.
    if (chatPanel && chatKey() !== chatLoadedFor) {
      chatPanel.destroy();
      chatPanel = null;
      mountChatPanel();
      return;
    }
    if (!chatPanel || chatPanel.isBusy()) return;
    const n = allChanges().length;
    if (n === chatLastCount) return;
    chatLastCount = n;
    chatPanel.render();
  };

  // No autofocus: focusing the note textarea would pop the mobile keyboard on
  // open and scroll the context sections out of view.

  // Escape steps back one level: an unfinished page pick ends, another tab
  // returns to Feedback, and only the report itself (the whole thing) cancels.
  const onKey = (e: KeyboardEvent) => {
    // The auth layer owns Escape while it is up.
    if (authLayerOpen) return;
    if (e.key !== "Escape") return;
    // The gallery is a layer above the pane: Escape closes it first.
    if (galleryLayer) {
      closeGallery();
      return;
    }
    if (awaitingPick) {
      // Cancel the pick but keep the dialog: the selection subscription
      // restores the editor once pick mode ends.
      setPickMode(false);
      return;
    }
    if (view === "reports") {
      // The list is the last level: close the pane, keeping every draft.
      closeDialog();
      opts.onCancel();
      return;
    }
    if (tab !== "feedback") {
      setTab("feedback");
      return;
    }
    // Leaving the report keeps the draft; only Discard/Cancel deletes it.
    setView("reports");
  };
  const removeKey = () => {
    document.removeEventListener("keydown", onKey);
    if (dialogKeyHandler === onKey) dialogKeyHandler = null;
  };
  document.addEventListener("keydown", onKey);
  dialogKeyHandler = onKey;

  /** Close after a successful submit/export: the draft is no longer in progress. */
  const finishReport = (): void => {
    if (draftTimer !== null) { window.clearTimeout(draftTimer); draftTimer = null; }
    discarding = true;
    deleteDraft(pageKey, draft.id);
    removeKey();
    closeDialog();
  };

  // Issue card: Cancel throws away the whole report.
  issueCancelBtn.addEventListener("click", () => {
    cancelReport();
  });

  // Edit tab: one button clears the feedback text and its live changes. Two
  // steps so a stray click cannot delete a draft.
  let discardArmed = false;
  const disarmDiscard = (): void => {
    discardArmed = false;
    discardBtn.textContent = "Discard draft";
    discardBtn.removeAttribute("data-confirm");
  };
  discardBtn.addEventListener("click", () => {
    if (!discardArmed) {
      discardArmed = true;
      discardBtn.textContent = "Confirm discard";
      discardBtn.setAttribute("data-confirm", "true");
      window.setTimeout(() => { if (discardArmed) disarmDiscard(); }, 4000);
      return;
    }
    disarmDiscard();
    cancelReport();
  });

  // Modal: Save submits the feedback without creating a GitHub issue.
  submitBtn.addEventListener("click", async () => {
    const comment = collectComment();
    if (!comment) { errDiv.textContent = "Add a note describing the problem."; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    errDiv.textContent = "";
    try {
      await withAuthRetry(
        () => opts.onSubmit(comment, getType(), buildIntent(), false),
        opts.ensureAuth
      )();
      finishReport();
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
    // Memory is an alternative destination, not a mirror of the GitHub export:
    // send the current note to the connected project and stop there.
    if (destination === "memory") {
      const comment = collectComment();
      if (!comment) {
        errDiv.textContent = "Add a note describing the problem.";
        return;
      }
      issueSubmitBtn.disabled = true;
      submitBtn.disabled = true;
      issueSubmitBtn.textContent = "Sending…";
      errDiv.textContent = "";
      try {
        await withAuthRetry(
          () => opts.onSubmit(comment, getType(), buildIntent(), true),
          opts.ensureAuth
        )();
        finishReport();
        showToast("Sent to Memory.");
        opts.onComplete?.();
      } catch (err) {
        if (err instanceof AuthCancelledError) {
          errDiv.textContent = "Sign in to continue";
        } else {
          errDiv.textContent = describeAPIError(err);
        }
        issueSubmitBtn.disabled = false;
        submitBtn.disabled = false;
        issueSubmitBtn.textContent = primaryLabel();
      }
      return;
    }

    // Session is a third destination, not a mirror: the report becomes one
    // message in a coding-agent session and nothing is created here. It needs
    // no GitHub sign-in — the box carries its own token.
    if (destination === "session") {
      const comment = collectComment();
      if (!comment) {
        errDiv.textContent = "Add a note describing the problem.";
        return;
      }
      issueSubmitBtn.disabled = true;
      submitBtn.disabled = true;
      issueSubmitBtn.textContent = "Sending…";
      errDiv.textContent = "";
      try {
        const delivery = await opts.onSendOrder!(comment, getType(), buildIntent(), getIssueTopic());
        finishReport();
        showToast(
          delivery.at
            ? `Sent to session ${sessionShort} at ${delivery.at}.`
            : `Sent to session ${sessionShort}.`
        );
        opts.onComplete?.();
      } catch (err) {
        // The box's refusal is the useful message (missing token, dead session);
        // show it verbatim rather than a generic failure.
        errDiv.textContent = err instanceof Error ? err.message : String(err);
        issueSubmitBtn.disabled = false;
        submitBtn.disabled = false;
        issueSubmitBtn.textContent = primaryLabel();
      }
      return;
    }

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
          () => opts.onSubmit(comment, type, buildIntent(), false),
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
        issueSubmitBtn.textContent = primaryLabel();
        submitBtn.disabled = false;
        return;
      }
      // Await the export before closing: a 401 re-prompts for sign-in and
      // retries; a 403 app_access_required is handled in the catch below.
      await withAuthRetry(
        () => opts.onExport(ids, type, topic),
        opts.ensureAuth
      )();
      finishReport();
      showToast("Issue created successfully!");
      opts.onComplete?.();
    } catch (err) {
      if (err instanceof AuthCancelledError) {
        errDiv.textContent = "Sign in to continue";
        issueSubmitBtn.disabled = false;
        issueSubmitBtn.textContent = primaryLabel();
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
          finishReport();
          showToast("Issue created successfully!");
          opts.onComplete?.();
        } else {
          issueSubmitBtn.disabled = false;
          issueSubmitBtn.textContent = primaryLabel();
          submitBtn.disabled = false;
        }
        return;
      }
      errDiv.textContent = describeAPIError(err);
      issueSubmitBtn.disabled = false;
      issueSubmitBtn.textContent = primaryLabel();
      submitBtn.disabled = false;
    }
  });

  // Initial render + keep selection-driven sections live as the user picks.
  let prevTargetCount = currentTargets().length;
  renderSelection();
  const unsubSelection = onSelectionChange(() => {
    const count = currentTargets().length;
    // A new element landed: focus its tab so the editor targets it.
    if (count > prevTargetCount) activeTargetIdx = count - 1;
    prevTargetCount = count;
    renderSelection();
    // Keep the pane's edit count live whatever tab is showing.
    renderChangeCount();
    // A style change (or a second target) is enough to make this report real:
    // store it so it shows up under All reports.
    if (view === "report" && (getChanges().length > 0 || count > 1)) promoteDraft();
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
    if (changed && !awaitingPick) {
      applyDockState(card);
      activateDialog(card, { modal: !dockedNow, preserveFocusReturn: true, focus: false });
      return;
    }
    applyDockReflow();
    refreshOutlines();
  };
  window.addEventListener("resize", onResize);

  dialogCleanup = () => {
    // Leaving the report keeps the draft: persist its text + edits, then put
    // the page back to the committed baseline. A deliberate discard/submit has
    // already cleaned up and sets `discarding`.
    if (!discarding && view === "report") {
      try { syncDraft(); } catch { /* storage unavailable */ }
      try { suspendDraft(); } catch { /* detached DOM */ }
    }
    unsubSelection();
    unsubHighlight();
    unsubActionSeed();
    chatPanel?.destroy();
    chatPanel = null;
    setHighlight(null);
    endDragVisual();
    window.removeEventListener("resize", onResize);
    deactivateFocusTrap();
  };

  // Backdrop click is never destructive: it steps back to All reports (which
  // suspends the draft), or closes the pane from the list. It never fires while
  // docked — the rail is click-through at the root.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog || effectiveDock() || awaitingPick) return;
    if (view === "reports") {
      closeDialog();
      opts.onCancel();
      return;
    }
    setView("reports");
  });

  // Restore the draft exactly once per open. Doing it here (instead of on every
  // tab switch) keeps newer text intact when returning from the editor.
  restoreDraft();
  renderChangeCount();
  // Open in report context, on the Feedback tab. The rail is installed before
  // the first paint so a docked pane never flashes centered.
  dialog.dataset.tab = "feedback";
  dialog.dataset.view = "report";
  crumbRow.hidden = false;
  reportsEl.hidden = true;
  applyDockState(card);
  activateDialog(card, { modal: !effectiveDock(), preserveFocusReturn: true });
  mountChatPanel();
  // The report form is showing: the page must not be pickable yet.
  opts.onEditingChange?.("submit");
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

  // Drop the auth keyboard state so a later reopen starts clean.
  authLayerOpen = false;
  topLayerEl = null;

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
