// test/applicability.test.ts — per-element capability filtering.
//
// Mirrors the fake-element style of tokens.test.ts: no jsdom, a FakeEl with the
// handful of DOM surface `elementCaps` touches. `getStyle` returns the fake
// element's own `style` so computed-style reads resolve from a plain prop map.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visibleGroups,
  isApplicable,
  elementCaps,
  requirementMet,
  describeRequirement,
  isValidRequirement,
  type Requirement,
  type StyleGetter,
  type ElementCapabilities,
} from "../src/applicability";
import { buildFallbackTokens, type TokenGroup } from "../src/tokens";

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

class FakeStyleDeclaration {
  props: Record<string, string> = {};
  getPropertyValue(p: string): string { return this.props[p] ?? ""; }
}

class FakeEl {
  classList: FakeClassList;
  style = new FakeStyleDeclaration();
  tagName: string;
  parentElement: FakeEl | null = null;
  children: FakeEl[] = [];
  textContent = "";
  type = "";
  /** Absent by default (like the DOM surface the fakes don't model). */
  isConnected?: boolean;
  constructor(tagName = "div", classes: string[] = []) {
    this.tagName = tagName;
    this.classList = new FakeClassList(classes);
  }
}

const asEl = (e: FakeEl): Element => e as unknown as Element;
const getStyle: StyleGetter = (el) => (el as unknown as FakeEl).style;

const theme = buildFallbackTokens();

function visibleIds(
  el: FakeEl,
  opts: { isApplied?: (g: TokenGroup) => boolean } = {}
): string[] {
  return visibleGroups(theme.groups, asEl(el), { getStyle, ...opts }).map((g) => g.id);
}

// ── Per-element filtering ─────────────────────────────────────────────────────

test("block div: container/children groups hidden, no-requirement groups visible", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  const ids = visibleIds(el);
  for (const hidden of ["gap", "align", "justify", "flexDir", "wrap", "self"]) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden`);
  }
  for (const shown of ["display", "padding", "textColor", "backgroundColor"]) {
    assert.ok(ids.includes(shown), `${shown} visible`);
  }
});

test("flex container with children: container + flex-container visible, self hidden", () => {
  const parent = new FakeEl("div");
  parent.style.props.display = "block";
  const el = new FakeEl("div");
  el.style.props.display = "flex";
  el.parentElement = parent;
  el.children = [new FakeEl("div")];
  const ids = visibleIds(el);
  for (const shown of ["align", "justify", "flexDir", "wrap", "gap"]) {
    assert.ok(ids.includes(shown), `${shown} visible`);
  }
  assert.ok(!ids.includes("self"), "self hidden (a flex container is not an item)");
});

test("flex container without children: gap hidden (children requirement)", () => {
  const el = new FakeEl("div");
  el.style.props.display = "flex";
  const ids = visibleIds(el);
  assert.ok(!ids.includes("gap"), "gap hidden without children");
  assert.ok(ids.includes("align") && ids.includes("flexDir"), "align/flexDir still visible");
});

test("grid container: container groups visible, flexDir/wrap hidden", () => {
  const el = new FakeEl("div");
  el.style.props.display = "grid";
  const ids = visibleIds(el);
  assert.ok(ids.includes("align") && ids.includes("justify"), "container groups visible");
  assert.ok(!ids.includes("flexDir") && !ids.includes("wrap"), "flex-container groups hidden");
});

test("self: visible for a flex/grid item, hidden for a block item", () => {
  const flexParent = new FakeEl("div");
  flexParent.style.props.display = "flex";
  const item = new FakeEl("div");
  item.parentElement = flexParent;
  assert.ok(visibleIds(item).includes("self"), "flex item self visible");

  const blockParent = new FakeEl("div");
  blockParent.style.props.display = "block";
  const item2 = new FakeEl("div");
  item2.parentElement = blockParent;
  assert.ok(!visibleIds(item2).includes("self"), "block item self hidden");
});

test("img: objectFit visible, text groups hidden, box groups visible", () => {
  const el = new FakeEl("img");
  el.style.props.display = "inline";
  const ids = visibleIds(el);
  assert.ok(ids.includes("objectFit"), "objectFit visible");
  for (const hidden of ["textSize", "fontWeight", "textAlign"]) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden`);
  }
  for (const shown of ["width", "height", "maxWidth", "shadow"]) {
    assert.ok(ids.includes(shown), `${shown} visible (replaced box)`);
  }
});

