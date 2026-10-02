// source.ts — element → source-location resolution ladder (Phase A).
//
// Resolves a clicked DOM element to an authored source location via the most
// reliable available signal. The ladder is ordered most→least reliable and
// NEVER fabricates a file or line: a file is only emitted when actually read
// from a stamp or framework runtime metadata. Degradation is a hard
// requirement — an un-instrumented prod page must still produce a useful
// `{ resolution: "none", confidence: "none" }` ref without throwing.

import type { SourceRef, ElementFingerprint } from "./envelope";

/**
 * Parse a "file.tsx:line:col" (or "file.tsx:line") string. The greedy file
 * segment tolerates Windows drive letters and webpack URL prefixes; only the
 * trailing numeric segments are treated as line/column.
 */
function parseFileLineCol(raw: string): {
  file: string;
  line?: number;
  column?: number;
} {
  const full = raw.match(/^(.*):(\d+):(\d+)$/);
  if (full) {
    return {
      file: full[1],
      line: parseInt(full[2], 10),
      column: parseInt(full[3], 10),
    };
  }
  const lineOnly = raw.match(/^(.*):(\d+)$/);
  if (lineOnly) {
    return { file: lineOnly[1], line: parseInt(lineOnly[2], 10) };
  }
  return { file: raw };
}

/**
 * Normalize a RUNTIME path (React fiber `_debugSource`, Vue `__file`, dev-tool
 * stamps). Only strips webpack:// devtool URL prefixes and query/hash suffixes,
 * and relativizes an absolute filesystem path (leading "/" or drive letter)
 * against the filesystem root.
 *
 * INVARIANT: never truncate at a "/src/" (or similar) marker — monorepo paths
 * like "packages/web/src/App.tsx" are already repo-relative and must be
 * preserved verbatim. Only runtime-absolute paths are rewritten, and only
 * minimally.
 */
function normalizeRuntimePath(raw: string): string {
  let f = raw;

  // webpack:// devtool URLs: webpack:///./src/... or webpack://next/./src/...
  const wp = f.match(/^webpack:\/\/[^/]*\/(?:\.\/)?(.*)$/);
  if (wp) f = wp[1];

  // Strip devtool query/hash suffixes (e.g. "?abc123").
  const q = f.search(/[?#]/);
  if (q >= 0) f = f.slice(0, q);

  // Relativize an absolute filesystem path against the filesystem root.
  // (Drive letter or leading slash only — never a mid-path marker.)
  f = f.replace(/^[A-Za-z]:[\\/]+/, "").replace(/^[/\\]+/, "");

  return f;
}

/** Resolve via React fiber metadata (dev `_debugSource`, else component name). */
function resolveReact(el: Element): SourceRef | null {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  if (!key) return null;

  let fiber: unknown = (el as unknown as Record<string, unknown>)[key];
  let component: string | undefined;

  while (fiber && typeof fiber === "object") {
    const f = fiber as Record<string, unknown>;

    const ds = f["_debugSource"] as
      | { fileName?: string; lineNumber?: number; columnNumber?: number }
      | undefined;
    if (ds && typeof ds.fileName === "string" && ds.fileName) {
      return {
        component,
        file: normalizeRuntimePath(ds.fileName),
        line: typeof ds.lineNumber === "number" ? ds.lineNumber : undefined,
        column: typeof ds.columnNumber === "number" ? ds.columnNumber : undefined,
        framework: "react",
        resolution: "fiber",
        confidence: "exact",
      };
    }

    // Nearest component name: elementType/type when it is a component, not a
    // host string ("div", "span", …).
    if (!component) {
      const elementType = f["elementType"] as
        | { name?: string; type?: { name?: string } }
        | undefined;
      const type = f["type"] as
        | string
        | { name?: string; type?: { name?: string } }
        | undefined;

      let candidate: string | undefined;
      if (elementType && typeof elementType === "object") {
        candidate = elementType.name ?? elementType.type?.name;
      }
      if (!candidate && typeof type === "object" && type !== null) {
        candidate = type.name ?? type.type?.name;
      }
      if (candidate) component = candidate;
    }

    fiber = f["return"];
  }

  if (component) {
    return {
      component,
      framework: "react",
      resolution: "fiber",
      confidence: "approximate",
    };
  }

  return null;
}

/** Resolve via Vue runtime metadata (`__vueParentComponent.type.__file`). */
function resolveVue(el: Element): SourceRef | null {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const vpc = (node as unknown as Record<string, unknown>)["__vueParentComponent"] as
      | { type?: { __file?: string; name?: string; __name?: string } }
      | undefined;
    const file = vpc?.type?.__file;
    if (file) {
      const name = vpc?.type?.name ?? vpc?.type?.__name;
      return {
        component: typeof name === "string" && name ? name : undefined,
        file: normalizeRuntimePath(file),
        framework: "vue",
        resolution: "framework-meta",
        confidence: "approximate",
      };
    }
    node = node.parentElement;
  }
  return null;
}

/** Resolve via Svelte runtime metadata (`__svelte_ctx` / `__svelte_dev`). */
function resolveSvelte(el: Element): SourceRef | null {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const n = node as unknown as Record<string, unknown>;
    const ctx = n["__svelte_ctx"];
    const dev = n["__svelte_dev"] as
      | { component?: { name?: string } }
      | undefined;
    if (ctx !== undefined || dev !== undefined) {
      let component: string | undefined;
      if (dev?.component?.name) component = dev.component.name;
      else if (ctx && typeof ctx === "object") {
        const ctorName = (ctx as { constructor?: { name?: string } }).constructor?.name;
        if (ctorName && ctorName !== "Object") component = ctorName;
      }
      return {
        component,
        framework: "svelte",
        resolution: "framework-meta",
        confidence: "approximate",
      };
    }
    node = node.parentElement;
  }
  return null;
}

