// tokens.ts — project theme tokens for the live style editor.
//
// The host project can expose a theme-token endpoint via `data-theme-url`. The
// JSON maps design tokens to CSS classes (default) or inline styles. Everything
// is validated + normalized before use — the overlay never injects raw strings
// from the endpoint as HTML, and never applies an unbounded CSS value.

/** How a single token is applied to an element. */
export interface Apply {
  type: "class" | "style";
  /** For style applies. */
  prop?: string;
  /** For style applies. */
  value?: string;
}

/** A single selectable token within a group. */
export interface Token {
  id: string;
  label: string;
  /** For class applies (also the default when no `apply` is present). */
  className?: string;
  /** Per-token override of the group's applyType. */
  apply?: Apply;
  /** Optional CSS color used to render a swatch. */
  swatch?: string;
}

/** A group of mutually-exclusive tokens (e.g. padding, text color). */
export interface TokenGroup {
  id: string;
  label: string;
  /** Default apply mechanism for the group's tokens. */
  applyType: "class" | "style";
  /**
   * Safe regex source used to strip the previous token's class(es) from an
   * element before applying a new one.
   */
  removePattern?: string;
  tokens: Token[];
  /** Preferred editor rendering. Defaults to "chips". */
  render?: "chips" | "dropdown";
  /** Editor section heading. Defaults to "Style" when unset. */
  section?: string;
}

/** Normalized theme-token set. */
export interface ThemeTokens {
  version: number;
  groups: TokenGroup[];
  /** Where the tokens came from (for diagnostics). */
  source: "endpoint" | "fallback";
}

/** Minimal config shape this module needs (avoids a circular import). */
export interface TokenSourceConfig {
  themeUrl?: string;
}

// ── Validation constants ──────────────────────────────────────────────────────

/** A CSS class name may not contain whitespace, punctuation or escapes. */
const CLASS_RE = /^[A-Za-z0-9_-]+$/;

/** Inline style props we are willing to set. */
const STYLE_PROPS = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "color",
  "background-color",
  "background",
  "border-radius",
]);

const MAX_STYLE_VALUE = 120;
const MAX_SWATCH = 120;

