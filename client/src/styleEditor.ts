// styleEditor.ts — live CSS-class editing panel.
//
// Renders one row per token group for the current selection, shows the applied
// token (or "Mixed" when targets differ), and applies a chosen token to every
// selected target. Also lists each target's current class list (read-only) and
// offers a "Revert all" action.
//
// Groups are grouped into collapsible sections (group.section, default "Style").
// A group renders as a chip row by default, or as a swatch dropdown when
// `group.render === "dropdown"`. Each group also accepts a free-typed custom
// class; custom tokens are cached module-side so they survive the re-mounts the
// dialog performs on every selection change.

import {
  makeCustomToken,
  matchToken,
  type Token,
  type TokenGroup,
  type ThemeTokens,
} from "./tokens";
import type { TargetEntry } from "./selection";

export interface StyleEditorCallbacks {
  onApply: (group: TokenGroup, token: Token) => void;
  onRevertAll: () => void;
}

/**
 * Custom classes typed by the user, keyed by group id. Module-level so they
 * survive mountStyleEditor being called repeatedly (once per selection change).
 */
const customTokens = new Map<string, Token[]>();

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Append any user-typed custom tokens to each group, deduped by id. */
function augmentGroups(groups: TokenGroup[]): TokenGroup[] {
  return groups.map((g) => {
    const extra = customTokens.get(g.id);
    if (!extra || extra.length === 0) return g;
    const seen = new Set(g.tokens.map((t) => t.id));
    const merged = g.tokens.slice();
    for (const t of extra) {
      if (seen.has(t.id)) continue;
      merged.push(t);
      seen.add(t.id);
    }
    return { ...g, tokens: merged };
  });
}

interface SectionBucket {
  section: string;
  groups: TokenGroup[];
}

/** Group augmented groups by section, preserving first-seen section order. */
function groupBySection(groups: TokenGroup[]): SectionBucket[] {
  const order: string[] = [];
  const map = new Map<string, TokenGroup[]>();
  for (const g of groups) {
    const section = g.section && g.section.trim() ? g.section : "Style";
    let bucket = map.get(section);
    if (!bucket) {
      bucket = [];
      map.set(section, bucket);
      order.push(section);
    }
    bucket.push(g);
  }
  return order.map((section) => ({ section, groups: map.get(section)! }));
}

/** A token chip reads "on" only when every target currently matches it. */
function tokenActive(token: Token, group: TokenGroup, targets: TargetEntry[]): boolean {
  return targets.every((t) => matchToken(t.el, group)?.id === token.id);
}

/** The single token every target matches, or null when none / mixed. */
function currentToken(group: TokenGroup, targets: TargetEntry[]): Token | null {
  const ids = targets.map((t) => matchToken(t.el, group)?.id ?? "");
  const uniq = new Set(ids);
  if (uniq.size !== 1) return null;
  const id = ids[0];
  if (!id) return null;
  return group.tokens.find((t) => t.id === id) ?? null;
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

function swatchHTML(token: Token): string {
  return token.swatch
    ? `<span class="ef-token-swatch" style="background:${escapeHtml(token.swatch)}"></span>`
    : "";
}

function renderChips(group: TokenGroup, targets: TargetEntry[]): string {
  const chips = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, targets);
      return `<button type="button" class="ef-token-chip${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-pressed="${on}" title="${escapeHtml(t.label)}">${swatchHTML(t)}${escapeHtml(t.label)}</button>`;
    })
    .join("");
  return `<div class="ef-token-row">${chips}</div>`;
}

function renderDropdown(group: TokenGroup, targets: TargetEntry[], current: string): string {
  const cur = currentToken(group, targets);
  const headerSwatch = cur ? swatchHTML(cur) : "";
  const options = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, targets);
      return `<li role="option" class="ef-select-option${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-selected="${on}">${swatchHTML(t)}${escapeHtml(t.label)}</li>`;
    })
    .join("");
  return `
      <div class="ef-select" data-group="${escapeHtml(group.id)}">
        <button type="button" class="ef-select-trigger" aria-haspopup="listbox" aria-expanded="false">
          ${headerSwatch}<span class="ef-select-label">${escapeHtml(current)}</span>
          <span class="ef-select-caret" aria-hidden="true">▾</span>
        </button>
        <ul class="ef-select-menu" role="listbox" hidden>${options}</ul>
      </div>`;
}

function renderGroup(group: TokenGroup, targets: TargetEntry[]): string {
  const current = currentLabel(group, targets);
  const body =
    group.render === "dropdown"
      ? renderDropdown(group, targets, current)
      : renderChips(group, targets);

  return `
    <div class="ef-style-group">
      <div class="ef-style-group-head">
        <span class="ef-style-group-label">${escapeHtml(group.label)}</span>
        <span class="ef-style-current${current === "Mixed" ? " ef-style-current-mixed" : ""}">${escapeHtml(current)}</span>
      </div>
      ${body}
      <input type="text" class="ef-custom-input" data-group="${escapeHtml(group.id)}" placeholder="custom class…" spellcheck="false" aria-label="Custom class for ${escapeHtml(group.label)}">
    </div>`;
}

