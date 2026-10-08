// styleEditor.ts — live CSS-class editing panel for a single active target.
//
// The editor configures ONE element at a time (the active per-element tab in the
// dialog). Each token group renders as a Figma-like horizontal property row:
// group label on the left, control on the right (chips or a swatch dropdown).
//
// Dropdown menus end with a "Custom class…" item that reveals an inline text
// input. A typed class is validated + cached module-side (so it survives the
// re-mounts the dialog performs on every selection change) and applied through
// the onApply callback. Chip groups expose the same affordance via a "+ Custom"
// toggle.
//
// Groups are grouped into collapsible sections (group.section, default "Style").

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
}

/**
 * Custom classes typed by the user, keyed by group id. Module-level so they
 * survive mountStyleEditor being called repeatedly (once per selection change).
 */
const customTokens = new Map<string, Token[]>();

/**
 * Closes the dropdown currently open, if any. mountStyleEditor rewrites
 * innerHTML on every selection change, which would otherwise orphan an open
 * menu's document-level outside-click listener; calling this before the
 * re-render tears down the stale menu + listener.
 */
let activeDropdownClose: (() => void) | null = null;

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

/** A token chip reads "on" only when the active element currently matches it. */
function tokenActive(token: Token, group: TokenGroup, el: Element): boolean {
  return matchToken(el, group)?.id === token.id;
}

/** Current group value label for the active element ("Default" when unset). */
function currentLabel(group: TokenGroup, el: Element): string {
  return matchToken(el, group)?.label ?? "Default";
}

function swatchHTML(token: Token): string {
  return token.swatch
    ? `<span class="ef-token-swatch" style="background:${escapeHtml(token.swatch)}"></span>`
    : "";
}

function customInputHTML(group: TokenGroup): string {
  return `<input type="text" class="ef-custom-input" data-group="${escapeHtml(group.id)}" placeholder="custom class…" spellcheck="false" aria-label="Custom class for ${escapeHtml(group.label)}">`;
}

function renderChips(group: TokenGroup, el: Element): string {
  const chips = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, el);
      return `<button type="button" class="ef-token-chip${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-pressed="${on}" title="${escapeHtml(t.label)}">${swatchHTML(t)}${escapeHtml(t.label)}</button>`;
    })
    .join("");
  return `
      <div class="ef-token-row">
        ${chips}
        <button type="button" class="ef-custom-toggle" data-group="${escapeHtml(group.id)}" aria-expanded="false" title="Custom class">+ Custom</button>
      </div>
      <div class="ef-custom-field" hidden>${customInputHTML(group)}</div>`;
}

function renderDropdown(group: TokenGroup, el: Element): string {
  const cur = matchToken(el, group);
  const headerSwatch = cur ? swatchHTML(cur) : "";
  const options = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, el);
      return `<li role="option" class="ef-select-option${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-selected="${on}">${swatchHTML(t)}${escapeHtml(t.label)}</li>`;
    })
    .join("");
  return `
      <div class="ef-select" data-group="${escapeHtml(group.id)}">
        <button type="button" class="ef-select-trigger" aria-haspopup="listbox" aria-expanded="false">
          ${headerSwatch}<span class="ef-select-label">${escapeHtml(currentLabel(group, el))}</span>
          <span class="ef-select-caret" aria-hidden="true">▾</span>
        </button>
        <ul class="ef-select-menu" role="listbox" hidden>
          ${options}
          <li class="ef-select-sep" role="presentation"></li>
          <li role="option" class="ef-select-custom" data-group="${escapeHtml(group.id)}" aria-selected="false" tabindex="-1">Custom class…</li>
          <li class="ef-select-custom-edit" role="presentation" hidden>${customInputHTML(group)}</li>
        </ul>
      </div>`;
}

/** One Figma-like horizontal property row: label left, control right. */
function renderGroup(group: TokenGroup, el: Element): string {
  const control =
    group.render === "dropdown"
      ? renderDropdown(group, el)
      : renderChips(group, el);
  return `
    <div class="ef-prop-row" data-group="${escapeHtml(group.id)}">
      <span class="ef-prop-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
      <div class="ef-prop-control">${control}</div>
    </div>`;
}

function renderSections(groups: TokenGroup[], el: Element): string {
  return groupBySection(groups)
    .map(
      ({ section, groups: sectionGroups }) => `
    <details class="ef-style-section" open>
      <summary>${escapeHtml(section)}</summary>
      <div class="ef-style-section-body">
        ${sectionGroups.map((g) => renderGroup(g, el)).join("")}
      </div>
    </details>`
    )
    .join("");
}

/** "Current classes" for the active element only. */
function renderClasses(target: TargetEntry): string {
  const classes = Array.from(target.el.classList ?? []).join(" ");
  return `
    <details class="ef-style-classes">
      <summary>Current classes</summary>
      <div class="ef-style-class-list">
        <div class="ef-style-class-item"><code>${classes ? escapeHtml(classes) : "(no classes)"}</code></div>
      </div>
    </details>`;
}