/** Style values containing any of these are rejected outright. */
const UNSAFE_VALUE =
  /url\s*\(|;|expression|javascript:|image-set\s*\(|-webkit-image-set\s*\(|element\s*\(|-moz-element\s*\(/i;

/**
 * A swatch is only ever used as a CSS `background` value, so it is held to the
 * same bar as a style value: reject function/exfiltration-ish payloads and
 * anything that could break out of the declaration.
 */
function safeSwatch(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v || v.length > MAX_SWATCH) return undefined;
  if (/[;\n\r]|url\s*\(|image-set\s*\(|element\s*\(/i.test(v)) return undefined;
  return v;
}

/**
 * Compile a `removePattern` from a deliberately small, linear subset. Groups,
 * alternation, backreferences and escapes are rejected so a hostile pattern
 * cannot cause catastrophic backtracking or surprising matches.
 */
function safeRemovePattern(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) {
    return undefined;
  }
  if (/[(){}|\\]/.test(pattern)) return undefined; // no groups / alternation / escapes
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function normalizeApply(raw: unknown, groupApplyType: "class" | "style"): Apply | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type === undefined ? groupApplyType : r.type;
  if (type !== "class" && type !== "style") return null;
  if (type === "class") return { type: "class" };

  const prop = typeof r.prop === "string" ? r.prop : "";
  if (!STYLE_PROPS.has(prop)) return null;
  const value = typeof r.value === "string" ? r.value : "";
  if (!value || value.length > MAX_STYLE_VALUE) return null;
  if (UNSAFE_VALUE.test(value)) return null;
  return { type: "style", prop, value };
}

function normalizeToken(raw: unknown, groupApplyType: "class" | "style"): Token | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;

  const id = typeof t.id === "string" && t.id ? t.id : "";
  if (!id) return null;
  const label = typeof t.label === "string" && t.label ? t.label : id;

  let className: string | undefined;
  if (t.className !== undefined) {
    if (typeof t.className !== "string" || !CLASS_RE.test(t.className)) return null;
    className = t.className;
  }

  let apply: Apply | undefined;
  if (t.apply !== undefined) {
    const a = normalizeApply(t.apply, groupApplyType);
    if (!a) return null;
    apply = a;
  }

  // A token must be applicable: it needs a class name for the class path, or a
  // validated style apply.
  const effectiveType = apply ? apply.type : groupApplyType;
  if (effectiveType === "class" && !className) return null;
  if (!apply && !className) return null;

  const swatch = safeSwatch(t.swatch);

  return {
    id,
    label,
    ...(className !== undefined ? { className } : {}),
    ...(apply !== undefined ? { apply } : {}),
    ...(swatch !== undefined ? { swatch } : {}),
  };
}

/**
 * Validate + normalize a raw theme payload. Returns null when the payload is
 * unusable (wrong shape/version or no valid groups). Invalid tokens and groups
 * are dropped rather than failing the whole set.
 */
export function normalizeTheme(raw: unknown): ThemeTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (!Array.isArray(r.groups)) return null;

  const groups: TokenGroup[] = [];

  for (const g of r.groups) {
    if (!g || typeof g !== "object") continue;
    const gg = g as Record<string, unknown>;

    const id = typeof gg.id === "string" && gg.id ? gg.id : "";
    if (!id) continue;
    const label = typeof gg.label === "string" && gg.label ? gg.label : id;

    let applyType: "class" | "style" = "class";
    if (gg.applyType !== undefined) {
      if (gg.applyType !== "class" && gg.applyType !== "style") continue;
      applyType = gg.applyType;
    }

    let removePattern: string | undefined;
    // An empty string means "no pattern" — keep the group; only an explicitly
    // invalid (non-empty) pattern rejects it.
    if (gg.removePattern !== undefined && gg.removePattern !== "") {
      const compiled = safeRemovePattern(gg.removePattern);
      if (!compiled) continue; // explicit but invalid pattern → reject the group
      removePattern = gg.removePattern as string;
    }

    const render: "chips" | "dropdown" | undefined =
      gg.render === "chips" || gg.render === "dropdown" ? gg.render : undefined;

    const section: string | undefined =
      typeof gg.section === "string" && gg.section ? gg.section : undefined;

    const tokens: Token[] = [];
    if (Array.isArray(gg.tokens)) {
      for (const t of gg.tokens) {
        const nt = normalizeToken(t, applyType);
        if (nt) tokens.push(nt);
      }
    }
    if (tokens.length === 0) continue;

    groups.push({
      id,
      label,
      applyType,
      ...(removePattern !== undefined ? { removePattern } : {}),
      ...(render !== undefined ? { render } : {}),
      ...(section !== undefined ? { section } : {}),
      tokens,
    });
  }

  if (groups.length === 0) return null;
  return { version: 1, groups, source: "endpoint" };
}

// ── Fallback tokens ───────────────────────────────────────────────────────────

const COLOR_VARS: { id: string; label: string; cssVar: string }[] = [
  { id: "primary", label: "Primary", cssVar: "--color-primary" },
  { id: "secondary", label: "Secondary", cssVar: "--color-secondary" },
  { id: "accent", label: "Accent", cssVar: "--color-accent" },
  { id: "neutral", label: "Neutral", cssVar: "--color-neutral" },
  { id: "info", label: "Info", cssVar: "--color-info" },
  { id: "success", label: "Success", cssVar: "--color-success" },
  { id: "warning", label: "Warning", cssVar: "--color-warning" },
  { id: "error", label: "Error", cssVar: "--color-error" },
];

function readCssVar(name: string): string {
  try {
    if (typeof document === "undefined" || !document.documentElement) return "";
    const cs = getComputedStyle(document.documentElement);
    return (cs.getPropertyValue(name) || "").trim();
  } catch {
    return "";
  }
}

/** Built-in daisyUI-ish token set used when no theme endpoint is configured. */
export function buildFallbackTokens(): ThemeTokens {
  const textTokens: Token[] = [
    {
      id: "base",
      label: "Default",
      className: "text-base-content",
      swatch: readCssVar("--color-base-content") || "var(--color-base-content)",
    },
  ];
  const bgTokens: Token[] = [
    { id: "base-100", label: "Base", className: "bg-base-100", swatch: readCssVar("--color-base-100") || "var(--color-base-100)" },
    { id: "base-200", label: "Base 2", className: "bg-base-200", swatch: readCssVar("--color-base-200") || "var(--color-base-200)" },
    { id: "base-300", label: "Base 3", className: "bg-base-300", swatch: readCssVar("--color-base-300") || "var(--color-base-300)" },
  ];

  for (const c of COLOR_VARS) {
    const resolved = readCssVar(c.cssVar);
    const swatch = resolved || `var(${c.cssVar})`;
    textTokens.push({ id: c.id, label: c.label, className: `text-${c.id}`, swatch });
    bgTokens.push({ id: c.id, label: c.label, className: `bg-${c.id}`, swatch });
  }

  return {
    version: 1,
    source: "fallback",
    groups: [
      {
        id: "padding",
        label: "Padding",
        section: "Spacing",
        render: "dropdown",
        applyType: "class",
        removePattern: "^p[xytrbl]?-",
        tokens: [
          { id: "none", label: "None", className: "p-0" },
          { id: "xs", label: "X-Small", className: "p-1" },
          { id: "sm", label: "Small", className: "p-2" },
          { id: "md", label: "Medium", className: "p-4" },
          { id: "lg", label: "Large", className: "p-6" },
          { id: "xl", label: "X-Large", className: "p-8" },
        ],
      },
      {
        id: "margin",
        label: "Margin",
        section: "Spacing",
        render: "dropdown",
        applyType: "class",
        removePattern: "^m[xytrbl]?-",
        tokens: [
          { id: "none", label: "None", className: "m-0" },
          { id: "xs", label: "X-Small", className: "m-1" },
          { id: "sm", label: "Small", className: "m-2" },
          { id: "md", label: "Medium", className: "m-4" },
          { id: "lg", label: "Large", className: "m-6" },
          { id: "xl", label: "X-Large", className: "m-8" },
        ],
      },
      {
        id: "gap",
        label: "Gap",
        section: "Spacing",
        render: "dropdown",
        applyType: "class",
        removePattern: "^gap-",
        tokens: [
          { id: "none", label: "None", className: "gap-0" },
          { id: "xs", label: "X-Small", className: "gap-1" },
          { id: "sm", label: "Small", className: "gap-2" },
          { id: "md", label: "Medium", className: "gap-3" },
          { id: "lg", label: "Large", className: "gap-4" },
          { id: "xl", label: "X-Large", className: "gap-6" },
          { id: "2xl", label: "2X-Large", className: "gap-8" },
        ],
      },
      {
        id: "maxWidth",
        label: "Max width",
        section: "Layout",
        render: "dropdown",
        applyType: "class",
        removePattern: "^max-w-",
        tokens: [
          { id: "none", label: "None", className: "max-w-none" },
          { id: "xs", label: "X-Small", className: "max-w-xs" },
          { id: "sm", label: "Small", className: "max-w-sm" },
          { id: "md", label: "Medium", className: "max-w-md" },
          { id: "lg", label: "Large", className: "max-w-lg" },
          { id: "xl", label: "X-Large", className: "max-w-xl" },
          { id: "2xl", label: "2X-Large", className: "max-w-2xl" },
          { id: "3xl", label: "3X-Large", className: "max-w-3xl" },
          { id: "4xl", label: "4X-Large", className: "max-w-4xl" },
          { id: "5xl", label: "5X-Large", className: "max-w-5xl" },
          { id: "6xl", label: "6X-Large", className: "max-w-6xl" },
          { id: "7xl", label: "7X-Large", className: "max-w-7xl" },
          { id: "prose", label: "Prose", className: "max-w-prose" },
          { id: "full", label: "Full", className: "max-w-full" },
        ],
      },
      {
        id: "width",
        label: "Width",
        section: "Layout",
        render: "dropdown",
        applyType: "class",
        removePattern: "^w-",
        tokens: [
          { id: "auto", label: "Auto", className: "w-auto" },
          { id: "full", label: "Full", className: "w-full" },
          { id: "screen", label: "Screen", className: "w-screen" },
          { id: "fit", label: "Fit", className: "w-fit" },
          { id: "min", label: "Min", className: "w-min" },
          { id: "max", label: "Max", className: "w-max" },
        ],
      },
      {
        id: "height",
        label: "Height",
        section: "Layout",
        render: "dropdown",
        applyType: "class",
        removePattern: "^h-",
        tokens: [
          { id: "auto", label: "Auto", className: "h-auto" },
          { id: "full", label: "Full", className: "h-full" },
          { id: "screen", label: "Screen", className: "h-screen" },
          { id: "fit", label: "Fit", className: "h-fit" },
        ],
      },
      {
        id: "display",
        label: "Display",
        section: "Layout",
        applyType: "class",
        tokens: [
          { id: "block", label: "Block", className: "block" },
          { id: "inline", label: "Inline", className: "inline" },
          { id: "inline-block", label: "Inline block", className: "inline-block" },
          { id: "flex", label: "Flex", className: "flex" },
          { id: "inline-flex", label: "Inline flex", className: "inline-flex" },
          { id: "grid", label: "Grid", className: "grid" },
          { id: "hidden", label: "Hidden", className: "hidden" },
        ],
      },
      {
        id: "align",
        label: "Align items",
        section: "Layout",
        applyType: "class",
        removePattern: "^items-",
        tokens: [
          { id: "start", label: "Start", className: "items-start" },
          { id: "center", label: "Center", className: "items-center" },
          { id: "end", label: "End", className: "items-end" },
          { id: "stretch", label: "Stretch", className: "items-stretch" },
          { id: "baseline", label: "Baseline", className: "items-baseline" },
        ],
      },
      {
        id: "justify",
        label: "Justify",
        section: "Layout",
        applyType: "class",
        tokens: [
          { id: "start", label: "Start", className: "justify-start" },
          { id: "center", label: "Center", className: "justify-center" },
          { id: "end", label: "End", className: "justify-end" },
          { id: "between", label: "Between", className: "justify-between" },
          { id: "around", label: "Around", className: "justify-around" },
          { id: "evenly", label: "Evenly", className: "justify-evenly" },
        ],
      },
      {
        id: "flexDir",
        label: "Flex direction",
        section: "Layout",
        applyType: "class",
        tokens: [
          { id: "row", label: "Row", className: "flex-row" },
          { id: "row-reverse", label: "Row reverse", className: "flex-row-reverse" },
          { id: "col", label: "Col", className: "flex-col" },
          { id: "col-reverse", label: "Col reverse", className: "flex-col-reverse" },
        ],
      },
      {
        id: "textSize",
        label: "Text size",
        section: "Typography",
        applyType: "class",
        tokens: [
          { id: "xs", label: "X-Small", className: "text-xs" },
          { id: "sm", label: "Small", className: "text-sm" },
          { id: "base", label: "Base", className: "text-base" },
          { id: "lg", label: "Large", className: "text-lg" },
          { id: "xl", label: "X-Large", className: "text-xl" },
          { id: "2xl", label: "2X-Large", className: "text-2xl" },
          { id: "3xl", label: "3X-Large", className: "text-3xl" },
          { id: "4xl", label: "4X-Large", className: "text-4xl" },
        ],
      },
      {
        id: "fontWeight",
        label: "Font weight",
        section: "Typography",
        applyType: "class",
        tokens: [
          { id: "thin", label: "Thin", className: "font-thin" },
          { id: "extralight", label: "Extra light", className: "font-extralight" },
          { id: "light", label: "Light", className: "font-light" },
          { id: "normal", label: "Normal", className: "font-normal" },
          { id: "medium", label: "Medium", className: "font-medium" },
          { id: "semibold", label: "Semibold", className: "font-semibold" },
          { id: "bold", label: "Bold", className: "font-bold" },
          { id: "extrabold", label: "Extra bold", className: "font-extrabold" },
          { id: "black", label: "Black", className: "font-black" },
        ],
      },
      {
        id: "textColor",
        label: "Text color",
        section: "Color",
        render: "dropdown",
        applyType: "class",
        tokens: textTokens,
      },
      {
        id: "backgroundColor",
        label: "Background",
        section: "Color",
        render: "dropdown",
        applyType: "class",
        tokens: bgTokens,
      },
      {
        id: "rounded",
        label: "Rounded",
        section: "Borders & Effects",
        applyType: "class",
        tokens: [
          { id: "none", label: "None", className: "rounded-none" },
          { id: "sm", label: "Small", className: "rounded-sm" },
          { id: "md", label: "Medium", className: "rounded-md" },
          { id: "lg", label: "Large", className: "rounded-lg" },
          { id: "xl", label: "X-Large", className: "rounded-xl" },
          { id: "2xl", label: "2X-Large", className: "rounded-2xl" },
          { id: "3xl", label: "3X-Large", className: "rounded-3xl" },
          { id: "full", label: "Full", className: "rounded-full" },
        ],
      },
      {
        id: "borderWidth",
        label: "Border width",
        section: "Borders & Effects",
        applyType: "class",
        removePattern: "^border-[0-9]",
        tokens: [
          { id: "none", label: "None", className: "border-0" },
          { id: "2px", label: "2px", className: "border-2" },
          { id: "4px", label: "4px", className: "border-4" },
          { id: "8px", label: "8px", className: "border-8" },
        ],
      },
      {
        id: "borderStyle",
        label: "Border style",
        section: "Borders & Effects",
        applyType: "class",
        tokens: [
          { id: "solid", label: "Solid", className: "border-solid" },
          { id: "dashed", label: "Dashed", className: "border-dashed" },
          { id: "dotted", label: "Dotted", className: "border-dotted" },
        ],
      },
      {
        id: "shadow",
        label: "Shadow",
        section: "Borders & Effects",
        applyType: "class",
        tokens: [
          { id: "none", label: "None", className: "shadow-none" },
          { id: "sm", label: "Small", className: "shadow-sm" },
          { id: "md", label: "Medium", className: "shadow-md" },
          { id: "lg", label: "Large", className: "shadow-lg" },
          { id: "xl", label: "X-Large", className: "shadow-xl" },
          { id: "2xl", label: "2X-Large", className: "shadow-2xl" },
        ],
      },
      {
        id: "btnColor",
        label: "Button color",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "primary", label: "Primary", className: "btn-primary" },
          { id: "secondary", label: "Secondary", className: "btn-secondary" },
          { id: "accent", label: "Accent", className: "btn-accent" },
          { id: "info", label: "Info", className: "btn-info" },
          { id: "success", label: "Success", className: "btn-success" },
          { id: "warning", label: "Warning", className: "btn-warning" },
          { id: "error", label: "Error", className: "btn-error" },
        ],
      },
      {
        id: "btnModifier",
        label: "Button modifier",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "ghost", label: "Ghost", className: "btn-ghost" },
          { id: "outline", label: "Outline", className: "btn-outline" },
          { id: "link", label: "Link", className: "btn-link" },
        ],
      },
      {
        id: "btnSize",
        label: "Button size",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "xs", label: "X-Small", className: "btn-xs" },
          { id: "sm", label: "Small", className: "btn-sm" },
          { id: "md", label: "Medium", className: "btn-md" },
          { id: "lg", label: "Large", className: "btn-lg" },
          { id: "xl", label: "X-Large", className: "btn-xl" },
        ],
      },
      {
        id: "badgeColor",
        label: "Badge color",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "primary", label: "Primary", className: "badge-primary" },
          { id: "secondary", label: "Secondary", className: "badge-secondary" },
          { id: "accent", label: "Accent", className: "badge-accent" },
          { id: "info", label: "Info", className: "badge-info" },
          { id: "success", label: "Success", className: "badge-success" },
          { id: "warning", label: "Warning", className: "badge-warning" },
          { id: "error", label: "Error", className: "badge-error" },
          { id: "neutral", label: "Neutral", className: "badge-neutral" },
        ],
      },
      {
        id: "badgeModifier",
        label: "Badge modifier",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "ghost", label: "Ghost", className: "badge-ghost" },
          { id: "outline", label: "Outline", className: "badge-outline" },
        ],
      },
      {
        id: "badgeSize",
        label: "Badge size",
        section: "daisyUI",
        applyType: "class",
        tokens: [
          { id: "xs", label: "X-Small", className: "badge-xs" },
          { id: "sm", label: "Small", className: "badge-sm" },
          { id: "md", label: "Medium", className: "badge-md" },
          { id: "lg", label: "Large", className: "badge-lg" },
        ],
      },
    ],
  };
}

