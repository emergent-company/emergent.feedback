// drafts.ts — page-scoped registry of in-progress feedback reports.
//
// A draft is the text/metadata half of a report: what the reporter typed, the
// element it belongs to, and every target it touched. The live DOM edits that
// belong to the draft are owned by selection.ts (keyed by draft id), so
// switching reports can suspend one draft and resume another without leaking
// styles between them.
//
// Storage is best-effort sessionStorage: failures must never block feedback.

export type FeedbackType = "bug" | "enhancement";

export interface DraftTarget {
  selector: string;
  dataComponent?: string;
}

export interface DraftRecord {
  id: string;
  pageKey: string;
  selector: string;
  targets: DraftTarget[];
  comment: string;
  title: string;
  type: FeedbackType;
  updatedAt: number;
}

const STORE_PREFIX = "__ef_drafts__:";
const LEGACY_PREFIX = "__ef_draft__:";

function pageStoreKey(pageKey: string): string {
  return `${STORE_PREFIX}${pageKey}`;
}

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function isDraftTarget(value: unknown): value is DraftTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return typeof t.selector === "string" && t.selector.length > 0;
}

function asDraft(value: unknown, pageKey: string): DraftRecord | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return null;
  if (typeof d.selector !== "string" || !d.selector) return null;
  const targets = Array.isArray(d.targets)
    ? d.targets.filter(isDraftTarget).map((t) => ({
        selector: t.selector,
        ...(typeof t.dataComponent === "string" && t.dataComponent
          ? { dataComponent: t.dataComponent }
          : {}),
      }))
    : [];
  return {
    id: d.id,
    pageKey,
    selector: d.selector,
    targets,
    comment: typeof d.comment === "string" ? d.comment : "",
    title: typeof d.title === "string" ? d.title : "",
    type: d.type === "bug" ? "bug" : "enhancement",
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Date.now(),
  };
}

/** All drafts for a page, newest first. */
export function listDrafts(pageKey: string): DraftRecord[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(pageStoreKey(pageKey));
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => asDraft(item, pageKey))
    .filter((d): d is DraftRecord => d !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeAll(pageKey: string, drafts: DraftRecord[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(pageStoreKey(pageKey), JSON.stringify(drafts));
  } catch {
    // Private mode / quota / sandboxed iframe — ignore.
  }
}

export function getDraft(pageKey: string, id: string): DraftRecord | null {
  return listDrafts(pageKey).find((d) => d.id === id) ?? null;
}

export function findDraftBySelector(pageKey: string, selector: string): DraftRecord | null {
  return listDrafts(pageKey).find((d) => d.selector === selector) ?? null;
}

function newId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `d_${Date.now().toString(36)}_${rand}`;
}

/** Build an unsaved draft record (call `saveDraft` to persist it). */
export function emptyDraft(
  pageKey: string,
  selector: string,
  targets: DraftTarget[],
  title: string
): DraftRecord {
  return {
    id: newId(),
    pageKey,
    selector,
    targets,
    comment: "",
    title,
    type: "enhancement",
    updatedAt: Date.now(),
  };
}

/** Insert or replace a draft (matched by id). */
export function saveDraft(draft: DraftRecord): void {
  const drafts = listDrafts(draft.pageKey).filter((d) => d.id !== draft.id);
  drafts.push({ ...draft, updatedAt: Date.now() });
  writeAll(draft.pageKey, drafts);
}

/** Patch an existing draft; returns the updated record (or null). */
export function updateDraft(
  pageKey: string,
  id: string,
  patch: Partial<Omit<DraftRecord, "id" | "pageKey">>
): DraftRecord | null {
  const drafts = listDrafts(pageKey);
  const idx = drafts.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const next: DraftRecord = { ...drafts[idx], ...patch, id, pageKey, updatedAt: Date.now() };
  drafts[idx] = next;
  writeAll(pageKey, drafts);
  return next;
}

export function deleteDraft(pageKey: string, id: string): void {
  writeAll(pageKey, listDrafts(pageKey).filter((d) => d.id !== id));
}

/**
 * Import legacy per-selector `__ef_draft__:<href>|<selector>` keys into the
 * page store once. `legacyPageKeys` lets the caller pass the raw `location.href`
 * alongside the normalised page key (exact vs path matching).
 */
export function migrateLegacyDrafts(pageKey: string, legacyPageKeys: string[] = []): void {
  const store = storage();
  if (!store) return;
  const prefixes = Array.from(new Set([pageKey, ...legacyPageKeys].filter(Boolean))).map(
    (k) => `${LEGACY_PREFIX}${k}|`
  );
  if (prefixes.length === 0) return;

  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) keys.push(key);
    }
  } catch {
    return;
  }

  const drafts = listDrafts(pageKey);
  let changed = false;
  for (const key of keys) {
    const prefix = prefixes.find((p) => key.startsWith(p));
    if (!prefix) continue;
    const selector = key.slice(prefix.length);
    if (!selector) continue;
    let raw: string | null = null;
    try {
      raw = store.getItem(key);
    } catch {
      raw = null;
    }
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
    if (!raw) continue;
    if (drafts.some((d) => d.selector === selector)) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const legacy = parsed as Record<string, unknown>;
    drafts.push({
      id: newId(),
      pageKey,
      selector,
      targets: [{ selector }],
      comment: typeof legacy.comment === "string" ? legacy.comment : "",
      title: typeof legacy.title === "string" ? legacy.title : "",
      type: legacy.type === "bug" ? "bug" : "enhancement",
      updatedAt: Date.now(),
    });
    changed = true;
  }
  if (changed) writeAll(pageKey, drafts);
}
