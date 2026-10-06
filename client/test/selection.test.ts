// test/selection.test.ts — multi-target set, dedupe, change tracking, revert.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addTarget,
  removeTarget,
  toggleTarget,
  pickTarget,
  getTargets,
  getTargetCount,
  hasTarget,
  clear,
  applyTokenToTargets,
  getChanges,
  getChangeCount,
  revertAll,
  commit,
  onSelectionChange,
} from "../src/selection";
import type { TokenGroup } from "../src/tokens";

class FakeClassList {
  private set = new Set<string>();
  constructor(classes: string[] = []) { for (const c of classes) this.set.add(c); }
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
  constructor(classes: string[] = []) { this.classList = new FakeClassList(classes); }
}

const el = (classes: string[] = []): Element => new FakeEl(classes) as unknown as Element;

const paddingGroup: TokenGroup = {
  id: "padding",
  label: "Padding",
  applyType: "class",
  removePattern: "^p[xytrbl]?-",
  tokens: [
    { id: "none", label: "None", className: "p-0" },
    { id: "md", label: "Medium", className: "p-4" },
    { id: "lg", label: "Large", className: "p-6" },
  ],
};

const textGroup: TokenGroup = {
  id: "textColor",
  label: "Text color",
  applyType: "class",
  removePattern: "^text-",
  tokens: [
    { id: "base", label: "Default", className: "text-base-content" },
    { id: "primary", label: "Primary", className: "text-primary" },
  ],
};

beforeEach(() => clear());

test("addTarget: dedupes by element identity", () => {
  const a = el();
  assert.equal(addTarget(a, "#a"), true);
  assert.equal(addTarget(a, "#a"), false);
  assert.equal(getTargetCount(), 1);
});

test("toggleTarget: adds then removes, and exposes membership", () => {
  const a = el();
  assert.equal(toggleTarget(a, "#a"), true);
  assert.equal(hasTarget(a), true);
  assert.equal(toggleTarget(a, "#a"), false);
  assert.equal(hasTarget(a), false);
  assert.equal(getTargetCount(), 0);
});

test("removeTarget: drops the element and its applied changes", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens[1]);
  assert.equal(getChangeCount(), 2);

  removeTarget(a);
  assert.equal(getTargetCount(), 1);
  assert.equal(getChangeCount(), 1);
  assert.equal(getChanges()[0].target, "#b");
});

test("applyTokenToTargets: applies to all targets and records selector/group/before→after", () => {
  const a = el(["btn", "p-0"]);
  const b = el(["card"]);
  addTarget(a, "#a");
  addTarget(b, "#b");

  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);

  assert.ok(a.classList.contains("p-4"));
  assert.ok(b.classList.contains("p-4"));
  assert.ok(!a.classList.contains("p-0"));
  assert.equal(a.classList.contains("btn") && b.classList.contains("card"), true);

  const changes = getChanges();
  assert.equal(changes.length, 2);
  const forA = changes.find((c) => c.target === "#a")!;
  assert.deepEqual(forA, { target: "#a", group: "padding", before: "p-0", after: "p-4" });
  const forB = changes.find((c) => c.target === "#b")!;
  assert.equal(forB.before, "");
  assert.equal(forB.after, "p-4");
});

test("applyTokenToTargets: dedupes per target+group, keeping the latest", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "lg")!);
  assert.equal(getChangeCount(), 1);
  const c = getChanges()[0];
  assert.equal(c.before, "p-0");
  assert.equal(c.after, "p-6");

  // A different group adds a second record for the same target.
  applyTokenToTargets(textGroup, textGroup.tokens.find((t) => t.id === "primary")!);
  assert.equal(getChangeCount(), 2);
});

test("revertAll: restores the host page and clears records", () => {
  const a = el(["btn", "p-0"]);
  addTarget(a, "#a");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  assert.ok(a.classList.contains("p-4"));

  revertAll();
  assert.equal(getChangeCount(), 0);
  assert.ok(!a.classList.contains("p-4"));
  assert.ok(a.classList.contains("p-0"));
  assert.equal(getTargetCount(), 1, "selection is kept after revert");
});

test("commit: keeps DOM edits but stops tracking them", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);

  commit();
  assert.equal(getChangeCount(), 0);
  assert.equal(getTargetCount(), 0);
  // The applied class survives — later teardown must not undo it.
  assert.ok(a.classList.contains("p-4"));
  revertAll();
  assert.ok(a.classList.contains("p-4"), "no-op revert after commit");
});

test("pickTarget: one-shot add; onSelectionChange fires", () => {
  let events = 0;
  const off = onSelectionChange(() => { events += 1; });
  const a = el();
  pickTarget(a, "#a");
  assert.equal(hasTarget(a), true);
  assert.ok(events >= 1);
  off();
});

test("getTargets: returns a copy, not internal state", () => {
  const a = el();
  addTarget(a, "#a");
  const snapshot = getTargets();
  snapshot.pop();
  assert.equal(getTargetCount(), 1);
});
