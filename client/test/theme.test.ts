// test/theme.test.ts — unit tests for overlay theme resolution + application.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./setup";
import { resolveTheme, applyTheme, initTheme, onThemeChange } from "../src/theme";
import type { OverlayConfig } from "../src/config";

// Controllable matchMedia state shared across installs so the single watcher
// (registered on first initTheme) stays drivable in later tests.
const mqlState = { matches: false, listeners: [] as (() => void)[] };

interface FakeEl {
  dataset: Record<string, string>;
  __bg: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  classList: { contains(c: string): boolean };
}

function fakeEl(opts: { attrs?: Record<string, string>; classes?: string[]; bg?: string } = {}): FakeEl {
  const attrs = { ...(opts.attrs ?? {}) };
  const classes = new Set(opts.classes ?? []);
  return {
    dataset: {},
    __bg: opts.bg ?? "",
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
    classList: { contains: (c) => classes.has(c) },
  };
}

/** Install a fresh fake document + window for one test. */
function installDOM(opts: {
  html?: FakeEl;
  body?: FakeEl;
  metaColorScheme?: string | null;
  systemDark?: boolean;
} = {}): FakeEl {
  mqlState.matches = opts.systemDark ?? false;
  const html = opts.html ?? fakeEl();
  const body = opts.body ?? fakeEl();
  const meta = opts.metaColorScheme != null
    ? { getAttribute: (n: string) => (n === "content" ? opts.metaColorScheme! : null) }
    : null;

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    documentElement: html,
    body,
    querySelector: (sel: string) => (sel.includes("color-scheme") ? meta : null),
    querySelectorAll: (_sel: string) => [] as unknown[],
  };
  g.window = {
    matchMedia: (_q: string) => ({
      get matches() { return mqlState.matches; },
      media: _q,
      addEventListener: (_t: string, cb: () => void) => { mqlState.listeners.push(cb); },
      removeEventListener: () => {},
      addListener: (cb: () => void) => { mqlState.listeners.push(cb); },
      removeListener: () => {},
    }),
    getComputedStyle: (el: FakeEl) => ({
      backgroundColor: el.__bg,
      getPropertyValue: (_p: string) => "",
    }),
  };
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  return html;
}

function cfg(theme: "light" | "dark" | "auto"): OverlayConfig {
  return { theme } as unknown as OverlayConfig;
}

test("explicit config.theme wins over host and OS", () => {
  // Host is dark, OS is dark — explicit light must still win.
  installDOM({
    html: fakeEl({ attrs: { "data-theme": "dark" }, bg: "rgb(10,10,10)" }),
    systemDark: true,
  });
  assert.equal(resolveTheme(cfg("light")), "light");
  assert.equal(resolveTheme(cfg("dark")), "dark");
});

test("auto detects a host data-theme attribute", () => {
  installDOM({ html: fakeEl({ attrs: { "data-theme": "dark" } }), systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "dark");

  installDOM({ html: fakeEl({ attrs: { "data-theme": "light" } }), systemDark: true });
  assert.equal(resolveTheme(cfg("auto")), "light");
});

test("auto detects a Tailwind-style dark class on html/body", () => {
  installDOM({ html: fakeEl({ classes: ["dark"] }), systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "dark");

  installDOM({ body: fakeEl({ classes: ["light"] }), systemDark: true });
  assert.equal(resolveTheme(cfg("auto")), "light");
});

test("emergent.memory data-theme names resolve to the correct theme", () => {
  installDOM({ html: fakeEl({ attrs: { "data-theme": "memory" } }), systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "dark");

  installDOM({ html: fakeEl({ attrs: { "data-theme": "memory-light" } }), systemDark: true });
  assert.equal(resolveTheme(cfg("auto")), "light");
});

test("auto detects host background luminance", () => {
  installDOM({ html: fakeEl({ bg: "rgb(18,18,20)" }), systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "dark");

  installDOM({ html: fakeEl({ bg: "rgb(255,255,255)" }), systemDark: true });
  assert.equal(resolveTheme(cfg("auto")), "light");
});

test("auto falls back to prefers-color-scheme when the host is inconclusive", () => {
  installDOM({ systemDark: true });
  assert.equal(resolveTheme(cfg("auto")), "dark");

  installDOM({ systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "light");
});

test("meta color-scheme 'only dark' resolves dark", () => {
  installDOM({ metaColorScheme: "only dark", systemDark: false });
  assert.equal(resolveTheme(cfg("auto")), "dark");
});

test("applyTheme writes the resolved theme to documentElement.dataset.efTheme", () => {
  installDOM({ systemDark: false });
  initTheme(cfg("dark"));
  assert.equal((globalThis as any).document.documentElement.dataset.efTheme, "dark");

  initTheme(cfg("light"));
  assert.equal((globalThis as any).document.documentElement.dataset.efTheme, "light");
});

test("onThemeChange fires when the OS preference flips", () => {
  installDOM({ systemDark: false });
  initTheme(cfg("auto"));
  assert.equal((globalThis as any).document.documentElement.dataset.efTheme, "light");

  const seen: string[] = [];
  const off = onThemeChange((t) => seen.push(t));

  mqlState.matches = true;
  mqlState.listeners.forEach((cb) => cb());

  assert.deepEqual(seen, ["dark"]);
  assert.equal((globalThis as any).document.documentElement.dataset.efTheme, "dark");
  off();
});
