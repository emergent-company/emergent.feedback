// structure.test.ts — drop resolution + reorder replay under a fake DOM.
//
// The fake is deliberately tiny: only the tree API `structure.ts` touches. Every
// fixture element carries a stable `id`, so `buildSelector` resolves to `#id`
// and the tests can assert on selectors a reader can follow.

import test from "node:test";
import assert from "node:assert/strict";
import {
  captureAnchor,
  computeDrop,
  containerLabel,
  describePosition,
  moveElement,
  ordinal,
  placeAt,
} from "../src/structure";

type Rect = { top: number; left: number; width: number; height: number };

class FakeEl {
  tagName: string;
  id = "";
  attrs: Record<string, string> = {};
  classes: string[] = [];
  kids: FakeEl[] = [];
  parent: FakeEl | null = null;
  rect: Rect = { top: 0, left: 0, width: 100, height: 20 };

  constructor(tag: string, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
  }

  get children(): FakeEl[] {
    return this.kids;
  }
  get childElementCount(): number {
    return this.kids.length;
  }
  get parentElement(): FakeEl | null {
    return this.parent;
  }
  get lastElementChild(): FakeEl | null {
    return this.kids[this.kids.length - 1] ?? null;
  }
  get nextElementSibling(): FakeEl | null {
    if (!this.parent) return null;
    const i = this.parent.kids.indexOf(this);
    return i >= 0 ? this.parent.kids[i + 1] ?? null : null;
  }
  get classList(): string[] {
    return this.classes;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.kids.some((k) => k.contains(node));
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    if (node.parent) node.parent.kids = node.parent.kids.filter((k) => k !== node);
    node.parent = this;
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(node);
    else this.kids.splice(i, 0, node);
    return node;
  }
  append(...nodes: FakeEl[]): this {
    for (const n of nodes) this.insertBefore(n, null);
    return this;
  }
  getBoundingClientRect(): Rect {
    return this.rect;
  }
  at(rect: Partial<Rect>): this {
    this.rect = { ...this.rect, ...rect };
    return this;
  }
}

interface FakeDom {
  body: FakeEl;
  html: FakeEl;
  byId: (id: string) => FakeEl | null;
  allowHorizontal: (yes: boolean) => void;
  restore: () => void;
}

/** Install document/CSS/window fakes. `display` decides the layout axis. */
function installDom(): FakeDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = { document: g.document, CSS: g.CSS, window: g.window };

  const html = new FakeEl("html");
  const body = new FakeEl("body");
  html.append(body);
  let horizontal = false;

  const all = (root: FakeEl, out: FakeEl[] = []): FakeEl[] => {
    for (const k of root.kids) {
      out.push(k);
      all(k, out);
    }
    return out;
  };
  const byId = (id: string): FakeEl | null => all(html).find((e) => e.id === id) ?? null;

  g.document = {
    body,
    documentElement: html,
    createElement: (tag: string) => new FakeEl(tag),
    getElementById: byId,
    // Only `#id` selectors occur in these fixtures (see the file header).
    querySelector: (sel: string) => (/^#[\w-]+$/.test(sel) ? byId(sel.slice(1)) : null),
  };
  g.CSS = { escape: (s: string) => s };
  g.window = {
    getComputedStyle: () => ({
      display: horizontal ? "flex" : "block",
      flexDirection: horizontal ? "row" : "column",
      gridAutoFlow: "",
    }),
  };

  return {
    body,
    html,
    byId,
    allowHorizontal: (yes: boolean) => {
      horizontal = yes;
    },
    restore: () => {
      g.document = prev.document;
      g.CSS = prev.CSS;
      g.window = prev.window;
    },
  };
}

/** `#page > #toolbar > #btn-a, #btn-b, #btn-c`, laid out downward. */
function toolbarFixture(dom: FakeDom) {
  const page = new FakeEl("div", "page");
  const toolbar = new FakeEl("div", "toolbar");
  const a = new FakeEl("button", "btn-a").at({ top: 0, height: 20 });
  const b = new FakeEl("button", "btn-b").at({ top: 20, height: 20 });
  const c = new FakeEl("button", "btn-c").at({ top: 40, height: 20 });
  dom.body.append(page);
  page.append(toolbar);
  toolbar.append(a, b, c);
  return { page, toolbar, a, b, c };
}

