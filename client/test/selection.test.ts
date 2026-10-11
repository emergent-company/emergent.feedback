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
  applyTokenToTarget,
  getChanges,
  getChangeCount,
  getChangesFor,
  getChangeCountFor,
  revertAll,
  revertChangesFor,
  commit,
  onSelectionChange,
  commitChanges,
  markSent,
  revertPending,
  loadCommitted,
  reapplyCommitted,
  getCommittedEntries,
  getCommittedCount,
  removeCommittedAt,
  clearCommitted,
  getCommittedChanges,
  getAllChanges,
  getAllChangesFor,
  getAllChangeCountFor,
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

function makeLocalStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => { map.set(k, String(v)); },
    removeItem: (k: string): void => { map.delete(k); },
    clear: (): void => { map.clear(); },
    key: (i: number): string | null => Array.from(map.keys())[i] ?? null,
    get length(): number { return map.size; },
  };
  return storage as unknown as Storage;
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeLocalStorage();
  clear();
  clearCommitted();
});

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

test("removeTarget: reverts the removed element's edits and drops its records", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens[1]);
  assert.equal(getChangeCount(), 2);
  assert.ok(a.classList.contains("p-4"));
  assert.ok(b.classList.contains("p-4"));

  removeTarget(a);
  assert.equal(getTargetCount(), 1);
  assert.equal(getChangeCount(), 1);
  assert.equal(getChanges()[0].target, "#b");
  // The removed target's host element is restored, not left edited.
  assert.ok(!a.classList.contains("p-4"));
  assert.ok(a.classList.contains("p-0"));
  // The remaining target keeps its edit.
  assert.ok(b.classList.contains("p-4"));
});

test("toggleTarget: toggling off reverts the applied edit", () => {
  const a = el(["p-0"]);
  toggleTarget(a, "#a");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens[1]);
  assert.ok(a.classList.contains("p-4"));

  toggleTarget(a, "#a"); // off
  assert.equal(hasTarget(a), false);
  assert.equal(getChangeCount(), 0);
  assert.ok(!a.classList.contains("p-4"));
  assert.ok(a.classList.contains("p-0"));
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

test("applyTokenToTarget: applies only to the given element and records a change", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");

  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);

  assert.ok(a.classList.contains("p-4"));
  assert.ok(!b.classList.contains("p-4"), "second target untouched");
  assert.equal(getChangeCountFor(a), 1);
  assert.equal(getChangeCountFor(b), 0);
  assert.deepEqual(getChangesFor(a)[0], { target: "#a", group: "padding", before: "p-0", after: "p-4" });
});

test("getChangesFor/getChangeCountFor: isolate one element's records", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");

  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  applyTokenToTargets(textGroup, textGroup.tokens.find((t) => t.id === "primary")!);

  assert.equal(getChangeCountFor(a), 2);
  assert.equal(getChangeCountFor(b), 2);
  assert.ok(getChangesFor(a).every((c) => c.target === "#a"));
  assert.ok(getChangesFor(b).every((c) => c.target === "#b"));
});

test("revertChangesFor: restores only the given element", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");

  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);

  revertChangesFor(a);
  assert.ok(!a.classList.contains("p-4"), "a restored");
  assert.ok(a.classList.contains("p-0"));
  assert.ok(b.classList.contains("p-4"), "b edit survives");
  assert.equal(getChangeCountFor(a), 0);
  assert.equal(getChangeCountFor(b), 1);
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

// ── Committed changes ─────────────────────────────────────────────────────────

const committedStorage = (): unknown[] =>
  JSON.parse((globalThis as unknown as { localStorage: Storage }).localStorage.getItem("__ef_committed__") ?? "[]");

test("commitChanges: promotes pending to committed, keeps DOM, persists", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  assert.equal(getChangeCount(), 1);

  commitChanges();

  assert.equal(getChangeCount(), 0);
  assert.equal(getCommittedCount(), 1);
  assert.ok(a.classList.contains("p-4"), "DOM edit kept");

  const stored = committedStorage();
  assert.equal(stored.length, 1);
  assert.equal((stored[0] as { selector: string }).selector, "#a");
  assert.equal((stored[0] as { after: string }).after, "p-4");
});

test("commitChanges: dedupes by element+group, preserving the ORIGINAL before", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!); // p-4
  commitChanges();
  assert.equal(getCommittedCount(), 1);

  // Re-edit the same group to p-6, then commit again.
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "lg")!);
  commitChanges();

  assert.equal(getCommittedCount(), 1, "deduped to a single committed record");
  const entries = getCommittedEntries();
  assert.equal(entries[0].before, "p-0", "ORIGINAL before preserved");
  assert.equal(entries[0].after, "p-6");
});

test("revertPending: reverts pending only; committed DOM survives", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  commitChanges(); // both p-4 become committed

  applyTokenToTarget(a, textGroup, textGroup.tokens.find((t) => t.id === "primary")!);
  assert.ok(a.classList.contains("text-primary"));

  revertPending();

  assert.ok(!a.classList.contains("text-primary"), "pending edit reverted");
  assert.ok(a.classList.contains("p-4"), "committed edit survives");
  assert.ok(b.classList.contains("p-4"), "other committed edit survives");
  assert.equal(getChangeCount(), 0);
  assert.equal(getCommittedCount(), 2);
});