test("inline span with text: box groups hidden, text groups visible", () => {
  const el = new FakeEl("span");
  el.style.props.display = "inline";
  el.textContent = "hello";
  const ids = visibleIds(el);
  for (const hidden of ["width", "height", "maxWidth", "shadow"]) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden`);
  }
  for (const shown of ["textSize", "fontWeight", "textAlign", "padding", "textColor"]) {
    assert.ok(ids.includes(shown), `${shown} visible`);
  }
});

test("input[type=text] with empty textContent: text groups visible", () => {
  const el = new FakeEl("input");
  el.type = "text";
  el.textContent = "";
  const ids = visibleIds(el);
  for (const shown of ["textSize", "fontWeight", "textAlign"]) {
    assert.ok(ids.includes(shown), `${shown} visible (text control)`);
  }
});

test("input[type=submit] with empty textContent: text groups visible (button face)", () => {
  const el = new FakeEl("input");
  el.type = "submit";
  el.textContent = "";
  const ids = visibleIds(el);
  for (const shown of ["textSize", "fontWeight", "textAlign"]) {
    assert.ok(ids.includes(shown), `${shown} visible (submit renders its value as text)`);
  }
});

test("multicol (column-count: 2, block): gap visible, align/justify hidden", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  el.style.props["column-count"] = "2";
  el.children = [new FakeEl("div")];
  const ids = visibleIds(el);
  assert.ok(ids.includes("gap"), "gap visible (container includes multi-column)");
  assert.ok(!ids.includes("align"), "align hidden (align-items does not apply to multicol)");
  assert.ok(!ids.includes("justify"), "justify hidden (justify-content does not apply to multicol)");
});

test("display: contents and display: none hide box groups", () => {
  for (const display of ["contents", "none"]) {
    const el = new FakeEl("div");
    el.style.props.display = display;
    const ids = visibleIds(el);
    for (const hidden of ["width", "height", "maxWidth", "shadow"]) {
      assert.ok(!ids.includes(hidden), `${hidden} hidden for display: ${display}`);
    }
  }
});

test("detached element (isConnected: false) is permissive: every group visible", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  el.isConnected = false;
  const ids = visibleIds(el);
  assert.equal(ids.length, theme.groups.length, "all groups visible for a detached element");
  assert.ok(ids.includes("gap"), "even container-requiring gap is visible");
});

test("daisyUI groups: .btn / .badge classes gate the component groups", () => {
  const btnIds = visibleIds(new FakeEl("button", ["btn"]));
  for (const shown of ["btnColor", "btnModifier", "btnSize"]) {
    assert.ok(btnIds.includes(shown), `${shown} visible for .btn`);
  }

  const plainIds = visibleIds(new FakeEl("button"));
  for (const hidden of ["btnColor", "btnModifier", "btnSize"]) {
    assert.ok(!plainIds.includes(hidden), `${hidden} hidden for plain <button>`);
  }

  const badgeIds = visibleIds(new FakeEl("span", ["badge"]));
  for (const shown of ["badgeColor", "badgeModifier", "badgeSize"]) {
    assert.ok(badgeIds.includes(shown), `${shown} visible for .badge`);
  }

  const spanIds = visibleIds(new FakeEl("span"));
  for (const hidden of ["badgeColor", "badgeModifier", "badgeSize"]) {
    assert.ok(!spanIds.includes(hidden), `${hidden} hidden for plain span`);
  }
});

test("inset: hidden for static, visible when positioned", () => {
  const staticEl = new FakeEl("div");
  staticEl.style.props.position = "static";
  assert.ok(!visibleIds(staticEl).includes("inset"), "inset hidden for static");

  const rel = new FakeEl("div");
  rel.style.props.position = "relative";
  assert.ok(visibleIds(rel).includes("inset"), "inset visible for relative");
});

test("an inapplicable group with an applied token is always shown", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  const out = visibleGroups(theme.groups, asEl(el), {
    getStyle,
    isApplied: (g) => g.id === "gap",
  });
  assert.ok(out.some((g) => g.id === "gap"), "gap kept when an edit is applied");
});

test("groups without requires, and unknown requirements, are visible", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  const groups: TokenGroup[] = [
    { id: "none", label: "None", applyType: "class", tokens: [] },
    { id: "unknown", label: "Unknown", applyType: "class", tokens: [], requires: "nope" as Requirement },
  ];
  const out = visibleGroups(groups, asEl(el), { getStyle });
  assert.deepEqual(out.map((g) => g.id), ["none", "unknown"]);
});

test("permissive on failure: throwing getStyle and absent window show everything", () => {
  const el = new FakeEl("div");
  const throwing: StyleGetter = () => {
    throw new Error("boom");
  };
  assert.equal(visibleGroups(theme.groups, asEl(el), { getStyle: throwing }).length, theme.groups.length);

  // No getStyle → default getter returns null when `window` is absent (Node).
  assert.equal(visibleGroups(theme.groups, asEl(el)).length, theme.groups.length);
});

// ── Lower-level helpers ───────────────────────────────────────────────────────

test("elementCaps walks past display:contents parents", () => {
  const outer = new FakeEl("div");
  outer.style.props.display = "flex";
  const middle = new FakeEl("div");
  middle.style.props.display = "contents";
  middle.parentElement = outer;
  const el = new FakeEl("div");
  el.style.props.display = "block";
  el.parentElement = middle;

  const caps = elementCaps(asEl(el), getStyle);
  assert.equal(caps.parentDisplay, "flex");
});

test("requirementMet: box allows inline only for replaced elements", () => {
  const base: ElementCapabilities = {
    display: "inline",
    parentDisplay: "",
    hasChildren: false,
    hasText: false,
    isReplaced: false,
    isPositioned: false,
    classes: [],
    columnCount: 1,
  };
  assert.equal(requirementMet("box", base), false);
  assert.equal(requirementMet("box", { ...base, isReplaced: true }), true);
  assert.equal(requirementMet("box", { ...base, display: "block" }), true);
});

test("describeRequirement returns readable reasons", () => {
  assert.equal(describeRequirement("container"), "needs a flex/grid/multi-column container");
  assert.equal(describeRequirement("flex-grid-container"), "needs a flex/grid container");
  assert.equal(describeRequirement("has-class:btn"), 'needs class "btn"');
});

test("isValidRequirement: whitelist + has-class, rejects bad class", () => {
  assert.equal(isValidRequirement("container"), true);
  assert.equal(isValidRequirement("has-class:btn"), true);
  assert.equal(isValidRequirement("has-class:"), false);
  assert.equal(isValidRequirement("has-class:btn primary"), false);
  assert.equal(isValidRequirement("nope"), false);
});

test("isApplicable: applied token overrides an unmet requirement", () => {
  const el = new FakeEl("div");
  el.style.props.display = "block";
  const group: TokenGroup = {
    id: "gap",
    label: "Gap",
    applyType: "class",
    tokens: [],
    requires: ["container", "children"],
  };
  assert.equal(isApplicable(group, asEl(el), { getStyle }), false);
  assert.equal(isApplicable(group, asEl(el), { getStyle, isApplied: () => true }), true);
});