/** Resolve via existing dev-tool stamps (react-dev-inspector / vue-inspector / Astro). */
function resolveDevStamps(el: Element): SourceRef | null {
  const node = el.closest(
    "[data-inspector-relative-path], [data-v-inspector], [data-astro-source-file]"
  );
  if (!node) return null;

  // react-dev-inspector: data-inspector-relative-path (+ line/column attrs).
  const rel = node.getAttribute("data-inspector-relative-path");
  if (rel) {
    const line = parseInt(node.getAttribute("data-inspector-line") ?? "", 10);
    const column = parseInt(node.getAttribute("data-inspector-column") ?? "", 10);
    return {
      file: normalizeRuntimePath(rel),
      line: Number.isNaN(line) ? undefined : line,
      column: Number.isNaN(column) ? undefined : column,
      resolution: "dev-stamp",
      confidence: "approximate",
    };
  }

  // vite-plugin-vue-inspector: data-v-inspector="path:line:col".
  const v = node.getAttribute("data-v-inspector");
  if (v) {
    const parsed = parseFileLineCol(v);
    return {
      file: normalizeRuntimePath(parsed.file),
      line: parsed.line,
      column: parsed.column,
      framework: "vue",
      resolution: "dev-stamp",
      confidence: "approximate",
    };
  }

  // Astro: data-astro-source-file (+ data-astro-source-loc "line:col").
  const astroFile = node.getAttribute("data-astro-source-file");
  if (astroFile) {
    const loc = node.getAttribute("data-astro-source-loc");
    const parsed: { file?: string; line?: number; column?: number } = loc
      ? parseFileLineCol(loc)
      : {};
    return {
      file: normalizeRuntimePath(astroFile),
      line: parsed.line,
      column: parsed.column,
      framework: "astro",
      resolution: "dev-stamp",
      confidence: "approximate",
    };
  }

  return null;
}

/** Fallback: nearest `data-component` name, no source location. */
function resolveFallback(el: Element): SourceRef {
  const node = el.closest("[data-component]");
  const component = node?.getAttribute("data-component") ?? undefined;
  return {
    component,
    resolution: "none",
    confidence: "none",
  };
}

/**
 * Resolve an element to a source reference, most→least reliable:
 *   build-stamp → React fiber → Vue → Svelte → existing dev stamps → none.
 * Wrapped so any hostile getter/exception degrades gracefully to `none`.
 */
export function resolveSource(el: Element): SourceRef {
  try {
    const stamped = el.closest("[data-fo-src]");
    if (stamped) {
      const raw = stamped.getAttribute("data-fo-src");
      if (raw) {
        const parsed = parseFileLineCol(raw);
        return {
          // INVARIANT: build-stamp paths are already repo-relative by contract
          // (the plugin emits e.g. "packages/web/src/App.tsx:12:3"). Use the
          // file verbatim — never run it through runtime normalization, which
          // could truncate a monorepo path at a "/src/" marker.
          file: parsed.file,
          line: parsed.line,
          column: parsed.column,
          resolution: "build-stamp",
          confidence: "exact",
        };
      }
    }

    return (
      resolveReact(el) ??
      resolveVue(el) ??
      resolveSvelte(el) ??
      resolveDevStamps(el) ??
      resolveFallback(el)
    );
  } catch {
    return { resolution: "none", confidence: "none" };
  }
}

/** Stable attrs that survive re-render and are safe to ship post-redaction. */
const FINGERPRINT_ATTRS = [
  "data-testid",
  "data-component",
  "name",
  "aria-label",
  "role",
] as const;

/**
 * Build a durable fingerprint for re-anchoring across DOM mutation.
 * attrs = stable attributes + class; path = tag chain (up to <body>);
 * text = trimmed content, capped at 80 chars.
 */
export function buildFingerprint(el: Element): ElementFingerprint {
  const attrs: Record<string, string> = {};

  for (const name of FINGERPRINT_ATTRS) {
    const v = el.getAttribute(name);
    if (v) attrs[name] = v;
  }
  const cls = el.getAttribute("class");
  if (cls) attrs["class"] = cls;

  const chain: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    chain.unshift(node.tagName.toLowerCase());
    node = node.parentElement;
  }
  const path = chain.join(" > ");

  const rawText = el.textContent ?? "";
  const text = rawText.trim().slice(0, 80);
  return { attrs, path, text: text || undefined };
}
