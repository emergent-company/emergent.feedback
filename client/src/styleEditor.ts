// styleEditor.ts — live CSS-class editing panel.
//
// Renders one row per token group for the current selection, shows the applied
// token (or "Mixed" when targets differ), and applies a chosen token to every
// selected target. Also lists each target's current class list (read-only) and
// offers a "Revert all" action.

import { matchToken, type Token, type TokenGroup, type ThemeTokens } from "./tokens";
import type { TargetEntry } from "./selection";

export interface StyleEditorCallbacks {
  onApply: (group: TokenGroup, token: Token) => void;
  onRevertAll: () => void;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A token chip reads "on" only when every target currently matches it. */
function tokenActive(token: Token, group: TokenGroup, targets: TargetEntry[]): boolean {
  return targets.every((t) => matchToken(t.el, group)?.id === token.id);
}

/** Current group value: a token label, "Default" (none), or "Mixed". */
function currentLabel(group: TokenGroup, targets: TargetEntry[]): string {
  const ids = targets.map((t) => matchToken(t.el, group)?.id ?? "");
  const uniq = Array.from(new Set(ids));
  if (uniq.length === 1) {
    const id = uniq[0];
    if (!id) return "Default";
    return group.tokens.find((t) => t.id === id)?.label ?? id;
  }
  return "Mixed";
}

function renderGroup(group: TokenGroup, targets: TargetEntry[]): string {
  const current = currentLabel(group, targets);
  const chips = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, targets);
      const swatch = t.swatch
        ? `<span class="ef-token-swatch" style="background:${escapeHtml(t.swatch)}"></span>`
        : "";
      return `<button type="button" class="ef-token-chip${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-pressed="${on}" title="${escapeHtml(t.label)}">${swatch}${escapeHtml(t.label)}</button>`;
    })
    .join("");

  return `
    <div class="ef-style-group">
      <div class="ef-style-group-head">
        <span class="ef-style-group-label">${escapeHtml(group.label)}</span>
        <span class="ef-style-current${current === "Mixed" ? " ef-style-current-mixed" : ""}">${escapeHtml(current)}</span>
      </div>
      <div class="ef-token-row">${chips}</div>
    </div>`;
}

function renderClasses(targets: TargetEntry[]): string {
  if (targets.length === 0) return "";
  const rows = targets
    .map((t, i) => {
      const classes = Array.from(t.el.classList ?? []).join(" ");
      return `<div class="ef-style-class-item"><span class="ef-style-class-idx">${i + 1}</span><code>${classes ? escapeHtml(classes) : "(no classes)"}</code></div>`;
    })
    .join("");
  return `
    <details class="ef-style-classes">
      <summary>Current classes</summary>
      <div class="ef-style-class-list">${rows}</div>
    </details>`;
}

export function renderStyleEditorHTML(
  tokens: ThemeTokens,
  targets: TargetEntry[],
  changesCount: number
): string {
  if (targets.length === 0) {
    return `<div class="ef-style-empty">Select an element to edit padding and colors.</div>`;
  }
  const groups = tokens.groups.map((g) => renderGroup(g, targets)).join("");
  const revertDisabled = changesCount === 0 ? " disabled" : "";
  return `
    <div class="ef-style-editor">
      <div class="ef-section-label">Style</div>
      ${groups}
      ${renderClasses(targets)}
      <div class="ef-style-actions">
        <button type="button" class="ef-btn-secondary ef-style-revert"${revertDisabled}>Revert all</button>
      </div>
    </div>`;
}

/** Render + wire the style editor into `root`. */
export function mountStyleEditor(
  root: HTMLElement,
  tokens: ThemeTokens,
  targets: TargetEntry[],
  changesCount: number,
  cb: StyleEditorCallbacks
): void {
  root.innerHTML = renderStyleEditorHTML(tokens, targets, changesCount);

  root.querySelectorAll<HTMLButtonElement>("[data-token]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = btn.dataset.group ?? "";
      const tid = btn.dataset.token ?? "";
      const group = tokens.groups.find((g) => g.id === gid);
      const token = group?.tokens.find((t) => t.id === tid);
      if (group && token) cb.onApply(group, token);
    });
  });

  const revert = root.querySelector<HTMLButtonElement>(".ef-style-revert");
  revert?.addEventListener("click", () => cb.onRevertAll());
}
