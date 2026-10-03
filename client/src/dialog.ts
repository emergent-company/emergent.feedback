// dialog.ts — element feedback dialog (existing comments + compose) and login dialog.

import type { FeedbackComment } from "./api";
import type { FeedbackIntent, IntentAction, ScopeBreadth } from "./envelope";

const DIALOG_ID = "__ef_dialog__";
const STYLE_ID = "__ef_styles__";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #__ef_dialog__ {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.55);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #__ef_dialog__ * { box-sizing: border-box; }

    /* ── Main card ─────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-card {
      background: #fff;
      border-radius: 10px;
      width: 520px;
      max-width: calc(100vw - 32px);
      max-height: 85vh;
      box-shadow: 0 12px 48px rgba(0,0,0,0.28);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* Programmatic focus target — no visible ring on the card itself. */
    #__ef_dialog__ .ef-card:focus,
    #__ef_dialog__ .ef-login-card:focus { outline: none; }
    #__ef_dialog__ .ef-header {
      padding: 14px 18px 10px;
      border-bottom: 1px solid #e8e8e8;
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
      color: #0f0f0f;
      flex: 1;
    }
    #__ef_dialog__ .ef-user-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #666;
      font-weight: 500;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-user-pill img {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid #ddd;
    }
    #__ef_dialog__ .ef-selector {
      font-size: 11px;
      color: #555;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
    }

    /* ── Existing comments ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-comments {
      flex-shrink: 0;
      max-height: 240px;
      overflow-y: auto;
      border-bottom: 1px solid #e8e8e8;
    }
    #__ef_dialog__ .ef-comment-item {
      padding: 10px 18px;
      border-bottom: 1px solid #f2f2f2;
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
      color: #0f0f0f;
    }
    #__ef_dialog__ .ef-comment-date {
      font-size: 11px;
      color: #767676;
    }
    #__ef_dialog__ .ef-comment-text {
      font-size: 13px;
      color: #222;
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
      border: 1px solid #ccc;
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 13px;
      font-family: inherit;
      color: #111;
      resize: vertical;
      min-height: 80px;
      outline: none;
      line-height: 1.5;
      flex: 1;
    }
    #__ef_dialog__ textarea:focus {
      border-color: #4f86f7;
      box-shadow: 0 0 0 3px rgba(79,134,247,0.15);
    }
    #__ef_dialog__ textarea::placeholder { color: #767676; }
    #__ef_dialog__ .ef-error {
      color: #c53030;
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
      border: 1.5px solid #ddd;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      color: #555;
      background: #fff;
      transition: all 0.1s;
      user-select: none;
    }
    #__ef_dialog__ .ef-type-toggle input[value="bug"]:checked + label {
      background: #fff0f0;
      border-color: #d73a4a;
      color: #d73a4a;
    }
    #__ef_dialog__ .ef-type-toggle input[value="enhancement"]:checked + label {
      background: #f0fbff;
      border-color: #0969da;
      color: #0969da;
    }

    /* ── Footer ────────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-footer {
      padding: 10px 18px;
      border-top: 1px solid #e8e8e8;
      display: flex;
      align-items: center;
      gap: 8px;
      background: #fafafa;
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
    #__ef_dialog__ .ef-btn-primary { background: #4f86f7; color: #fff; }
    #__ef_dialog__ .ef-btn-primary:hover { background: #3a6fd8; }
    #__ef_dialog__ .ef-btn-primary:disabled { background: #a0baf7; cursor: default; }
    #__ef_dialog__ .ef-btn-secondary { background: #efefef; color: #222; }
    #__ef_dialog__ .ef-btn-secondary:hover { background: #e0e0e0; }
    #__ef_dialog__ .ef-btn-export { background: #1a1a1a; color: #fff; }
    #__ef_dialog__ .ef-btn-export:hover { background: #333; }
    #__ef_dialog__ .ef-btn-export:disabled { background: #888; cursor: default; }

    /* ── Metadata collapsible ──────────────────────────────────────────────── */
    #__ef_dialog__ .ef-meta-toggle {
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-meta-toggle summary {
      font-size: 11px;
      color: #767676;
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
      color: #767676;
      white-space: nowrap;
    }
    #__ef_dialog__ .ef-meta-val {
      color: #222;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      word-break: break-all;
      white-space: pre-wrap;
    }
    #__ef_dialog__ .ef-meta-section-title {
      grid-column: 1 / -1;
      font-weight: 600;
      color: #555;
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
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #__ef_dialog__ .ef-history-type {
      display: inline-block;
      width: 36px;
      font-weight: 600;
      color: #767676;
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
      background: #1e1e2e;
      border-radius: 5px;
      border: 1px solid #313149;
      color: #cdd6f4;
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
      color: #767676;
    }
    #__ef_dialog__ .ef-topic-input {
      width: 100%;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: inherit;
      color: #111;
      outline: none;
      background: #fafafa;
    }
    #__ef_dialog__ .ef-topic-input:focus {
      border-color: #4f86f7;
      background: #fff;
      box-shadow: 0 0 0 3px rgba(79,134,247,0.12);
    }

    /* ── Component picker ──────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-component-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      border-bottom: 1px solid #e8e8e8;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-component-label {
      font-size: 11px;
      color: #767676;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-component-select {
      flex: 1;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      color: #111;
      background: #f7f7f7;
      border: 1px solid #ddd;
      border-radius: 5px;
      padding: 3px 6px;
      outline: none;
      cursor: pointer;
    }
    #__ef_dialog__ .ef-component-select:focus {
      border-color: #4f86f7;
      background: #fff;
    }

    /* ── Target info strip ─────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-target-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 18px 10px;
      border-bottom: 1px solid #e8e8e8;
      flex-shrink: 0;
    }
    #__ef_dialog__ .ef-target-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      color: #444;
      background: #f2f2f2;
      border-radius: 4px;
      padding: 2px 7px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    #__ef_dialog__ .ef-target-chip-label {
      /* on #f2f2f2 chip — #767676 only clears 4.0:1 there */
      color: #666666;
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
      color: #767676;
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
      border: 1.5px solid #ddd;
      background: #fff;
      color: #555;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      font-family: inherit;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s, border-color 0.1s, color 0.1s;
    }
    #__ef_dialog__ .ef-chip:hover { border-color: #bbb; background: #fafafa; }
    #__ef_dialog__ .ef-chip:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(79,134,247,0.2);
    }
    #__ef_dialog__ .ef-chip.ef-chip-on {
      background: #eef3ff;
      border-color: #4f86f7;
      color: #2b5fd0;
    }
    #__ef_dialog__ .ef-chip.ef-chip-muted {
      /* chip hover background is #fafafa */
      color: #666666;
      border-style: dashed;
      font-weight: 400;
    }
    #__ef_dialog__ .ef-hint {
      font-size: 11px;
      color: #767676;
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
      border: 1px solid #ddd;
      border-radius: 6px;
      background: #fafafa;
      flex: 1;
      min-width: 0;
    }
    #__ef_dialog__ .ef-swatch {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      border: 1px solid rgba(0,0,0,0.15);
      flex-shrink: 0;
      overflow: hidden;
      /* checkerboard shows through translucent colours */
      background-image:
        linear-gradient(45deg, #e6e6e6 25%, transparent 25%, transparent 75%, #e6e6e6 75%),
        linear-gradient(45deg, #e6e6e6 25%, transparent 25%, transparent 75%, #e6e6e6 75%);
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
      color: #666666;
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
      color: #111;
      outline: none;
    }

    /* ── Login card ────────────────────────────────────────────────────────── */
    #__ef_dialog__ .ef-login-card {
      background: #fff;
      border-radius: 10px;
      padding: 28px 24px 20px;
      width: 340px;
      max-width: calc(100vw - 32px);
      box-shadow: 0 12px 48px rgba(0,0,0,0.28);
    }
    #__ef_dialog__ .ef-login-card h2 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 700;
      color: #0f0f0f;
    }
    #__ef_dialog__ .ef-login-card p {
      margin: 0 0 18px;
      font-size: 13px;
      color: #555;
    }
    #__ef_dialog__ .ef-login-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
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

