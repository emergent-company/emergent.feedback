// notify.ts — reporter notification when a feedback item gets resolved/verified.
//
// Polls `GET /feedback/status?url=` while the overlay is active and toasts the
// reporter when an item they previously saw as open/applied transitions to a
// terminal "verified"/"resolved" state. Transition tracking persists in
// localStorage so a given transition is only announced once. Failure-tolerant:
// any API/localStorage error is a silent no-op and never spams.

import { showToast } from "./dialog";
import { getMode } from "./activation";
import type { APIClient } from "./api";

const SEEN_KEY = "__ef_seen_status__";
const POLL_INTERVAL_MS = 20_000;

let timer: number | null = null;

function isDone(status: string): boolean {
  return status === "verified" || status === "resolved";
}

/** Read the persisted id→status map (empty on any parse error). */
function readSeen(): Record<number, string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<number, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeSeen(map: Record<number, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    // ignore (private mode / quota exceeded)
  }
}

/** Shorten a selector for the toast; never throws. */
function shortSelector(selector: string): string {
  const s = selector.trim();
  return s.length <= 40 ? s : s.slice(0, 40) + "…";
}

/**
 * Start polling for status changes. Idempotent. Polls once immediately and
 * every ~20s thereafter, but only while the overlay is in "active" mode.
 */
export function startReporterNotify(api: APIClient): void {
  if (timer !== null) return;

  const tick = async () => {
    if (getMode() !== "active") return;
    try {
      const items = await api.listStatus(window.location.href);
      const seen = readSeen();
      let changed = false;

      for (const item of items) {
        const prev = seen[item.id];
        if (prev === undefined) {
          // First sighting: record current status, no toast.
          seen[item.id] = item.status;
          changed = true;
          continue;
        }
        if (isDone(item.status) && !isDone(prev)) {
          showToast(`Feedback on ${shortSelector(item.selector)} was ${item.status} ✓`);
          seen[item.id] = item.status;
          changed = true;
        } else if (prev !== item.status) {
          // Any other change: update silently.
          seen[item.id] = item.status;
          changed = true;
        }
      }

      if (changed) writeSeen(seen);
    } catch {
      // silent no-op
    }
  };

  tick();
  timer = window.setInterval(tick, POLL_INTERVAL_MS);
}

/** Stop polling. Safe to call when not running. */
export function stopReporterNotify(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

