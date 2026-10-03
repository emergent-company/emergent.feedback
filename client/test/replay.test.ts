// test/replay.test.ts — replay buffer window/checkout coupling + snapshot retention.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReplayBuffer,
  checkoutEveryNms,
  clamp,
  DEFAULT_BUFFER_MS,
} from "../src/replay-buffer";

// rrweb EventType numeric values (kept in sync with @rrweb/types).
const META = 4;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;

// Minimal eventWithTime-shaped objects (types erased at runtime in tests).
type Ev = { type: number; timestamp: number };
const meta = (ts: number): Ev => ({ type: META, timestamp: ts });
const full = (ts: number): Ev => ({ type: FULL_SNAPSHOT, timestamp: ts });
const inc = (ts: number): Ev => ({ type: INCREMENTAL, timestamp: ts });

test("checkoutEveryNms is derived from the window and clamped to [1s, 30s]", () => {
  assert.equal(checkoutEveryNms(3000), 1500); // 3s window → 1.5s
  assert.equal(checkoutEveryNms(5000), 2500); // 5s window → 2.5s
  assert.equal(checkoutEveryNms(1000), 1000); // clamp floor
  assert.equal(checkoutEveryNms(60_000), 30_000); // 60s window → 30s
  assert.equal(checkoutEveryNms(600_000), 30_000); // clamp ceiling
  assert.equal(checkoutEveryNms(200), 1000); // tiny window → floor 1s
});

test("clamp keeps values within [min, max]", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(0, 1, 10), 1);
  assert.equal(clamp(11, 1, 10), 10);
});

test("short window retains Meta + FullSnapshot even after they age out", () => {
  const b = new ReplayBuffer();
  b.reset(3000); // 3s window

  b.push(meta(0)); // replay init state
  b.push(full(100)); // baseline full snapshot
  for (let t = 200; t <= 6000; t += 100) b.push(inc(t)); // push far past the window

  const events = b.serialize();
  const types = events.map((e) => e.type);

  // Meta is retained (replay init state).
  assert.ok(types.includes(META), "Meta event evicted");
  // At least one FullSnapshot survives so the buffer is replayable.
  assert.ok(types.includes(FULL_SNAPSHOT), "FullSnapshot evicted — buffer unreplayable");

  // The retained FullSnapshot must be the baseline preceding the kept increments.
  const fullIndex = events.findIndex((e) => e.type === FULL_SNAPSHOT);
  assert.ok(fullIndex >= 0, "no FullSnapshot in serialized events");
  assert.equal(events[events.length - 1].timestamp, 6000);
});

test("older FullSnapshot is evicted in favor of the newest one", () => {
  const b = new ReplayBuffer();
  b.reset(3000);
  b.push(meta(0));
  b.push(full(0));
  b.push(full(1600)); // newer snapshot supersedes the older one
  for (let t = 200; t <= 5000; t += 100) b.push(inc(t));

  const events = b.serialize();
  const snapshots = events.filter((e) => e.type === FULL_SNAPSHOT);
  assert.equal(snapshots.length, 1, "expected exactly one retained FullSnapshot");
  assert.equal(snapshots[0].timestamp, 1600, "old FullSnapshot was not evicted");
});

test("no-FullSnapshot case still keeps a baseline anchor", () => {
  const b = new ReplayBuffer();
  b.reset(1000);
  for (let t = 0; t <= 5000; t += 100) b.push(inc(t));
  assert.ok(b.serialize().length >= 1, "baseline anchor evicted");
});

test("default window is 60s", () => {
  const b = new ReplayBuffer();
  b.reset();
  assert.equal(b.window, DEFAULT_BUFFER_MS);
});
