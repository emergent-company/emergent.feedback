// test/tokens.test.ts — validation/normalization + apply/match/revert + fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTheme,
  buildFallbackTokens,
  matchToken,
  applyToken,
  revertToken,
  type TokenGroup,
} from "../src/tokens";

// ── Minimal DOM fakes (hermetic; no jsdom) ────────────────────────────────────

class FakeClassList {
  private set = new Set<string>();
  constructor(classes: string[] = []) {
    for (const c of classes) this.set.add(c);
  }
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  [Symbol.iterator](): IterableIterator<string> { return this.set[Symbol.iterator](); }
}

class FakeStyle {
  props: Record<string, string> = {};
  getPropertyValue(p: string): string { return this.props[p] ?? ""; }
  setProperty(p: string, v: string): void { this.props[p] = v; }
  removeProperty(p: string): void { delete this.props[p]; }
}

class FakeEl {
  classList: FakeClassList;
  style = new FakeStyle();
  constructor(classes: string[] = []) {
    this.classList = new FakeClassList(classes);
  }
}

interface RawGroup { [k: string]: unknown }

function payload(groups: RawGroup[]): unknown {
  return { version: 1, groups };
}

// ── Normalization / validation ────────────────────────────────────────────────

test("normalizeTheme: rejects wrong version / shape", () => {
  assert.equal(normalizeTheme(null), null);
  assert.equal(normalizeTheme({ version: 2, groups: [] }), null);
  assert.equal(normalizeTheme({ version: 1, groups: [] }), null);
  assert.equal(normalizeTheme({ version: 1 }), null);
});

test("normalizeTheme: drops a token with a bad class name", () => {
  const out = normalizeTheme(payload([
    {
      id: "padding", label: "Padding", applyType: "class", removePattern: "^p-",
      tokens: [
        { id: "bad", label: "Bad", className: "p-2;color:red" },
        { id: "ok", label: "Ok", className: "p-4" },
      ],
    },
  ]));
  assert.ok(out);
  assert.equal(out!.groups.length, 1);
  assert.deepEqual(out!.groups[0].tokens.map((t) => t.id), ["ok"]);
});

test("normalizeTheme: rejects a group with an invalid applyType", () => {
  const out = normalizeTheme(payload([
    { id: "g", label: "G", applyType: "both", tokens: [{ id: "a", label: "A", className: "x" }] },
  ]));
  assert.equal(out, null);
});

test("normalizeTheme: rejects an invalid removePattern", () => {
  assert.equal(
    normalizeTheme(payload([
      { id: "g", label: "G", applyType: "class", removePattern: "[", tokens: [{ id: "a", label: "A", className: "x" }] },
    ])),
    null
  );
  assert.equal(
    normalizeTheme(payload([
      { id: "g", label: "G", applyType: "class", removePattern: "(a|b)", tokens: [{ id: "a", label: "A", className: "x" }] },
    ])),
    null
  );
});

test("normalizeTheme: rejects style tokens with a bad prop or value", () => {
  const bad = (prop: string, value: string) => normalizeTheme(payload([
    {
      id: "g", label: "G", applyType: "class",
      tokens: [{ id: "t", label: "T", apply: { type: "style", prop, value } }],
    },
  ]));
  assert.equal(bad("width", "10px"), null, "non-whitelisted prop");
  assert.equal(bad("color", "url(http://x)"), null, "url() value");
  assert.equal(bad("color", "red;}"), null, "semicolon value");
  assert.equal(bad("color", "javascript:alert(1)"), null, "javascript: value");
  assert.equal(bad("color", "expression(alert(1))"), null, "expression value");
  assert.equal(bad("color", "image-set('x.png' 1x)"), null, "image-set() value");
  assert.equal(bad("color", "-webkit-image-set('x.png' 1x)"), null, "webkit image-set() value");
  assert.equal(bad("color", "element(#foo)"), null, "element() value");
  assert.equal(bad("color", "a".repeat(121)), null, "over-long value");
});

test("normalizeTheme: validates swatches, keeping the token when one is bad", () => {
  const out = normalizeTheme(payload([
    {
      id: "textColor", label: "Text color", applyType: "class", removePattern: "^text-",
      tokens: [
        { id: "base", label: "Base", className: "text-base-content", swatch: "var(--color-base-content)" },
        { id: "primary", label: "Primary", className: "text-primary", swatch: "red;background:url(x)" },
        { id: "accent", label: "Accent", className: "text-accent", swatch: "a".repeat(121) },
      ],
    },
  ]));
  assert.ok(out);
  const tokens = out!.groups[0].tokens;
  assert.equal(tokens.length, 3, "tokens are kept even when the swatch is dropped");
  assert.equal(tokens.find((t) => t.id === "base")!.swatch, "var(--color-base-content)");
  assert.equal(tokens.find((t) => t.id === "primary")!.swatch, undefined);
  assert.equal(tokens.find((t) => t.id === "accent")!.swatch, undefined);
});

test("normalizeTheme: an empty removePattern means 'no pattern' (group kept)", () => {
  const out = normalizeTheme(payload([
    {
      id: "g", label: "G", applyType: "class", removePattern: "",
      tokens: [{ id: "a", label: "A", className: "x" }],
    },
  ]));
  assert.ok(out);
  assert.equal(out!.groups.length, 1);
  assert.equal(out!.groups[0].removePattern, undefined);
});