function getFocusable(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Wire focus containment + restoration for a dialog card. Captures the element
 * that currently has focus so closeDialog() can restore it, moves focus to the
 * card itself (a stable, non-keyboard-triggering target), and traps Tab /
 * Shift+Tab inside the card while it is open.
 */
function activateDialog(card: HTMLElement): void {
  focusReturnEl = (document.activeElement as HTMLElement | null) ?? null;

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
      ${commentsHTML}
      <div class="ef-compose">
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
  activateDialog(card);

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

  scopeWrap.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-breadth]");
    if (!btn) return;
    breadth = (btn.dataset.breadth ?? "element") as ScopeBreadth;
    scopeWrap.querySelectorAll<HTMLButtonElement>("[data-breadth]").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("ef-chip-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    // Honest: region/multi selection is not wired up in this build.
    scopeHint.textContent = breadth === "element"
      ? ""
      : "Region/multi selection isn't captured yet — this element is recorded.";
  });

  // Any edit (including clearing the field) marks the actual value as stated.
  actualInput?.addEventListener("input", () => { actualEdited = true; });
  actualInput?.addEventListener("change", () => { actualEdited = true; });

  /** Build the structured intent passed to onSubmit as the third argument. */
  const buildIntent = (): FeedbackIntent => {
    const actualVal = actualInput?.value.trim();
    return {
      kind: getType(),
      action,
      expected: expected.trim() || undefined,
      actual: actualVal ? `${current ? current.label + ": " : ""}${actualVal}` : undefined,
      actualEdited,
      scope: { breadth, targets: [opts.selector] },
    };
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
  const removeKey = () => document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);

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

  // Backdrop click to cancel.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) { removeKey(); closeDialog(); opts.onCancel(); }
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
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: #1a1a1a;
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      max-width: 360px;
    }
    #${TOAST_ID}.ef-visible {
      opacity: 1;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