const ids = (el: FakeEl): string[] => el.children.map((k) => k.id);

test("ordinal: 1st/2nd/3rd, the 11-13 teens, and the 21st+ pattern", () => {
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(4), "4th");
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(21), "21st");
  assert.equal(ordinal(112), "112th");
});

test("describePosition / containerLabel: readable position text for the payload", () => {
  const dom = installDom();
  try {
    const { b, toolbar } = toolbarFixture(dom);
    assert.equal(describePosition(b), "2nd of 3 in #toolbar");
    assert.equal(containerLabel(toolbar), "#toolbar");
    toolbar.setAttribute("data-component", "Toolbar");
    assert.equal(containerLabel(toolbar), "Toolbar");
    assert.equal(describePosition(b), "2nd of 3 in Toolbar");
  } finally {
    dom.restore();
  }
});

test("computeDrop: pointer in the first half inserts before the hovered sibling", () => {
  const dom = installDom();
  try {
    const { toolbar, a, b } = toolbarFixture(dom);
    const drop = computeDrop(b, a, 50, 25); // above btn-b's midpoint (30)
    assert.equal(drop?.container, toolbar);
    assert.equal(drop?.before, b);
  } finally {
    dom.restore();
  }
});

test("computeDrop: pointer in the second half inserts after it (before the next sibling)", () => {
  const dom = installDom();
  try {
    const { a, b, c } = toolbarFixture(dom);
    const drop = computeDrop(b, a, 50, 35); // below the midpoint
    assert.equal(drop?.before, c);
  } finally {
    dom.restore();
  }
});

test("computeDrop: hovering the last sibling's lower half appends (before: null)", () => {
  const dom = installDom();
  try {
    const { a, c } = toolbarFixture(dom);
    const drop = computeDrop(c, a, 50, 55);
    assert.equal(drop?.before, null);
  } finally {
    dom.restore();
  }
});

test("computeDrop: a horizontal row uses x, not y", () => {
  const dom = installDom();
  try {
    dom.allowHorizontal(true);
    const { a, c } = toolbarFixture(dom);
    const row = (el: FakeEl, left: number) => el.at({ top: 0, left, width: 40, height: 20 });
    row(a, 0);
    row(c, 80);
    // Below the row but left of btn-c's midpoint → still "before btn-c": the axis
    // came from flex-direction, not from the pointer's y position.
    assert.equal(computeDrop(c, a, 90, 900)?.before, c);
    assert.equal(computeDrop(c, a, 130, 900)?.before, c.nextElementSibling);
  } finally {
    dom.restore();
  }
});

test("computeDrop: a nested leaf anchors to the nearest sibling level", () => {
  const dom = installDom();
  try {
    const { toolbar, a, b } = toolbarFixture(dom);
    const label = new FakeEl("span", "btn-b-label").at({ top: 20, height: 20 });
    b.append(label);
    const drop = computeDrop(label, a, 50, 25);
    assert.equal(drop?.container, toolbar, "skips the single-child button wrapper");
    assert.equal(drop?.before, b);
  } finally {
    dom.restore();
  }
});

test("computeDrop: pointer over a container's own box appends into it (reparent)", () => {
  const dom = installDom();
  try {
    const { toolbar, a } = toolbarFixture(dom);
    // `elementFromPoint` returns the container itself for padding/gap areas.
    const drop = computeDrop(toolbar, a, 5, 5);
    assert.equal(drop?.container, toolbar);
    assert.equal(drop?.before, null);
  } finally {
    dom.restore();
  }
});

test("computeDrop: dropping into the dragged element's own parent is allowed", () => {
  const dom = installDom();
  try {
    const { toolbar, a } = toolbarFixture(dom);
    const drop = computeDrop(toolbar, a, 5, 5);
    assert.equal(drop?.container, toolbar);
  } finally {
    dom.restore();
  }
});