test("revertAll: after commit, reverts committed DOM and clears storage", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  commitChanges();
  assert.ok(a.classList.contains("p-4"));

  revertAll();

  assert.ok(!a.classList.contains("p-4"), "committed edit reverted");
  assert.ok(a.classList.contains("p-0"));
  assert.equal(getCommittedCount(), 0);
  assert.deepEqual(committedStorage(), []);
});

test("markSent: promotes pending to committed", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);

  markSent();

  assert.equal(getChangeCount(), 0);
  assert.equal(getCommittedCount(), 1);
  assert.ok(a.classList.contains("p-4"));
});

test("loadCommitted: re-applies stored records; missing selector is stale", () => {
  const a = el(["p-0"]);
  const stored = [
    { selector: "#a", group: paddingGroup, token: paddingGroup.tokens[1], before: "p-0", after: "p-4" },
    { selector: "#gone", group: paddingGroup, token: paddingGroup.tokens[1], before: "", after: "p-4" },
  ];
  (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
    "__ef_committed__",
    JSON.stringify(stored)
  );

  const g = globalThis as unknown as { document: unknown };
  const prevDocument = g.document;
  g.document = {
    querySelector: (sel: string): Element | null => (sel === "#a" ? a : null),
  };
  try {
    loadCommitted();
  } finally {
    g.document = prevDocument;
  }

  const entries = getCommittedEntries();
  assert.equal(entries.length, 2);

  const forA = entries.find((e) => e.selector === "#a")!;
  assert.equal(forA.stale, false);
  assert.equal(forA.group, "padding");
  assert.equal(forA.groupLabel, "Padding");
  assert.equal(forA.after, "p-4");
  assert.ok(a.classList.contains("p-4"), "class re-applied on load");

  const gone = entries.find((e) => e.selector === "#gone")!;
  assert.equal(gone.stale, true);
});

test("reapplyCommitted: retries stale entries once their element mounts", () => {
  const stored = [
    { selector: "#late", group: paddingGroup, token: paddingGroup.tokens[1], before: "p-0", after: "p-4" },
  ];
  (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
    "__ef_committed__",
    JSON.stringify(stored)
  );

  const g = globalThis as unknown as { document: unknown };
  const prevDocument = g.document;

  // First pass: the target is not in the DOM yet → stale, not applied.
  g.document = { querySelector: (): Element | null => null };
  try {
    loadCommitted();
  } finally {
    g.document = prevDocument;
  }
  assert.equal(getCommittedEntries()[0].stale, true);

  // The element mounts later; the retry resolves + applies the stored edit.
  const a = el(["p-0"]);
  g.document = { querySelector: (sel: string): Element | null => (sel === "#late" ? a : null) };
  try {
    reapplyCommitted();
  } finally {
    g.document = prevDocument;
  }
  assert.equal(getCommittedEntries()[0].stale, false);
  assert.ok(a.classList.contains("p-4"), "late-mounted element received the committed edit");
});

test("removeCommittedAt: reverts that entry's DOM and persists", () => {
  const a = el(["p-0"]);
  const b = el(["p-0"]);
  addTarget(a, "#a");
  addTarget(b, "#b");
  applyTokenToTargets(paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  commitChanges();
  assert.equal(getCommittedCount(), 2);

  removeCommittedAt(0);

  assert.equal(getCommittedCount(), 1);
  assert.ok(!a.classList.contains("p-4"), "first entry reverted");
  assert.ok(b.classList.contains("p-4"), "second entry survives");
  assert.equal(committedStorage().length, 1);
});

test("clearCommitted: reverts all committed DOM and clears storage", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!);
  commitChanges();
  assert.ok(a.classList.contains("p-4"));

  clearCommitted();

  assert.equal(getCommittedCount(), 0);
  assert.ok(!a.classList.contains("p-4"));
  assert.deepEqual(committedStorage(), []);
});

test("getAllChanges / getCommittedChanges: pending + committed are distinguishable", () => {
  const a = el(["p-0"]);
  addTarget(a, "#a");
  applyTokenToTarget(a, paddingGroup, paddingGroup.tokens.find((t) => t.id === "md")!); // pending p-4
  commitChanges(); // committed p-4
  applyTokenToTarget(a, textGroup, textGroup.tokens.find((t) => t.id === "primary")!); // pending text-primary

  const committed = getCommittedChanges();
  assert.equal(committed.length, 1);
  assert.equal(committed[0].group, "padding");

  const all = getAllChanges();
  assert.equal(all.length, 2, "pending + committed");
  assert.deepEqual(all.map((c) => c.group).sort(), ["padding", "textColor"]);

  assert.equal(getAllChangeCountFor(a), 2);
  assert.deepEqual(getAllChangesFor(a).map((c) => c.group).sort(), ["padding", "textColor"]);
});
