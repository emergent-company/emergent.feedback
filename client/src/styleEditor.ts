// styleEditor.ts — live CSS-class editing panel for a single active target.
//
// The editor configures ONE element at a time (the active per-element tab in the
// dialog). Its layout mirrors a design tool's property inspector:
//
//   section (Position / Auto layout / Appearance / Fill / Typography)
//     └─ field: a small label ABOVE its control, reset on the right
//          ├─ select      — value + caret, opens a menu (enumerated classes)
//          ├─ segmented   — intrinsic-width icon cells for spatial values
//          └─ chips       — host manifests that ask for render: "chips"
//
// Fields pair into a two-column grid (width/height, align/justify, …) while
// segmented groups keep their intrinsic width and never stretch. Sections
// collapse by clicking their header and persist that state across the re-mounts
// the dialog performs on every selection change.
//
// A typed custom class is validated + cached module-side (so it survives those
// re-mounts) and applied through the onApply callback. Every menu ends with a
// "Custom class…" item that reveals an inline text input.

import {
  makeCustomToken,
  matchToken,
  type Token,
  type TokenGroup,
  type ThemeTokens,
} from "./tokens";
import { visibleGroups, describeRequirement } from "./applicability";
import {
  getEditableText,
  hasTextChangeFor,
  setHighlight,
  type TargetEntry,
} from "./selection";
import { describePosition } from "./structure";
import { ICONS, type GlyphIcon } from "./icons";

export interface StyleEditorCallbacks {
  onApply: (group: TokenGroup, token: Token) => void;
  /**
   * Reset the group to the element's own styling ("Default"). Called from the
   * per-field reset control, the section reset and the menu's Default item.
   */
  onClear: (group: TokenGroup) => void;
  /** Re-render the editor (called after toggling "Show all"). */
  onRerender: () => void;
  /**
   * Live text edit from the Text field. The DOM is updated by the state layer
   * without a re-render, so typing keeps focus and the caret.
   */
  onTextInput: (value: string) => void;
  /** The Text field blurred / Enter was pressed: refresh the Changes panel. */
  onTextCommit: () => void;
  /** Restore the element's original direct text. */
  onTextReset: () => void;
}

/**
 * Custom classes typed by the user, keyed by group id. Module-level so they
 * survive mountStyleEditor being called repeatedly (once per selection change).
 */
const customTokens = new Map<string, Token[]>();

/**
 * "Show all" escape hatch: when true, inapplicable groups are rendered anyway
 * (with a hint that some have no effect). Module-level so it survives the
 * re-mounts the dialog performs on every selection change.
 */
let showAllGroups = false;

/** Sections the user collapsed. Persisted across re-mounts, like showAllGroups. */
const collapsedSections = new Set<string>();

/**
 * Reading order of the sections. The inspector is ordered like a design tool:
 * where the element sits, how it lays out, how it looks, what it's filled with,
 * then type. Unknown sections (host manifests) keep their first-seen order after
 * these.
 */
const SECTION_ORDER = ["Position", "Auto layout", "Appearance", "Fill", "Typography", "daisyUI"];

/**
 * Fields that share a row in the two-column grid. First-seen wins: the partner
 * is pulled up next to its mate when both are visible in the same section.
 */
const ROW_PAIRS: Array<[string, string]> = [
  ["positioning", "inset"],
  ["width", "height"],
  ["align", "justify"],
  ["flexDir", "wrap"],
  ["rounded", "borderWidth"],
  ["textSize", "fontWeight"],
  ["textColor", "backgroundColor"],
  ["gap", "padding"],
  ["margin", "maxWidth"],
  ["btnColor", "btnSize"],
  ["badgeColor", "badgeSize"],
];

const PAIR_OF = new Map<string, string>();
for (const [a, b] of ROW_PAIRS) {
  PAIR_OF.set(a, b);
  PAIR_OF.set(b, a);
}

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

/**
 * Group augmented groups by section. Sections follow SECTION_ORDER; anything a
 * host manifest invents is appended in first-seen order.
 */
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
  const ranked = (s: string): number => {
    const i = SECTION_ORDER.indexOf(s);
    return i === -1 ? SECTION_ORDER.length + order.indexOf(s) : i;
  };
  return order
    .slice()
    .sort((a, b) => ranked(a) - ranked(b))
    .map((section) => ({ section, groups: map.get(section)! }));
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

