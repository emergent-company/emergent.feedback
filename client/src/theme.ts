// theme.ts — theme detection + resolution for the injected overlay.
//
// The overlay is injected into arbitrary host pages, so the theme can't be
// assumed. Resolution order:
//   1. explicit config.theme ("light" | "dark") wins;
//   2. "auto" (default) → detect the host page's theme;
//   3. host detection inconclusive → OS prefers-color-scheme.
//
// The resolved value is written to document.documentElement.dataset.efTheme
// (and mirrored onto the overlay roots) so CSS can key off
// [data-ef-theme="dark"]. Light values are the CSS defaults; dark overrides
// the same custom properties.

import type { OverlayConfig } from "./config";

/** Config-level theme preference. `"auto"` follows the host page / OS. */
export type ThemeMode = "light" | "dark" | "auto";
/** Concrete theme actually rendered. */
export type ResolvedTheme = "light" | "dark";

/** Overlay roots that receive a mirrored `data-ef-theme` attribute. */
const ROOT_SELECTORS = [
  "#__ef_dialog__",
  "#__ef_indicator__",
  "#__ef_toast__",
  '[id^="__ef_badge__"]',
] as const;

let current: ResolvedTheme = "light";
let mode: ThemeMode = "auto";
let watching = false;
let mql: MediaQueryList | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<(theme: ResolvedTheme) => void>();

// ── Resolution ────────────────────────────────────────────────────────────────

/** OS preference, independent of the host page. */
function systemTheme(): ResolvedTheme {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // matchMedia can throw in exotic embeddings — fall through.
  }
  return "light";
}

/** Map a daisyUI-ish theme name to a concrete theme, or null if unknown. */
function themeName(value: string | null | undefined): ResolvedTheme | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("dark") || v === "night" || v === "dim" || v === "dracula" || v === "black" || v === "memory") {
    return "dark";
  }
  if (v.includes("light") || v === "nord" || v === "corporate" || v === "emerald" || v === "wireframe") {
    return "light";
  }
  return null;
}

function attrTheme(el: Element | null): ResolvedTheme | null {
  if (!el) return null;
  try {
    return themeName(el.getAttribute("data-theme"));
  } catch {
    return null;
  }
}

function classTheme(el: Element | null): ResolvedTheme | null {
  if (!el) return null;
  try {
    const c = el.classList;
    if (!c) return null;
    if (c.contains("dark") || c.contains("dark-mode") || c.contains("theme-dark")) return "dark";
    if (c.contains("light") || c.contains("light-mode") || c.contains("theme-light")) return "light";
  } catch {
    // classList can be unavailable on odd embeddings.
  }
  return null;
}

/** Parse `color-scheme` (from a meta tag or computed style) to a concrete theme. */
function schemeToken(raw: string | null | undefined): ResolvedTheme | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "normal") return null;
  if (v.includes("only dark")) return "dark";
  if (v.includes("only light")) return "light";
  const tokens = v.split(/\s+/);
  // A multi-value scheme (e.g. "dark light") means the page adapts to the OS,
  // so it is inconclusive here and we defer to prefers-color-scheme.
  if (tokens.length === 1) {
    if (tokens[0] === "dark") return "dark";
    if (tokens[0] === "light") return "light";
  }
  return null;
}

function colorSchemeTheme(html: Element | null, body: Element | null): ResolvedTheme | null {
  try {
    const meta = document.querySelector?.('meta[name="color-scheme"]');
    const fromMeta = schemeToken(meta?.getAttribute("content"));
    if (fromMeta) return fromMeta;
  } catch {
    // ignore
  }
  for (const el of [html, body]) {
    if (!el) continue;
    try {
      const cs = window.getComputedStyle(el);
      const fromComputed = schemeToken(cs?.getPropertyValue?.("color-scheme"));
      if (fromComputed) return fromComputed;
    } catch {
      // ignore
    }
  }
  return null;
}

function parseRgb(value: string | null | undefined): [number, number, number, number] | null {
  if (!value) return null;
  const m = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || !parts.slice(0, 3).every((n) => Number.isFinite(n))) return null;
  const alpha = Number.isFinite(parts[3]) ? parts[3] : 1;
  return [parts[0], parts[1], parts[2], alpha];
}