/**
 * Build a runtime token for a user-typed Tailwind/daisyUI class.
 * Single class only; returns null when empty, too long, or not a valid
 * class token (whitespace/punctuation rejected). id is `custom:<class>`.
 */
export function makeCustomToken(raw: string): Token | null {
  const cls = raw.trim();
  if (!cls || cls.length > 80) return null;
  if (!CLASS_RE.test(cls)) return null;
  return { id: `custom:${cls}`, label: cls, className: cls };
}

// ── Loading (fetch + cache) ───────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5000;

let cache: ThemeTokens | null = null;
let pending: Promise<ThemeTokens> | null = null;

/** Reset the in-memory cache. Test hook. */
export function clearTokenCache(): void {
  cache = null;
  pending = null;
}

async function fetchTheme(url: string): Promise<ThemeTokens | null> {
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl
      ? setTimeout(() => {
          try { ctrl.abort(); } catch { /* ignore */ }
        }, FETCH_TIMEOUT_MS)
      : null;
    try {
      const res = await fetch(url, {
        ...(ctrl ? { signal: ctrl.signal } : {}),
        credentials: "omit",
      });
      if (!res || !res.ok) return null;
      const raw = await res.json();
      return normalizeTheme(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    // Network error, timeout, abort, bad JSON — never throw into the UI.
    return null;
  }
}

/**
 * Load the theme token set once and cache it in memory. Falls back to the
 * built-in daisyUI token set when `themeUrl` is absent or unreachable. Never
 * throws and never blocks the caller indefinitely (5s fetch timeout).
 */
export async function loadTokens(config: TokenSourceConfig | undefined): Promise<ThemeTokens> {
  if (cache) return cache;
  if (pending) return pending;

  pending = (async (): Promise<ThemeTokens> => {
    if (config?.themeUrl) {
      const fetched = await fetchTheme(config.themeUrl);
      if (fetched) {
        cache = fetched;
        return cache;
      }
    }
    cache = buildFallbackTokens();
    return cache;
  })();

  return pending;
}

// ── Apply / match / revert ────────────────────────────────────────────────────

type EffectiveApply =
  | { type: "class"; className: string }
  | { type: "style"; prop: string; value: string };

/** Resolve the concrete application for a token within its group. */
export function resolveApply(group: TokenGroup, token: Token): EffectiveApply {
  if (token.apply) {
    if (token.apply.type === "style") {
      return { type: "style", prop: token.apply.prop ?? "", value: token.apply.value ?? "" };
    }
    return { type: "class", className: token.className ?? "" };
  }
  return { type: "class", className: token.className ?? "" };
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  return (el as HTMLElement).style ?? null;
}

function removeGroupClasses(el: Element, group: TokenGroup): void {
  const re = group.removePattern ? safeRemovePattern(group.removePattern) : undefined;
  if (re) {
    for (const cls of Array.from(el.classList)) {
      if (re.test(cls)) el.classList.remove(cls);
    }
  }
  // Always drop this group's own class tokens too — covers custom tokens whose
  // class does not match the group pattern (e.g. a typed class in another group).
  for (const t of group.tokens) {
    const a = resolveApply(group, t);
    if (a.type === "class" && a.className) el.classList.remove(a.className);
  }
}

function removeGroupStyles(el: Element, group: TokenGroup): void {
  const style = styleOf(el);
  if (!style) return;
  for (const t of group.tokens) {
    const a = resolveApply(group, t);
    if (a.type === "style" && a.prop) style.removeProperty(a.prop);
  }
}

/**
 * Find the token in `group` currently applied to `el`, if any. A class token
 * matches when the class is present; a style token matches when the inline
 * style value equals the token's value.
 */
export function matchToken(el: Element, group: TokenGroup): Token | null {
  for (const token of group.tokens) {
    const a = resolveApply(group, token);
    if (a.type === "class") {
      if (a.className && el.classList.contains(a.className)) return token;
    } else {
      const style = styleOf(el);
      const inline = style ? style.getPropertyValue(a.prop).trim() : "";
      if (inline && inline === a.value.trim()) return token;
    }
  }
  return null;
}

function currentState(el: Element, group: TokenGroup, prev: Token | null): string {
  if (prev) {
    const a = resolveApply(group, prev);
    if (a.type === "class") return a.className;
    const style = styleOf(el);
    return style ? style.getPropertyValue(a.prop).trim() : "";
  }
  const re = group.removePattern ? safeRemovePattern(group.removePattern) : undefined;
  if (re) {
    const matched = Array.from(el.classList).filter((c) => re.test(c));
    if (matched.length > 0) return matched.join(" ");
  }
  return "";
}

/**
 * Apply a token to an element: strip the previous token's class(es) (or clear
 * the previously-set inline prop), then add the class / set the style. Returns
 * the before→after strings to record in feedback.
 */
export function applyToken(
  el: Element,
  group: TokenGroup,
  token: Token
): { before: string; after: string } {
  const prev = matchToken(el, group);
  let before = currentState(el, group, prev);
  const next = resolveApply(group, token);

  // For a style apply, capture the element's ACTUAL prior inline value of the
  // prop so a pre-existing inline style isn't lost (and so revert is exact).
  // A prior token's value already equals the inline value, so this is a no-op
  // in that case; when nothing was set we keep the class-based `before`.
  if (next.type === "style") {
    const style = styleOf(el);
    const priorInline = style ? style.getPropertyValue(next.prop).trim() : "";
    if (priorInline) before = priorInline;
  }

  // Clear whichever prior representation the group used, then commit the new one.
  removeGroupClasses(el, group);
  if (next.type === "style") {
    removeGroupStyles(el, group);
    const style = styleOf(el);
    if (style) style.setProperty(next.prop, next.value);
    return { before, after: next.value };
  }

  if (prev) removeGroupStyles(el, group);
  if (next.className) el.classList.add(next.className);
  return { before, after: next.className };
}

/**
 * Restore an element to the state recorded in `change`. Any style props owned
 * by the group are cleared, then `before` is reapplied:
 *   - as a class when it names a class token (or is otherwise class-shaped),
 *   - as an inline value when it names a style token or is an arbitrary inline
 *     value the applied style token overwrote.
 */
export function revertToken(
  el: Element,
  group: TokenGroup,
  change: { before: string; after: string }
): void {
  removeGroupClasses(el, group);
  removeGroupStyles(el, group);

  if (!change.before) return;

  const lookup = (v: string): Token | undefined =>
    group.tokens.find((t) => {
      const a = resolveApply(group, t);
      return a.type === "style" ? a.value === v : a.className === v;
    });

  const beforeToken = lookup(change.before);
  const beforeApply = beforeToken ? resolveApply(group, beforeToken) : null;
  if (beforeApply?.type === "style") {
    styleOf(el)?.setProperty(beforeApply.prop, change.before);
    return;
  }
  if (beforeApply?.type === "class") {
    for (const cls of change.before.split(/\s+/)) {
      if (cls && CLASS_RE.test(cls)) el.classList.add(cls);
    }
    return;
  }

  // `before` is not a known token — e.g. a pre-existing inline value that the
  // applied style token overwrote. Restore it on the applied token's prop.
  const afterToken = lookup(change.after);
  const afterApply = afterToken ? resolveApply(group, afterToken) : null;
  if (afterApply?.type === "style") {
    styleOf(el)?.setProperty(afterApply.prop, change.before);
    return;
  }
  // Default: `before` is a class name (or whitespace-separated list).
  for (const cls of change.before.split(/\s+/)) {
    if (cls && CLASS_RE.test(cls)) el.classList.add(cls);
  }
}