test("normalizeTheme: keeps a valid payload and tags its source", () => {
  const out = normalizeTheme(payload([
    {
      id: "padding", label: "Padding", applyType: "class", removePattern: "^p[xytrbl]?-",
      tokens: [
        { id: "none", label: "None", className: "p-0" },
        { id: "lg", label: "Large", apply: { type: "style", prop: "padding", value: "var(--space-lg)" } },
      ],
    },
  ]));
  assert.ok(out);
  assert.equal(out!.source, "endpoint");
  const g = out!.groups[0];
  assert.equal(g.id, "padding");
  assert.equal(g.tokens.length, 2);
  assert.equal(g.tokens[1].apply?.type, "style");
  assert.equal(g.tokens[1].apply?.prop, "padding");
  assert.equal(g.tokens[1].apply?.value, "var(--space-lg)");
});

// ── Fallback tokens ───────────────────────────────────────────────────────────

test("buildFallbackTokens: reads daisyUI vars and includes a spacing scale", () => {
  const vars: Record<string, string> = {
    "--color-primary": "oklch(60% 0.2 250)",
    "--color-base-content": "oklch(20% 0.01 250)",
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: (n: string) => vars[n] ?? "" });
  try {
    const theme = buildFallbackTokens();
    assert.equal(theme.source, "fallback");
    const padding = theme.groups.find((x) => x.id === "padding")!;
    assert.deepEqual(padding.tokens.map((t) => t.className), ["p-0", "p-1", "p-2", "p-4", "p-6", "p-8"]);
    const text = theme.groups.find((x) => x.id === "textColor")!;
    const primary = text.tokens.find((t) => t.id === "primary")!;
    assert.equal(primary.className, "text-primary");
    assert.equal(primary.swatch, "oklch(60% 0.2 250)"); // resolved from the var
    const bg = theme.groups.find((x) => x.id === "backgroundColor")!;
    assert.ok(bg.tokens.some((t) => t.className === "bg-base-100"));
  } finally {
    delete g.document;
    delete g.getComputedStyle;
  }
});

// ── match / apply / revert ────────────────────────────────────────────────────

const classGroup: TokenGroup = {
  id: "padding",
  label: "Padding",
  applyType: "class",
  removePattern: "^p[xytrbl]?-",
  tokens: [
    { id: "none", label: "None", className: "p-0" },
    { id: "sm", label: "Small", className: "p-2" },
    { id: "md", label: "Medium", className: "p-4" },
    { id: "lg", label: "Large", apply: { type: "style", prop: "padding", value: "var(--space-lg)" } },
  ],
};

test("matchToken: finds a class token by class, a style token by inline value", () => {
  const el = new FakeEl(["btn", "p-2"]);
  assert.equal(matchToken(el as unknown as Element, classGroup)?.id, "sm");

  const el2 = new FakeEl(["btn"]);
  (el2 as unknown as FakeEl).style.setProperty("padding", "var(--space-lg)");
  assert.equal(matchToken(el2 as unknown as Element, classGroup)?.id, "lg");

  const el3 = new FakeEl(["btn"]);
  assert.equal(matchToken(el3 as unknown as Element, classGroup), null);
});

test("applyToken: adds the new class and removes the prior group class", () => {
  const el = new FakeEl(["btn", "p-2"]);
  const md = classGroup.tokens.find((t) => t.id === "md")!;
  const change = applyToken(el as unknown as Element, classGroup, md);
  assert.equal(change.before, "p-2");
  assert.equal(change.after, "p-4");
  assert.ok(el.classList.contains("p-4"));
  assert.ok(!el.classList.contains("p-2"));
  assert.ok(el.classList.contains("btn"), "unrelated classes preserved");
});

test("applyToken: style token sets inline value and clears the prior class", () => {
  const el = new FakeEl(["p-2"]);
  const lg = classGroup.tokens.find((t) => t.id === "lg")!;
  const change = applyToken(el as unknown as Element, classGroup, lg);
  assert.equal(change.before, "p-2");
  assert.equal(change.after, "var(--space-lg)");
  assert.equal((el as unknown as FakeEl).style.getPropertyValue("padding"), "var(--space-lg)");
  assert.ok(!el.classList.contains("p-2"));
});

test("revertToken: restores the previous class", () => {
  const el = new FakeEl(["btn"]);
  const md = classGroup.tokens.find((t) => t.id === "md")!;
  const change = applyToken(el as unknown as Element, classGroup, md);
  revertToken(el as unknown as Element, classGroup, change);
  assert.ok(!el.classList.contains("p-4"));
});

test("revertToken: restores the previous class after a style apply", () => {
  const el = new FakeEl(["btn", "p-2"]);
  const lg = classGroup.tokens.find((t) => t.id === "lg")!;
  const change = applyToken(el as unknown as Element, classGroup, lg);
  revertToken(el as unknown as Element, classGroup, change);
  assert.equal((el as unknown as FakeEl).style.getPropertyValue("padding"), "");
  assert.ok(el.classList.contains("p-2"));
  assert.ok(!el.classList.contains("p-4"));
});

test("applyToken/revertToken: a pre-existing inline style is captured and restored", () => {
  const el = new FakeEl(["btn"]);
  (el as unknown as FakeEl).style.setProperty("padding", "12px");

  const lg = classGroup.tokens.find((t) => t.id === "lg")!;
  const change = applyToken(el as unknown as Element, classGroup, lg);
  assert.equal(change.before, "12px", "prior inline value is recorded");
  assert.equal(change.after, "var(--space-lg)");
  assert.equal((el as unknown as FakeEl).style.getPropertyValue("padding"), "var(--space-lg)");

  revertToken(el as unknown as Element, classGroup, change);
  assert.equal((el as unknown as FakeEl).style.getPropertyValue("padding"), "12px");
});
