// test/drafts.test.ts — page-scoped draft registry (CRUD, lookup, migration).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  deleteDraft,
  emptyDraft,
  findDraftBySelector,
  getDraft,
  listDrafts,
  migrateLegacyDrafts,
  saveDraft,
  updateDraft,
  type DraftRecord,
} from "../src/drafts";

function makeStorage(): Storage {
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
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = makeStorage();
});

const newDraft = (selector: string, title = "Title"): DraftRecord =>
  emptyDraft("http://example.test/page", selector, [{ selector }], title);

test("saveDraft / listDrafts: round-trips drafts newest-first", async () => {
  const a = newDraft("#a");
  const b = newDraft("#b");
  saveDraft(a);
  // saveDraft stamps updatedAt with Date.now(); wait so ordering is stable.
  await new Promise((resolve) => setTimeout(resolve, 2));
  saveDraft(b);
  const list = listDrafts("http://example.test/page");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
});

test("findDraftBySelector / getDraft / updateDraft / deleteDraft", () => {
  const d = newDraft("#btn");
  saveDraft(d);
  assert.equal(findDraftBySelector("http://example.test/page", "#btn")?.id, d.id);
  assert.equal(getDraft("http://example.test/page", d.id)?.selector, "#btn");

  const updated = updateDraft("http://example.test/page", d.id, { comment: "hello" });
  assert.equal(updated?.comment, "hello");
  assert.equal(findDraftBySelector("http://example.test/page", "#btn")?.comment, "hello");

  deleteDraft("http://example.test/page", d.id);
  assert.equal(listDrafts("http://example.test/page").length, 0);
  assert.equal(findDraftBySelector("http://example.test/page", "#btn"), null);
});

test("drafts are page-scoped", () => {
  saveDraft(newDraft("#a"));
  assert.equal(listDrafts("http://example.test/other").length, 0);
});

test("migrateLegacyDrafts imports per-selector keys once and removes them", () => {
  const store = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
  const pageKey = "http://example.test/page";
  // Legacy key format: __ef_draft__:<href>|<selector>
  store.setItem(
    `__ef_draft__:${pageKey}#hash|#legacy`,
    JSON.stringify({ comment: "old text", title: "Old", type: "bug" })
  );

  migrateLegacyDrafts(pageKey, [`${pageKey}#hash`]);

  const imported = findDraftBySelector(pageKey, "#legacy");
  assert.ok(imported);
  assert.equal(imported.comment, "old text");
  assert.equal(imported.type, "bug");
  assert.equal(store.getItem(`__ef_draft__:${pageKey}#hash|#legacy`), null);

  // A second run must not duplicate it.
  migrateLegacyDrafts(pageKey, [`${pageKey}#hash`]);
  assert.equal(listDrafts(pageKey).length, 1);
});

test("migrateLegacyDrafts does not overwrite an existing draft for the selector", () => {
  const store = (globalThis as unknown as { sessionStorage: Storage }).sessionStorage;
  const pageKey = "http://example.test/page";
  const existing = newDraft("#same", "Newer");
  existing.comment = "current";
  saveDraft(existing);
  store.setItem(
    `__ef_draft__:${pageKey}|#same`,
    JSON.stringify({ comment: "stale", title: "Old", type: "enhancement" })
  );

  migrateLegacyDrafts(pageKey, [pageKey]);

  const drafts = listDrafts(pageKey);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].comment, "current");
});