/**
 * Inline `<svg>` for a glyph. `viewBox` and every `d` were already validated in
 * tokens.ts against a strict charset whitelist (path commands, digits and
 * whitespace only), so no HTML metacharacter can appear here. This markup must
 * NEVER be built from unvalidated strings.
 */
function iconSVG(icon: GlyphIcon): string {
  const paths = icon.paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg viewBox="${icon.viewBox}" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function customInputHTML(group: TokenGroup): string {
  return `<input type="text" class="ef-custom-input" data-group="${escapeHtml(group.id)}" placeholder="custom class…" spellcheck="false" aria-label="Custom class for ${escapeHtml(group.label)}">`;
}

/** Field header: a small label with the per-field reset on the right. */
/** Field header: a small label with the per-field reset on the right. */
function fieldHeadHTML(group: TokenGroup, withReset: boolean): string {
  const reset = withReset
    ? `<button type="button" class="ef-prop-reset" data-reset="1" data-group="${escapeHtml(group.id)}" aria-label="Reset ${escapeHtml(group.label)}" title="Reset — use the element's own ${escapeHtml(group.label.toLowerCase())}">${iconSVG(ICONS.unset)}</button>`
    : "";
  return `
      <div class="ef-prop-head">
        <span class="ef-prop-label" id="${labelID(group)}" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
        ${reset}
      </div>`;
}

/** Stable id for a field's label, so the control can reference it as its name. */
function labelID(group: TokenGroup): string {
  return `ef-prop-label-${group.id.replace(/[^\w-]/g, "")}`;
}

/** Manifest-requested chip row (kept for host themes that ask for it). */
function renderChips(group: TokenGroup, el: Element): string {
  const atDefault = matchToken(el, group) === null;
  const chips = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, el);
      return `<button type="button" class="ef-token-chip${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-pressed="${on}" title="${escapeHtml(t.label)}${on ? " — click to unset" : ""}">${swatchHTML(t)}${escapeHtml(t.label)}</button>`;
    })
    .join("");
  return `
      <div class="ef-token-row">
        <button type="button" class="ef-token-chip ef-token-default${atDefault ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-default="1" aria-pressed="${atDefault}" title="Unset (back to the element's own styling)">Default</button>
        ${chips}
        <button type="button" class="ef-custom-toggle" data-group="${escapeHtml(group.id)}" aria-expanded="false" title="Custom class">+ Custom</button>
      </div>
      <div class="ef-custom-field" hidden>${customInputHTML(group)}</div>`;
}

/**
 * Value field: a 24px shell showing the current value, opening the existing
 * `.ef-select-menu`. Swatch groups render their colour inline, like a fill row.
 */
function renderSelect(group: TokenGroup, el: Element): string {
  const cur = matchToken(el, group);
  const atDefault = cur === null;
  const headerSwatch = cur ? swatchHTML(cur) : "";
  const options = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, el);
      return `<li role="option" class="ef-select-option${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-selected="${on}">${swatchHTML(t)}${escapeHtml(t.label)}</li>`;
    })
    .join("");
  return `
      <div class="ef-select" data-group="${escapeHtml(group.id)}">
        <button type="button" class="ef-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${labelID(group)}">
          ${headerSwatch}<span class="ef-select-label">${escapeHtml(currentLabel(group, el))}</span>
          <span class="ef-select-caret" aria-hidden="true">${iconSVG(ICONS["chevron-down"])}</span>
        </button>
        <ul class="ef-select-menu" role="listbox" aria-labelledby="${labelID(group)}" hidden>
          <li role="option" class="ef-select-option ef-select-default${atDefault ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-default="1" aria-selected="${atDefault}">Default</li>
          <li class="ef-select-sep" role="presentation"></li>
          ${options}
          <li class="ef-select-sep" role="presentation"></li>
          <li role="option" class="ef-select-custom" data-group="${escapeHtml(group.id)}" aria-selected="false" tabindex="-1">Custom class…</li>
          <li class="ef-select-custom-edit" role="presentation" hidden>${customInputHTML(group)}</li>
        </ul>
      </div>`;
}

/**
 * Segmented group: intrinsic-width cells with 1px seams, icon-only when the
 * token carries a glyph (the label stays in `title`/`aria-label`). Used for
 * spatial enums — display, direction, wrap, alignment, border style.
 */