function renderSections(groups: TokenGroup[], targets: TargetEntry[]): string {
  return groupBySection(groups)
    .map(
      ({ section, groups: sectionGroups }) => `
    <details class="ef-style-section" open>
      <summary>${escapeHtml(section)}</summary>
      ${sectionGroups.map((g) => renderGroup(g, targets)).join("")}
    </details>`
    )
    .join("");
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
  const groups = augmentGroups(tokens.groups);
  const sections = renderSections(groups, targets);
  const revertDisabled = changesCount === 0 ? " disabled" : "";
  return `
    <div class="ef-style-editor">
      ${sections}
      ${renderClasses(targets)}
      <div class="ef-style-actions">
        <button type="button" class="ef-btn-secondary ef-style-revert"${revertDisabled}>Revert all</button>
      </div>
    </div>`;
}

/** Wire the swatch dropdowns: one open at a time, keyboard + outside-click close. */
function wireDropdowns(
  root: HTMLElement,
  groups: TokenGroup[],
  cb: StyleEditorCallbacks
): void {
  let openMenu: HTMLElement | null = null;
  let outsideListener: ((e: MouseEvent) => void) | null = null;

  const close = (menu?: HTMLElement | null): void => {
    const m = menu ?? openMenu;
    if (!m) return;
    const trigger = m.parentElement?.querySelector<HTMLElement>(".ef-select-trigger");
    m.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (outsideListener) {
      document.removeEventListener("click", outsideListener, true);
      outsideListener = null;
    }
    openMenu = null;
  };

  root.querySelectorAll<HTMLElement>(".ef-select").forEach((sel) => {
    const trigger = sel.querySelector<HTMLButtonElement>(".ef-select-trigger");
    const menu = sel.querySelector<HTMLUListElement>(".ef-select-menu");
    if (!trigger || !menu) return;

    const options = (): HTMLElement[] =>
      Array.from(menu.querySelectorAll<HTMLElement>(".ef-select-option"));

    const open = (): void => {
      if (openMenu && openMenu !== menu) close();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      openMenu = menu;
      if (!outsideListener) {
        outsideListener = (e: MouseEvent) => {
          if (!sel.contains(e.target as Node)) close(menu);
        };
        document.addEventListener("click", outsideListener, true);
      }
    };

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.hidden) open();
      else close(menu);
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menu.hidden) open();
        const opts = options();
        if (opts.length) (e.key === "ArrowDown" ? opts[0] : opts[opts.length - 1]).focus();
      } else if (e.key === "Escape" && !menu.hidden) {
        e.preventDefault();
        e.stopPropagation();
        close(menu);
      }
    });

    options().forEach((opt) => {
      opt.tabIndex = -1;
      opt.addEventListener("click", () => {
        const gid = opt.dataset.group ?? "";
        const tid = opt.dataset.token ?? "";
        const group = groups.find((g) => g.id === gid);
        const token = group?.tokens.find((t) => t.id === tid);
        if (group && token) cb.onApply(group, token);
        close(menu);
      });
      opt.addEventListener("keydown", (e) => {
        const opts = options();
        const i = opts.indexOf(opt);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          opts[Math.min(i + 1, opts.length - 1)]?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          opts[Math.max(i - 1, 0)]?.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(menu);
          trigger.focus();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          opt.click();
        }
      });
    });
  });
}

/** Render + wire the style editor into `root`. */
export function mountStyleEditor(
  root: HTMLElement,
  tokens: ThemeTokens,
  targets: TargetEntry[],
  changesCount: number,
  cb: StyleEditorCallbacks
): void {
  const groups = augmentGroups(tokens.groups);
  root.innerHTML = renderStyleEditorHTML(tokens, targets, changesCount);

  // Chip row wiring (dropdowns have their own handlers below).
  root.querySelectorAll<HTMLButtonElement>(".ef-token-chip[data-token]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gid = btn.dataset.group ?? "";
      const tid = btn.dataset.token ?? "";
      const group = groups.find((g) => g.id === gid);
      const token = group?.tokens.find((t) => t.id === tid);
      if (group && token) cb.onApply(group, token);
    });
  });

  wireDropdowns(root, groups, cb);

  // Free-typed custom class per group. Enter applies + remembers it.
  root.querySelectorAll<HTMLInputElement>(".ef-custom-input[data-group]").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = makeCustomToken(input.value);
      if (!t) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      input.removeAttribute("aria-invalid");
      const gid = input.dataset.group ?? "";
      const group = groups.find((g) => g.id === gid);
      if (!group) return;
      // Remember the token (replace any prior entry with the same id) so it
      // survives the re-mount that cb.onApply triggers.
      const list = customTokens.get(gid) ?? [];
      const next = list.filter((x) => x.id !== t.id);
      next.push(t);
      customTokens.set(gid, next);
      cb.onApply(group, t);
      input.value = "";
    });
  });

  const revert = root.querySelector<HTMLButtonElement>(".ef-style-revert");
  revert?.addEventListener("click", () => cb.onRevertAll());
}
