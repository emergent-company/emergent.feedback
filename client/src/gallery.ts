// gallery.ts — design variants the chat agent may propose.
//
// When the reporter asks for options ("show me three ways to lay this out"),
// the agent answers with the same fenced JSON block it already uses for the
// report, plus a `gallery` member:
//
//   {"gallery":{"title":"Hero options","variants":[
//     {"id":"a","label":"Split hero","notes":"…","html":"…","css":"…"},
//     …
//   ]}}
//
// Nothing here touches the live page. A variant is rendered inside a
// script-free, opaque-origin iframe and the reporter's pick rides along with
// the report as evidence — it is never applied structurally.
//
// SECURITY BOUNDARY: `sandbox=""` on the iframe (no scripts, no forms, no
// navigation, no same-origin access) plus the CSP meta tag inside each
// generated document (no subresource except the host origin). The regex
// stripping below is hygiene — deterministic previews, no dead <script> text,
// no javascript: URLs — not the boundary. Anything that slips past the regex
// still cannot execute or read this document.

export interface GalleryVariant {
  /** Short stable id: "a", "b", "c"… used for the pick and the transcript. */
  id: string;
  /** Human label shown on the card and in the report. */
  label: string;
  /** One or two sentences on what the variant changes. */
  notes?: string;
  /** Body markup (no <html>/<head>; the document is built around it). */
  html: string;
  /** Optional stylesheet for the variant. */
  css?: string;
}

export interface Gallery {
  title?: string;
  variants: GalleryVariant[];
}

/** Wire/storage caps. Keep a variant small enough to read in a report. */
export const GALLERY_LIMITS = {
  minVariants: 2,
  maxVariants: 4,
  html: 12000,
  css: 6000,
  label: 60,
  notes: 400,
  title: 80,
} as const;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,15}$/;

function clip(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Minimum hygiene for a mockup body.
 *
 * Scripts are removed rather than neutralised because the sandbox already
 * blocks execution: leaving them in would only make the preview source
 * confusing. Event handler attributes and javascript: URLs go for the same
 * reason — a preview should be inert and reproducible.
 */
export function sanitizeVariantHtml(html: string): string {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|frame|frameset)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\b(href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi,
      '$1="#"'
    )
    .trim();
}

/** Same idea for the variant stylesheet: no imports, no script expressions. */
export function sanitizeVariantCss(css: string): string {
  return String(css ?? "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/url\s*\(\s*(['"]?)\s*javascript:[^)]*\)/gi, "none")
    .trim();
}

function validateVariant(raw: unknown): GalleryVariant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  if (!ID_RE.test(id)) return null;

  const label = clip(v.label, GALLERY_LIMITS.label);
  if (!label) return null;

  const html = sanitizeVariantHtml(typeof v.html === "string" ? v.html : "");
  if (!html || html.length > GALLERY_LIMITS.html) return null;

  const out: GalleryVariant = { id: id.toLowerCase(), label, html };

  const notes = clip(v.notes, GALLERY_LIMITS.notes);
  if (notes) out.notes = notes;

  if (typeof v.css === "string") {
    const css = sanitizeVariantCss(v.css);
    if (css) out.css = css.slice(0, GALLERY_LIMITS.css);
  }

  return out;
}

/**
 * Validate a gallery block. Invalid variants are dropped rather than coerced;
 * a gallery that ends up with fewer than two readable variants is discarded —
 * one option is not a choice.
 */
export function validateGallery(raw: unknown): Gallery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.variants)) return null;

  const seen = new Set<string>();
  const variants: GalleryVariant[] = [];
  for (const item of g.variants.slice(0, GALLERY_LIMITS.maxVariants)) {
    const v = validateVariant(item);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    variants.push(v);
  }
  if (variants.length < GALLERY_LIMITS.minVariants) return null;

  const out: Gallery = { variants };
  const title = clip(g.title, GALLERY_LIMITS.title);
  if (title) out.title = title;
  return out;
}

/** The compact projection of a variant that may leave the browser in a chat turn. */
export interface VariantRef {
  id: string;
  label: string;
  notes?: string;
}

export function variantRef(v: GalleryVariant): VariantRef {
  return { id: v.id, label: v.label, ...(v.notes ? { notes: v.notes } : {}) };
}

/** The full attachment persisted with the submitted report. */
export interface DesignAttachment {
  title?: string;
  variant: GalleryVariant;
  alternatives: VariantRef[];
}

export function buildDesignAttachment(gallery: Gallery, pickedId: string): DesignAttachment | null {
  const variant = gallery.variants.find((v) => v.id === pickedId);
  if (!variant) return null;
  return {
    ...(gallery.title ? { title: gallery.title } : {}),
    variant,
    alternatives: gallery.variants.filter((v) => v.id !== pickedId).map(variantRef),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** The host page facts a variant needs to look like the real site. */
export interface HostStyles {
  /** Parent origin, used for the CSP allowlist and relative URLs. */
  origin: string;
  /** Same-origin stylesheet URLs, in document order. */
  links: string[];
  /** Custom properties found on the host, as one `:root{…}` block. */
  themeCss: string;
}

const MAX_LINKS = 6;
const MAX_THEME_CSS = 8000;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Collect `--custom-property` declarations from same-origin sheets + inline :root. */
function collectRootVars(doc: Document): string {
  const vars = new Map<string, string>();
  const add = (text: string): void => {
    const re = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const value = m[2].trim();
      if (name && value && value.length < 200 && !vars.has(name)) vars.set(name, value);
    }
  };
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      add(rule.cssText);
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested && nested.length > 0) walk(nested);
    }
  };

  try {
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        if (sheet.cssRules) walk(sheet.cssRules);
      } catch {
        // Cross-origin sheet: CSSOM is closed. Its rules are already reachable
        // through the <link> we copy.
      }
    }
  } catch {
    // No stylesheet list at all; the inline block below still applies.
  }
  add(doc.documentElement.getAttribute("style") ?? "");

  if (vars.size === 0) return "";
  const body = Array.from(vars)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{${body}}`.slice(0, MAX_THEME_CSS);
}

/**
 * Read the host page's design system without touching it: the stylesheet URLs
 * to reuse and a snapshot of its custom properties.
 */
export function collectHostStyles(doc: Document = document): HostStyles {
  const origin = doc.defaultView?.location?.origin ?? "";
  const links: string[] = [];
  doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]').forEach((link) => {
    if (links.length >= MAX_LINKS) return;
    const href = link.href;
    if (!href) return;
    if (origin && !href.startsWith(origin)) return;
    if (!links.includes(href)) links.push(href);
  });
  return { origin, links, themeCss: collectRootVars(doc) };
}

/**
 * Build the complete document for one variant.
 *
 * Order matters: the captured `:root` block comes first so the host
 * stylesheets (loaded next) win the cascade, and the variant's own CSS comes
 * last so it can override both.
 */
export function buildVariantDocument(variant: GalleryVariant, host: HostStyles): string {
  const origin = host.origin ?? "";
  const allowed = origin ? ` ${origin}` : "";
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline'${allowed}`,
    `img-src data:${allowed}`,
    `font-src data:${allowed}`,
    "media-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");

  const links = host.links
    .map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`)
    .join("");
  const theme = host.themeCss ? `<style>${host.themeCss}</style>` : "";
  const css = variant.css ? `<style>${variant.css}</style>` : "";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    theme,
    links,
    css,
    "<style>html,body{margin:0;padding:0;min-height:100%;}*{box-sizing:border-box;}</style>",
    "</head>",
    `<body>${variant.html}</body>`,
    "</html>",
  ].join("");
}
