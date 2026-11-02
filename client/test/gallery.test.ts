// gallery.test.ts — the design-variant contract.
//
// Two things must stay true: a malformed or oversized variant never reaches
// the preview, and a generated document carries the sandbox policy that makes
// the iframe safe regardless of what the agent wrote.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GALLERY_LIMITS,
  buildDesignAttachment,
  buildVariantDocument,
  sanitizeVariantCss,
  sanitizeVariantHtml,
  validateGallery,
  variantRef,
  type GalleryVariant,
} from "../src/gallery";

const v = (id: string, extra: Partial<GalleryVariant> = {}): GalleryVariant => ({
  id,
  label: `Option ${id}`,
  html: `<div class="card">Option ${id}</div>`,
  ...extra,
});

test("validateGallery: accepts two to four variants", () => {
  const g = validateGallery({ title: "  Hero options  ", variants: [v("a"), v("b"), v("c")] });
  assert.ok(g);
  assert.equal(g?.title, "Hero options");
  assert.equal(g?.variants.length, 3);
  assert.equal(g?.variants[0].id, "a");
});

test("validateGallery: one option is not a choice", () => {
  assert.equal(validateGallery({ variants: [v("a")] }), null);
  assert.equal(validateGallery({ variants: [] }), null);
  assert.equal(validateGallery({}), null);
  assert.equal(validateGallery(null), null);
});

test("validateGallery: invalid variants are dropped, not coerced", () => {
  const g = validateGallery({
    variants: [
      v("a"),
      v("not a valid id!"),
      { id: "b", label: "No markup", html: "" },
      v("c"),
    ],
  });
  assert.ok(g);
  assert.deepEqual(g?.variants.map((x) => x.id), ["a", "c"]);
});

test("validateGallery: duplicate ids collapse to the first", () => {
  const g = validateGallery({ variants: [v("a"), v("a", { label: "Second" }), v("b")] });
  assert.ok(g);
  assert.deepEqual(g?.variants.map((x) => x.label), ["Option a", "Option b"]);
});

test("validateGallery: an oversized variant is rejected", () => {
  const big = `<div>${"x".repeat(GALLERY_LIMITS.html + 1)}</div>`;
  const g = validateGallery({ variants: [v("a"), v("b", { html: big }), v("c")] });
  assert.ok(g);
  assert.deepEqual(g?.variants.map((x) => x.id), ["a", "c"]);
});

test("validateGallery: ids are lowercased and labels capped", () => {
  const g = validateGallery({ variants: [v("A"), v("B", { label: "y".repeat(200) })] });
  assert.ok(g);
  assert.equal(g?.variants[0].id, "a");
  assert.equal(g?.variants[1].label.length, GALLERY_LIMITS.label);
});

test("sanitizeVariantHtml: scripts and handlers are removed", () => {
  const html = sanitizeVariantHtml(
    '<div onclick="steal()">x</div><script>alert(1)</script><iframe src="https://evil"></iframe>'
  );
  assert.ok(!html.includes("script"));
  assert.ok(!html.includes("onclick"));
  assert.ok(!html.includes("iframe"));
  assert.ok(html.includes("<div>x</div>"));
});

test("sanitizeVariantHtml: javascript: urls are neutralised", () => {
  const html = sanitizeVariantHtml('<a href="javascript:alert(1)">x</a><img src="javascript:1">');
  assert.ok(!html.includes("javascript:"));
});

test("sanitizeVariantCss: imports and expressions are removed", () => {
  const css = sanitizeVariantCss(
    '@import url("https://evil/x.css"); .a{width:expression(alert(1));color:red}'
  );
  assert.ok(!css.includes("@import"));
  assert.ok(!css.includes("expression("));
  assert.ok(css.includes("color:red"));
});

test("buildVariantDocument: the policy travels with the document", () => {
  const doc = buildVariantDocument(v("a", { css: ".card{color:red}" }), {
    origin: "https://site.example",
    links: ["https://site.example/app.css"],
    themeCss: ":root{--color-primary:oklch(0.6 0.1 78);}",
  });
  assert.ok(doc.startsWith("<!doctype html>"));
  assert.ok(doc.includes("default-src 'none'"));
  assert.ok(doc.includes("script-src 'none'"));
  assert.ok(doc.includes("https://site.example"));
  assert.ok(doc.includes('<link rel="stylesheet" href="https://site.example/app.css">'));
  assert.ok(doc.includes("--color-primary"));
  assert.ok(doc.includes(".card{color:red}"));
  assert.ok(doc.includes('<div class="card">Option a</div>'));
});

test("buildVariantDocument: a missing origin still produces a closed policy", () => {
  const doc = buildVariantDocument(v("a"), { origin: "", links: [], themeCss: "" });
  assert.ok(doc.includes("default-src 'none'"));
  assert.ok(!doc.includes("https://"));
});

test("buildDesignAttachment: the pick keeps the alternatives as labels only", () => {
  const g = { title: "Hero", variants: [v("a"), v("b"), v("c")] };
  const design = buildDesignAttachment(g, "b");
  assert.ok(design);
  assert.equal(design?.variant.id, "b");
  assert.equal(design?.title, "Hero");
  assert.deepEqual(design?.alternatives.map((a) => a.id), ["a", "c"]);
  assert.equal(buildDesignAttachment(g, "zzz"), null);
});

test("variantRef: drops the markup", () => {
  const ref = variantRef(v("a", { notes: "Split layout" }));
  assert.deepEqual(ref, { id: "a", label: "Option a", notes: "Split layout" });
  assert.ok(!("html" in ref));
});
