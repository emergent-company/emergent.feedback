// dialog.ts — element feedback dialog (existing comments + compose) and login dialog.

import type { FeedbackComment } from "./api";

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
      color: #999;
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
    #__ef_dialog__ textarea::placeholder { color: #aaa; }
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
      color: #888;
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
      color: #999;
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
      color: #888;
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
      color: #888;
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
      color: #999;
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
      color: #999;
      font-family: inherit;
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
  onSubmit: (comment: string, type: FeedbackType) => Promise<number>; // returns new feedback ID
  onExport: (ids: number[], type: FeedbackType, issueTopic: string) => Promise<void>;
  onCancel: () => void;
}

/** Shows the element feedback dialog: existing comments + compose area. */
export function showSubmitDialog(opts: SubmitFeedbackOptions): void {
  injectStyles();
  const dialog = getOrCreateDialog();

  const existing = opts.existingComments;
  const existingIds = existing.map((c) => c.id);
  const ctx = opts.context;

  const commentsHTML = existing.length === 0 ? "" : `
    <div class="fo-comments">
      ${existing.map((c) => `
        <div class="fo-comment-item">
          <div class="fo-comment-meta">
            <span class="fo-comment-author">@${escapeHtml(c.github_user)}</span>
            <span class="fo-comment-date">${escapeHtml(c.created_at)}</span>
          </div>
          <div class="fo-comment-text">${escapeHtml(c.comment)}</div>
        </div>`).join("")}
    </div>`;

  const title = existing.length > 0
    ? `${existing.length} comment${existing.length !== 1 ? "s" : ""} on this element`
    : "Add feedback";

  const chips: string[] = [];
  if (opts.repo)       chips.push(`<span class="fo-target-chip"><span class="fo-target-chip-label">repo</span>${escapeHtml(opts.repo)}</span>`);
  if (opts.branch)     chips.push(`<span class="fo-target-chip"><span class="fo-target-chip-label">branch</span>${escapeHtml(opts.branch)}</span>`);
  if (opts.appVersion) chips.push(`<span class="fo-target-chip"><span class="fo-target-chip-label">version</span>${escapeHtml(opts.appVersion)}</span>`);
  const targetStripHTML = chips.length > 0 ? `<div class="fo-target-strip">${chips.join("")}</div>` : "";

  const hierarchy = opts.componentHierarchy ?? [];
  const componentPickerHTML = hierarchy.length > 1 ? `
    <div class="fo-component-row">
      <span class="fo-component-label">Component</span>
      <select class="fo-component-select" id="__ef_component__">
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
    <div class="fo-meta-key">${escapeHtml(k)}</div>
    <div class="fo-meta-val">${escapeHtml(v)}</div>`).join("");

  const outerHTML = ctx["outerHTML"] as string | undefined;

  dialog.innerHTML = `
    <div class="fo-card">
      <div class="fo-header">
        <div class="fo-header-top">
          <h2>${title}</h2>
          <div class="fo-user-pill">
            <img src="${escapeHtml(opts.user.avatarUrl)}" alt="">
            <span>${escapeHtml(opts.user.login)}</span>
          </div>
        </div>
        <details class="fo-meta-toggle">
          <summary>Context that will be attached</summary>
          <div class="fo-meta-grid">${metaHTML}</div>
        </details>
        ${outerHTML ? `
        <details class="fo-meta-toggle">
          <summary>Element HTML</summary>
          <pre class="fo-html-preview">${highlightHTML(outerHTML)}</pre>
        </details>` : ""}
        ${buildSessionHistoryHTML(ctx)}
      </div>
      ${componentPickerHTML}
      ${targetStripHTML}
      ${commentsHTML}
      <div class="fo-compose">
        <div class="fo-topic-row">
          <label class="fo-topic-label" for="__ef_topic__">Issue title</label>
          <input class="fo-topic-input" id="__ef_topic__" type="text" value="${escapeHtml(opts.defaultIssueTopic)}">
        </div>
        <textarea id="__ef_comment__" placeholder="Add a comment…"></textarea>
        <div class="fo-type-toggle">
          <input type="radio" name="__ef_type__" id="__ef_type_bug__" value="bug">
          <label for="__ef_type_bug__">🐛 Bug</label>
          <input type="radio" name="__ef_type__" id="__ef_type_enh__" value="enhancement" checked>
          <label for="__ef_type_enh__">✨ Enhancement</label>
        </div>
        <div class="fo-error" id="__ef_err__"></div>
      </div>
      <div class="fo-footer">
        <button class="fo-btn-secondary" id="__ef_submit__">Save</button>
        <div class="fo-footer-spacer"></div>
        <button class="fo-btn-secondary" id="__ef_cancel__">Cancel</button>
        <button class="fo-btn-primary" id="__ef_export__">Send to GitHub</button>
      </div>
    </div>
  `;

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

  textarea.focus();

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
    const comment = textarea.value.trim();
    if (!comment) { errDiv.textContent = "Please enter a comment."; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    errDiv.textContent = "";
    try {
      await opts.onSubmit(comment, getType());
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
      const comment = textarea.value.trim();
      const type = getType();
      const topic = getIssueTopic();
      let ids = [...existingIds];
      if (comment) {
        // Submit the new comment first, then include its ID in the export.
        const newId = await opts.onSubmit(comment, type);
        ids = [...ids, newId];
      }
      if (ids.length === 0) {
        errDiv.textContent = "Nothing to export — add a comment first.";
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
    <div class="fo-login-card">
      <h2>Sign in with GitHub</h2>
      <p>Authentication required to submit feedback.</p>
      <div class="fo-login-actions">
        <button class="fo-btn-secondary" id="__ef_cancel__">Cancel</button>
        <button class="fo-btn-primary" id="__ef_login__">Sign in with GitHub</button>
      </div>
      <div class="fo-error" id="__ef_err__" style="margin-top:8px"></div>
    </div>
  `;

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
  if (dialog) dialog.remove();
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
  el.classList.add("fo-visible");
  clearTimeout((el as any).__ef_toast_timer);
  (el as any).__ef_toast_timer = setTimeout(() => {
    el!.classList.remove("fo-visible");
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
      out.push(pad() + span("fo-hd", e(full)) + "\n");
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
    let tag = span("fo-hp", "&lt;") + (isClose ? span("fo-hp", "/") : "");
    tag += span("fo-ht", e(tagName ?? ""));

    // Highlight attributes.
    const attrStr = match[2] ?? "";
    if (attrStr.trim()) {
      ATTR.lastIndex = 0;
      let am: RegExpExecArray | null;
      while ((am = ATTR.exec(attrStr)) !== null) {
        const name = am[1];
        const rest = am[2] ?? ""; // includes the = and value
        tag += " " + span("fo-ha", e(name));
        if (rest) {
          // split off = and value
          const eqIdx = rest.indexOf("=");
          const val = rest.slice(eqIdx + 1).trim();
          tag += span("fo-hp", "=") + span("fo-hv", e(val));
        }
      }
    }

    tag += (isSelf && !isClose ? span("fo-hp", " /&gt;") : span("fo-hp", "&gt;"));

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
        lines.push(`<div class="fo-history-line"><span class="fo-history-type">nav</span> ${time} ${escapeHtml(prev)} → ${escapeHtml(url)}</div>`);
        break;
      }
      case "input": {
        const comp = t.data.component ? ` [${escapeHtml(t.data.component)}]` : "";
        const val = String(t.data.value ?? "");
        const valDisplay = val.length > 60 ? val.slice(0, 57) + "..." : val;
        lines.push(`<div class="fo-history-line"><span class="fo-history-type">input</span> ${time} ${escapeHtml(String(t.data.tagName ?? ""))}${comp} = "${escapeHtml(valDisplay)}"</div>`);
        break;
      }
      case "click": {
        const comp = t.data.component ? ` [${escapeHtml(t.data.component)}]` : "";
        const txt = t.data.text ? ` "${escapeHtml(String(t.data.text))}"` : "";
        lines.push(`<div class="fo-history-line"><span class="fo-history-type">click</span> ${time} ${escapeHtml(String(t.data.tagName ?? ""))}${comp}${txt}</div>`);
        break;
      }
    }
  }

  if (lines.length === 0) return "";

  return `
    <details class="fo-meta-toggle">
      <summary>Session history (last ${lines.length} events)</summary>
      <div class="fo-history-list">${lines.join("")}</div>
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