/** Detect the host page background luminance of <html>/<body>. */
function backgroundTheme(html: Element | null, body: Element | null): ResolvedTheme | null {
  for (const el of [html, body]) {
    if (!el) continue;
    let bg: string | undefined;
    try {
      bg = window.getComputedStyle(el)?.backgroundColor;
    } catch {
      bg = undefined;
    }
    const rgb = parseRgb(bg);
    if (!rgb) continue;
    const [r, g, b, a] = rgb;
    if (a <= 0.1) continue; // transparent surface — not a signal
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (luminance <= 0.42) return "dark";
    if (luminance >= 0.6) return "light";
    // Mid-range background is ambiguous — keep checking, then fall back.
  }
  return null;
}

/**
 * Inspect the host document for a theme signal. Returns null when the host is
 * inconclusive so callers can fall back to the OS preference.
 */
function detectHostTheme(): ResolvedTheme | null {
  try {
    const html = typeof document !== "undefined" ? document.documentElement : null;
    const body = typeof document !== "undefined" ? document.body : null;

    return (
      attrTheme(html) ??
      attrTheme(body) ??
      classTheme(html) ??
      classTheme(body) ??
      colorSchemeTheme(html, body) ??
      backgroundTheme(html, body)
    );
  } catch {
    // Host CSS/DOM can throw in odd embeddings — never break the widget.
    return null;
  }
}

function resolveFromMode(m: ThemeMode): ResolvedTheme {
  if (m === "light" || m === "dark") return m;
  return detectHostTheme() ?? systemTheme();
}

/**
 * Resolve the theme for a config: explicit `theme` wins; `"auto"` (or unset)
 * detects the host page, then the OS.
 */
export function resolveTheme(config: OverlayConfig): ResolvedTheme {
  const m = config?.theme;
  return resolveFromMode(m === "light" || m === "dark" ? m : "auto");
}

/** The currently applied concrete theme. */
export function getTheme(): ResolvedTheme {
  return current;
}

// ── Application ───────────────────────────────────────────────────────────────

function setThemeAttr(el: Element | null, theme: ResolvedTheme): void {
  if (!el) return;
  try {
    const withData = el as HTMLElement;
    if (withData.dataset) withData.dataset.efTheme = theme;
    else el.setAttribute("data-ef-theme", theme);
  } catch {
    // ignore
  }
}

/** Mirror the current theme onto an overlay element (safe for late-created roots). */
export function syncThemeTo(el: Element | null): void {
  setThemeAttr(el, current);
}

function syncRoots(theme: ResolvedTheme): void {
  try {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    for (const selector of ROOT_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => setThemeAttr(el, theme));
    }
  } catch {
    // ignore
  }
}

function emit(theme: ResolvedTheme): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb(theme);
    } catch {
      // A misbehaving listener must never break the overlay.
    }
  }
}

/**
 * Re-resolve the theme and write it to the document root + overlay roots.
 * Emits to subscribers only when the resolved value actually changes.
 */
export function applyTheme(): void {
  const next = resolveFromMode(mode);
  const changed = next !== current;
  current = next;
  setThemeAttr(typeof document !== "undefined" ? document.documentElement : null, next);
  syncRoots(next);
  if (changed) emit(next);
}

/**
 * Subscribe to resolved-theme changes (OS preference flips, host theme flips).
 * Returns an unsubscribe function.
 */
export function onThemeChange(cb: (theme: ResolvedTheme) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ── Watching ──────────────────────────────────────────────────────────────────

function startWatching(): void {
  // OS colour-scheme changes.
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme();
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", handler);
      } else if (typeof (mql as MediaQueryList).addListener === "function") {
        // Older Safari.
        (mql as MediaQueryList).addListener(handler);
      }
    }
  } catch {
    // ignore
  }

  // Host page theme changes (class / data-theme / color-scheme / style flips).
  try {
    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
      observer = new MutationObserver((records) => {
        for (const r of records) {
          // Ignore our own attribute writes.
          if (r.type === "attributes" && r.attributeName !== "data-ef-theme") {
            applyTheme();
            return;
          }
        }
      });
      const opts: MutationObserverInit = {
        attributes: true,
        attributeFilter: ["class", "data-theme", "style", "color-scheme"],
      };
      if (document.documentElement) observer.observe(document.documentElement, opts);
      if (document.body) observer.observe(document.body, opts);
    }
  } catch {
    // ignore
  }
}

/** Configure + apply the theme, and start watching for changes. Idempotent. */
export function initTheme(config: OverlayConfig): void {
  const m = config?.theme;
  mode = m === "light" || m === "dark" ? m : "auto";
  if (!watching) {
    watching = true;
    startWatching();
  }
  applyTheme();
}