function renderEditorHTML(
  tokens: ThemeTokens,
  target: TargetEntry,
  changesCount: number
): string {
  const groups = augmentGroups(tokens.groups);
  const label = target.dataComponent || target.selector;
  return `
    <div class="ef-style-editor" data-changes="${changesCount}">
      <div class="ef-style-head">
        <span class="ef-style-target-label">Editing</span>
        <code class="ef-style-target-sel" title="${escapeHtml(target.selector)}">${escapeHtml(label)}</code>
      </div>
      ${renderSections(groups, target.el)}
      ${renderClasses(target)}
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
    activeDropdownClose = null;
  };

  root.querySelectorAll<HTMLElement>(".ef-select").forEach((sel) => {
    const trigger = sel.querySelector<HTMLButtonElement>(".ef-select-trigger");
    const menu = sel.querySelector<HTMLUListElement>(".ef-select-menu");
    if (!trigger || !menu) return;

    const items = (): HTMLElement[] =>
      Array.from(
        menu.querySelectorAll<HTMLElement>(".ef-select-option, .ef-select-custom")
      );

    const open = (): void => {
      if (openMenu && openMenu !== menu) close();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      openMenu = menu;
      activeDropdownClose = () => close(menu);
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
        const opts = items();
        if (opts.length) (e.key === "ArrowDown" ? opts[0] : opts[opts.length - 1]).focus();
      } else if (e.key === "Escape" && !menu.hidden) {
        e.preventDefault();
        e.stopPropagation();
        close(menu);
      } else if (e.key === "Tab" && !menu.hidden) {
        // Let focus move on naturally, but collapse the menu first.
        close(menu);
      }
    });

    items().forEach((opt) => {
      opt.tabIndex = -1;
      opt.addEventListener("click", () => {
        if (opt.classList.contains("ef-select-custom")) {
          const edit = menu.querySelector<HTMLElement>(".ef-select-custom-edit");
          const input = edit?.querySelector<HTMLInputElement>(".ef-custom-input");
          if (edit && input) {
            edit.hidden = false;
            input.focus();
          }
          return;
        }
        const gid = opt.dataset.group ?? "";
        const tid = opt.dataset.token ?? "";
        const group = groups.find((g) => g.id === gid);
        const token = group?.tokens.find((t) => t.id === tid);
        close(menu);
        if (group && token) cb.onApply(group, token);
      });
      opt.addEventListener("keydown", (e) => {
        const opts = items();
        const i = opts.indexOf(opt);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          opts[Math.min(i + 1, opts.length - 1)]?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          opts[Math.max(i - 1, 0)]?.focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          opts[0]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          opts[opts.length - 1]?.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(menu);
          trigger.focus();
        } else if (e.key === "Tab") {
          // Collapse the menu, then let Tab move focus out of the group.
          close(menu);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          opt.click();
        }
      });
    });
  });
}

/** Wire the chip-group "+ Custom" toggles to their inline text fields. */
function wireCustomToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".ef-custom-toggle").forEach((btn) => {
    const field = btn.closest(".ef-prop-control")?.querySelector<HTMLElement>(".ef-custom-field");
    if (!field) return;
    btn.addEventListener("click", () => {
      const show = field.hidden;
      field.hidden = !show;
      btn.setAttribute("aria-expanded", show ? "true" : "false");
      if (show) field.querySelector<HTMLInputElement>(".ef-custom-input")?.focus();
    });
  });
}

/** Free-typed custom class inputs (chip fields + dropdown menu inputs). */
function wireCustomInputs(
  root: HTMLElement,
  tokens: ThemeTokens,
  cb: StyleEditorCallbacks
): void {
  root.querySelectorAll<HTMLInputElement>(".ef-custom-input[data-group]").forEach((input) => {
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Keep Escape from reaching the dialog's close handler while editing.
        e.stopPropagation();
        if (input.closest(".ef-select-menu")) activeDropdownClose?.();
        else input.blur();
        return;
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      const t = makeCustomToken(input.value);
      if (!t) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      input.removeAttribute("aria-invalid");
      const gid = input.dataset.group ?? "";
      // Remember the token (replace any prior entry with the same id) so it
      // survives the re-mount that cb.onApply triggers.
      const list = customTokens.get(gid) ?? [];
      customTokens.set(gid, [...list.filter((x) => x.id !== t.id), t]);
      // Re-augment so the applied record carries this custom token.
      const liveGroup = augmentGroups(tokens.groups).find((g) => g.id === gid);
      if (!liveGroup) return;
      cb.onApply(liveGroup, t);
      input.value = "";
    });
  });
}

/** Render + wire the style editor into `root` for the active target. */
export function mountStyleEditor(
  root: HTMLElement,
  tokens: ThemeTokens,
  target: TargetEntry | null,
  changesCount: number,
  cb: StyleEditorCallbacks
): void {
  // Tear down any dropdown left open by a previous mount before replacing the
  // DOM: its outside-click listener would otherwise leak.
  activeDropdownClose?.();
  activeDropdownClose = null;

  if (!target) {
    root.innerHTML = `<div class="ef-style-empty">Select an element to edit padding and colors.</div>`;
    return;
  }

  const groups = augmentGroups(tokens.groups);
  root.innerHTML = renderEditorHTML(tokens, target, changesCount);

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
  wireCustomToggles(root);
  wireCustomInputs(root, tokens, cb);
}
