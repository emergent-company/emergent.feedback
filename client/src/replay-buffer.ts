// replay-buffer.ts — pure sliding-window buffer for session replay.
//
// Extracted from replay-core.ts so the window/checkout coupling is unit-testable
// without importing rrweb. rrweb event types are referenced as plain numbers
// (matching rrweb's `EventType` enum in `@rrweb/types`) so this module stays free
// of any rrweb value import; the type import below is erased at build time.

import type { eventWithTime } from "rrweb";

/** rrweb EventType values — must stay in sync with `@rrweb/types`. */
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_META = 4;

export const DEFAULT_BUFFER_MS = 60_000;
export const DEFAULT_MAX_EVENTS = 5000;
export const MIN_CHECKOUT_NMS = 1_000;
export const MAX_CHECKOUT_NMS = 30_000;

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Full-snapshot cadence derived from the buffer window so at least one full
 * snapshot is always retained inside the window. `windowMs / 2` means a fresh
 * snapshot arrives twice per window; clamped to [1s, 30s] so a tiny window still
 * snapshots (≥1s) and a huge window doesn't snapshot more often than every 30s.
 *
 *   `clamp(windowMs / 2, 1000, 30000)`:
 *     3s window  → 1500ms
 *     5s window  → 2500ms
 *     60s+ window → 30000ms
 */
export function checkoutEveryNms(windowMs: number): number {
  return clamp(windowMs / 2, MIN_CHECKOUT_NMS, MAX_CHECKOUT_NMS);
}

/** Index of the newest FullSnapshot (type 2) in `events`, or -1 if none. */
export function newestFullSnapshotIndex(events: eventWithTime[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === EVENT_FULL_SNAPSHOT) return i;
  }
  return -1;
}

/**
 * Bounded sliding buffer for replay events. Retains the latest Meta (type 4)
 * separately and never evicts the newest FullSnapshot (type 2), so the buffer is
 * always replayable even when the window is shorter than the snapshot cadence.
 */
export class ReplayBuffer {
  private events: eventWithTime[] = [];
  private meta: eventWithTime | null = null;
  private windowMs = DEFAULT_BUFFER_MS;

  /** Reconfigure (or reset) the buffer, discarding all retained events. */
  reset(bufferMs?: number): void {
    this.events = [];
    this.meta = null;
    this.windowMs = bufferMs && bufferMs > 0 ? bufferMs : DEFAULT_BUFFER_MS;
  }

  /** Current buffer window in ms. */
  get window(): number {
    return this.windowMs;
  }

  /** Append an event, evicting stale entries while preserving the snapshot. */
  push(event: eventWithTime): void {
    // The latest Meta event carries replay init state (href/viewport); retain it
    // separately so it can always be prepended.
    if (event.type === EVENT_META) {
      this.meta = event;
      return;
    }

    this.events.push(event);

    // Time bound: drop events older than the window from the front, but never
    // evict the newest FullSnapshot — it is the replay baseline; dropping it
    // would leave only unreplayable incremental events. checkoutEveryNms is
    // derived from the window so a snapshot normally arrives within it, but this
    // guard keeps the buffer replayable even at the window edge.
    const cutoff = event.timestamp - this.windowMs;
    const newestFull = newestFullSnapshotIndex(this.events);
    const floor = newestFull >= 0 ? newestFull : this.events.length - 1;
    let drop = 0;
    while (drop < floor && this.events[drop].timestamp < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);

    // Count bound: hard cap on event count, again preserving the newest snapshot.
    while (this.events.length > DEFAULT_MAX_EVENTS) {
      const nf = newestFullSnapshotIndex(this.events);
      if (nf === 0) break; // newest snapshot already at front — keep it
      if (nf === -1 && this.events.length <= 1) break; // keep a baseline anchor
      this.events.shift();
    }
  }

  /** Meta (type 4) first, then buffered events, in order. */
  serialize(): eventWithTime[] {
    const out: eventWithTime[] = [];
    if (this.meta) out.push(this.meta);
    out.push(...this.events);
    return out;
  }
}