test("computeDrop: refuses overlay chrome, the page root, and cycles", () => {
  const dom = installDom();
  try {
    const { toolbar, a, b } = toolbarFixture(dom);
    const ghost = new FakeEl("div", "__ef_drag_ghost__");
    dom.body.append(ghost);

    assert.equal(computeDrop(ghost, a, 0, 0), null, "overlay chrome");
    assert.equal(computeDrop(dom.body, a, 0, 0), null, "document body");
    assert.equal(computeDrop(a, a, 0, 0), null, "onto itself");
    // A container inside the dragged element is a cycle.
    const inner = new FakeEl("div", "inner");
    a.append(inner);
    const child = new FakeEl("span", "inner-child");
    inner.append(child);
    assert.equal(computeDrop(inner, a, 0, 0), null, "into its own subtree");
    assert.equal(computeDrop(child, a, 0, 0), null, "into a deep descendant");
  } finally {
    dom.restore();
  }
});

test("moveElement: reorders and reports before → after anchors", () => {
  const dom = installDom();
  try {
    const { toolbar, a, b, c } = toolbarFixture(dom);
    const drop = computeDrop(c, a, 50, 55)!; // move btn-a to the end
    const placement = moveElement(a, drop);
    assert.deepEqual(ids(toolbar), ["btn-b", "btn-c", "btn-a"]);
    assert.equal(placement?.from.label, "1st of 3 in #toolbar");
    assert.equal(placement?.to.label, "3rd of 3 in #toolbar");
    assert.equal(placement?.to.before, null);
    assert.equal(b.parentElement, toolbar);
  } finally {
    dom.restore();
  }
});

test("moveElement: returns null for a no-op drop (same place)", () => {
  const dom = installDom();
  try {
    const { a, b } = toolbarFixture(dom);
    // btn-a is already before btn-b.
    assert.equal(moveElement(a, { container: b.parentElement!, before: b }), null);
  } finally {
    dom.restore();
  }
});

test("placeAt: replays a recorded anchor, before-selector winning over index", () => {
  const dom = installDom();
  try {
    const { toolbar, a, b, c } = toolbarFixture(dom);
    const from = captureAnchor(a)!;
    assert.equal(from.container, "#toolbar");
    assert.equal(from.before, "#btn-b");

    moveElement(a, computeDrop(c, a, 50, 55)!);
    assert.deepEqual(ids(toolbar), ["btn-b", "btn-c", "btn-a"]);

    assert.equal(placeAt(a, from), true);
    assert.deepEqual(ids(toolbar), ["btn-a", "btn-b", "btn-c"], "original order restored");
  } finally {
    dom.restore();
  }
});

test("placeAt: falls back to the recorded index when the sibling selector drifted", () => {
  const dom = installDom();
  try {
    const { toolbar, a } = toolbarFixture(dom);
    moveElement(a, { container: toolbar, before: null });
    assert.deepEqual(ids(toolbar), ["btn-b", "btn-c", "btn-a"]);

    // `before` points at a node that is gone; index 0 is the fallback.
    const restored = placeAt(a, { container: "#toolbar", before: "#gone", index: 0, label: "" });
    assert.equal(restored, true);
    assert.deepEqual(ids(toolbar), ["btn-a", "btn-b", "btn-c"]);
  } finally {
    dom.restore();
  }
});

test("placeAt: reports false when the container itself is gone", () => {
  const dom = installDom();
  try {
    const { a } = toolbarFixture(dom);
    assert.equal(placeAt(a, { container: "#nope", before: null, index: 0, label: "" }), false);
  } finally {
    dom.restore();
  }
});

test("captureAnchor: index and labels describe the current position", () => {
  const dom = installDom();
  try {
    const { b } = toolbarFixture(dom);
    const anchor = captureAnchor(b)!;
    assert.equal(anchor.index, 1);
    assert.equal(anchor.label, "2nd of 3 in #toolbar");
    assert.equal(anchor.before, "#btn-c");
  } finally {
    dom.restore();
  }
});