function renderSegmented(group: TokenGroup, el: Element): string {
  const cells = group.tokens
    .map((t) => {
      const on = tokenActive(t, group, el);
      const glyph = t.icon
        ? iconSVG(t.icon)
        : `<span class="ef-cell-text">${escapeHtml(t.label)}</span>`;
      return `<button type="button" class="ef-token-chip ef-icon-btn${on ? " ef-token-on" : ""}" data-group="${escapeHtml(group.id)}" data-token="${escapeHtml(t.id)}" aria-pressed="${on}" title="${escapeHtml(t.label)}${on ? " — click to unset" : ""}" aria-label="${escapeHtml(t.label)}">${glyph}</button>`;
    })
    .join("");
  return `<div class="ef-segmented" role="group" aria-label="${escapeHtml(group.label)}">${cells}</div>`;
}

/** One field: label above, control below. */
function renderField(group: TokenGroup, el: Element, half: boolean): string {
  const control =
    group.render === "icons"
      ? renderSegmented(group, el)
      : group.render === "chips"
        ? renderChips(group, el)
        : renderSelect(group, el);
  const isSet = matchToken(el, group) !== null;
  const cls = [
    "ef-prop-row",
    half ? "ef-prop-row--half" : "",
    isSet ? "ef-is-set" : "",
    group.render === "icons" ? "ef-prop-row--segmented" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
      <div class="${cls}" data-group="${escapeHtml(group.id)}">
        ${fieldHeadHTML(group, group.render !== "chips")}
        <div class="ef-prop-control">${control}</div>
      </div>`;
}

/** Lay a section's fields out in rows, pulling paired fields together. */
function renderSectionBody(groups: TokenGroup[], el: Element): string {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const used = new Set<string>();
  const rows: string[] = [];
  for (const g of groups) {
    if (used.has(g.id)) continue;
    used.add(g.id);
    const partnerId = PAIR_OF.get(g.id);
    const partner = partnerId && !used.has(partnerId) ? byId.get(partnerId) : undefined;
    if (partner) {
      used.add(partner.id);
      rows.push(renderField(g, el, true), renderField(partner, el, true));
    } else {
      rows.push(renderField(g, el, false));
    }
  }
  return rows.join("");
}

function renderSection(section: string, groups: TokenGroup[], el: Element): string {
  const collapsed = collapsedSections.has(section);
  const canReset = groups.some((g) => matchToken(el, g) !== null);
  return `
    <section class="ef-style-section${collapsed ? " ef-section-collapsed" : ""}" data-section="${escapeHtml(section)}">
      <div class="ef-section-head">
        <button type="button" class="ef-section-toggle" aria-expanded="${!collapsed}">
          <span class="ef-section-chevron" aria-hidden="true">${iconSVG(ICONS["chevron-right"])}</span>
          <span class="ef-section-title">${escapeHtml(section)}</span>
        </button>
        <button type="button" class="ef-section-reset" data-section-reset="${escapeHtml(section)}" aria-label="Reset ${escapeHtml(section)}" title="Reset every setting in ${escapeHtml(section)}"${canReset ? "" : " disabled"}>${iconSVG(ICONS.unset)}</button>
      </div>
      <div class="ef-section-body">
        ${renderSectionBody(groups, el)}
      </div>
    </section>`;
}

function renderSections(groups: TokenGroup[], el: Element): string {
  return groupBySection(groups)
    .map(({ section, groups: sectionGroups }) => renderSection(section, sectionGroups, el))
    .join("");
}

/** "Current classes" for the active element only, as a collapsed section row. */
function renderClasses(target: TargetEntry): string {
  const classes = Array.from(target.el.classList ?? []).join(" ");
  return `
    <details class="ef-style-classes">
      <summary>
        <span class="ef-section-chevron" aria-hidden="true">${iconSVG(ICONS["chevron-right"])}</span>
        <span class="ef-section-title">Current classes</span>
      </summary>
      <div class="ef-style-class-list">
        <div class="ef-style-class-item"><code>${classes ? escapeHtml(classes) : "(no classes)"}</code></div>
      </div>
    </details>`;
}

/**
 * Direct-text row. Only rendered when the element has exactly one
 * non-whitespace direct text child — replacing text for mixed inline markup
 * would collapse the element's children, and elements whose text lives in
 * descendants are edited through those descendants instead.
 */
function renderTextRow(target: TargetEntry): string {
  const text = getEditableText(target.el);
  if (text === null) return "";
  const changed = hasTextChangeFor(target.el);
  return `
      <div class="ef-prop-row ef-text-row" data-group="text">
        <div class="ef-prop-head">
          <span class="ef-prop-label" title="The element's direct text content">Text</span>
          <button type="button" class="ef-prop-reset ef-text-reset" title="Restore the original text"${changed ? "" : " hidden"}>${iconSVG(ICONS.unset)}</button>
        </div>
        <div class="ef-prop-control">
          <input type="text" class="ef-text-input" value="${escapeHtml(text)}" spellcheck="false" autocomplete="off" aria-label="Text content">
        </div>
      </div>`;
}

interface EditorRenderOptions {
  hiddenCount: number;
  hiddenReasons: string;
  showAll: boolean;
}

/** Distinct human-readable reasons for a list of hidden groups, joined by ", ".
 * Capped at two reasons to keep the footer to a single line; any more are
 * collapsed into a trailing ellipsis. */
function hiddenReasons(groups: TokenGroup[]): string {
  const seen = new Set<string>();
  for (const g of groups) {
    if (g.requires === undefined) continue;
    const list = Array.isArray(g.requires) ? g.requires : [g.requires];
    for (const r of list) seen.add(describeRequirement(r));
  }
  const reasons = Array.from(seen);
  if (reasons.length <= 2) return reasons.join(", ");
  return `${reasons.slice(0, 2).join(", ")}, …`;
}

/** Footer hint: N hidden settings + a Show all / Hide inapplicable toggle. */
function hiddenNoteHTML(opts: EditorRenderOptions): string {
  if (opts.showAll) {
    return `
    <div class="ef-style-hidden-note">
      <span class="ef-hidden-reasons" role="status">Showing all settings — some have no effect on this element</span>
      <button type="button" class="ef-show-all" id="__ef_show_all__" aria-pressed="true">Hide inapplicable</button>
    </div>`;
  }
  if (opts.hiddenCount === 0) return "";
  const noun = opts.hiddenCount === 1 ? "setting" : "settings";
  return `
    <div class="ef-style-hidden-note">
      <span class="ef-hidden-reasons" role="status">${opts.hiddenCount} ${noun} hidden — ${escapeHtml(opts.hiddenReasons)}</span>
      <button type="button" class="ef-show-all" id="__ef_show_all__" aria-pressed="false">Show all</button>
    </div>`;
}

function renderEditorHTML(
  groups: TokenGroup[],
  target: TargetEntry,
  changesCount: number,
  opts: EditorRenderOptions
): string {
  const label = target.dataComponent || target.selector;
  return `
    <div class="ef-style-editor" data-changes="${changesCount}">
      <div class="ef-style-head">
        <span class="ef-style-target-label">Editing</span>
        <code class="ef-style-target-sel" title="${escapeHtml(target.selector)}">${escapeHtml(label)}</code>
      </div>
      <div class="ef-style-context" title="Drag the element on the page to move it">
        <span class="ef-prop-label">In context</span>
        <span class="ef-style-position">${escapeHtml(describePosition(target.el))}</span>
        <span class="ef-style-drag-hint" aria-hidden="true">drag to move</span>
      </div>
      ${renderTextRow(target)}
      ${renderSections(groups, target.el)}
      ${hiddenNoteHTML(opts)}
      ${renderClasses(target)}
    </div>`;
}

/** Wire the value-field menus: one open at a time, keyboard + outside-click close. */
function wireDropdowns(
  root: HTMLElement,
  groups: TokenGroup[],
  el: Element,
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
        const gid = opt.dataset.group ?? "";
        const group = groups.find((g) => g.id === gid);
        // "Default" — back to the element's own styling.
        if (opt.dataset.default) {
          close(menu);
          if (group) cb.onClear(group);
          return;
        }
        if (opt.classList.contains("ef-select-custom")) {
          const edit = menu.querySelector<HTMLElement>(".ef-select-custom-edit");
          const input = edit?.querySelector<HTMLInputElement>(".ef-custom-input");
          if (edit && input) {
            edit.hidden = false;
            input.focus();
          }
          return;
        }
        const tid = opt.dataset.token ?? "";
        const token = group?.tokens.find((t) => t.id === tid);
        close(menu);
        if (!group || !token) return;
        // Choosing the option that is already applied unsets the group, exactly
        // like clicking an active cell (and like the Default item).
        if (tokenActive(token, group, el)) cb.onClear(group);
        else cb.onApply(group, token);
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

/** Section headers: collapse/expand, persisted across re-mounts. */
function wireSections(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".ef-section-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sec = btn.closest<HTMLElement>(".ef-style-section");
      const name = sec?.dataset.section;
      if (!sec || !name) return;
      const collapsed = sec.classList.toggle("ef-section-collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (collapsed) collapsedSections.add(name);
      else collapsedSections.delete(name);
    });
  });
}

/**
 * Per-field + per-section reset. A section reset clears every group in it that
 * currently carries an overlay value, so one click drops the whole block back to
 * the page's own styling.
 */
function wireResets(
  root: HTMLElement,
  groups: TokenGroup[],
  el: Element,
  cb: StyleEditorCallbacks
): void {
  root.querySelectorAll<HTMLButtonElement>(".ef-prop-reset[data-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = groups.find((g) => g.id === btn.dataset.group);
      if (group) cb.onClear(group);
    });
  });
  root.querySelectorAll<HTMLButtonElement>(".ef-section-reset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.sectionReset;
      if (!name) return;
      const section = groupBySection(groups).find((s) => s.section === name);
      if (!section) return;
      // Collect first: each onClear re-renders the editor and replaces the DOM
      // this handler was attached to.
      const applied = section.groups.filter((g) => matchToken(el, g) !== null);
      for (const g of applied) cb.onClear(g);
    });
  });
}

function wireTextRow(root: HTMLElement, el: Element, cb: StyleEditorCallbacks): void {
  const input = root.querySelector<HTMLInputElement>(".ef-text-input");
  if (!input) return;
  const reset = root.querySelector<HTMLButtonElement>(".ef-text-reset");

  input.addEventListener("input", () => {
    cb.onTextInput(input.value);
    if (reset) reset.hidden = !hasTextChangeFor(el);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
      return;
    }
    if (e.key === "Escape") {
      // Keep Escape from reaching the dialog's close handler while editing.
      e.stopPropagation();
      input.blur();
    }
  });
  // `change` fires on blur (value changed). The commit callback defers its
  // re-render so the click that caused the blur still lands.
  input.addEventListener("change", () => cb.onTextCommit());
  reset?.addEventListener("click", () => cb.onTextReset());
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
    root.innerHTML = `<div class="ef-style-empty">Select an element to edit layout, spacing and colors.</div>`;
    return;
  }

  const all = augmentGroups(tokens.groups);
  const visible = showAllGroups
    ? all
    : visibleGroups(all, target.el, {
        isApplied: (g) => matchToken(target.el, g) !== null,
      });
  const hidden = showAllGroups ? [] : all.filter((g) => !visible.includes(g));
  const groups = showAllGroups ? all : visible;

  const opts: EditorRenderOptions = {
    hiddenCount: hidden.length,
    hiddenReasons: hiddenReasons(hidden),
    showAll: showAllGroups,
  };

  root.innerHTML = renderEditorHTML(groups, target, changesCount, opts);

  // Chip/icon row wiring (dropdowns have their own handlers below). Segmented
  // cells reuse `.ef-token-chip`, so they share this wiring: an active control
  // unselects the group, anything else applies it.
  root
    .querySelectorAll<HTMLButtonElement>(".ef-token-chip[data-token], .ef-token-chip[data-default]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const gid = btn.dataset.group ?? "";
        const group = groups.find((g) => g.id === gid);
        if (!group) return;
        if (btn.dataset.default) {
          cb.onClear(group);
          return;
        }
        const tid = btn.dataset.token ?? "";
        const token = group.tokens.find((t) => t.id === tid);
        if (!token) return;
        // Clicking the active control unselects it — back to the element's own
        // styling, the same thing the reset control does.
        if (tokenActive(token, group, target.el)) cb.onClear(group);
        else cb.onApply(group, token);
      });
    });

  wireDropdowns(root, groups, target.el, cb);
  wireCustomToggles(root);
  wireCustomInputs(root, tokens, cb);
  wireTextRow(root, target.el, cb);
  wireSections(root);
  wireResets(root, groups, target.el, cb);

  // "Show all" / "Hide inapplicable" toggle: flips the module-level flag and
  // re-renders so the filtered/unfiltered group list is rebuilt.
  root.querySelector<HTMLButtonElement>("#__ef_show_all__")?.addEventListener("click", () => {
    showAllGroups = !showAllGroups;
    cb.onRerender();
  });

  // Hovering the "Editing <target>" label outlines the element, matching the
  // per-target tab hover in the dialog (there is no permanent outline).
  const head = root.querySelector<HTMLElement>(".ef-style-target-sel");
  if (head) {
    head.addEventListener("mouseenter", () => setHighlight(target.el));
    head.addEventListener("mouseleave", () => setHighlight(null));
  }
}
