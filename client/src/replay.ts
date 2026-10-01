// replay.ts — opt-in buffered session replay via rrweb.
//
// Records DOM/input events into a bounded sliding buffer (~last 60s) and, on
// submit, serializes them to base64(gzip(JSON)). Privacy is on by default:
// all input values are masked, `[data-fo-redact]` text is masked, and
// `.fo-block` subtrees are excluded entirely. If rrweb fails to load/init it
// degrades to a no-op and never breaks the page.

import { record, EventType } from "rrweb";
import type { eventWithTime } from "rrweb";

const DEFAULT_BUFFER_MS = 60_000;
const DEFAULT_MAX_EVENTS = 5000;
const CHECKOUT_EVERY_NMS = 30_000; // force a full snapshot every 30s → replay baseline

let started = false;
let stopFn: (() => void) | undefined;
let buffer: eventWithTime[] = [];
let metaEvent: eventWithTime | null = null;
let bufferMs = DEFAULT_BUFFER_MS;

/**
 * Start buffering. Idempotent; no-op in iframes; catches any rrweb init
 * failure so the host page is never affected.
 */
export function startReplay(bufferMsOverride?: number): void {
  if (started) return;
  if (window.top !== window.self) return;
  try {
    bufferMs = bufferMsOverride && bufferMsOverride > 0 ? bufferMsOverride : DEFAULT_BUFFER_MS;
    buffer = [];
    metaEvent = null;
    stopFn = record({
      emit: (event) => pushEvent(event),
      checkoutEveryNms: CHECKOUT_EVERY_NMS,
      maskAllInputs: true,
      maskInputOptions: { password: true, email: true, tel: true },
      maskTextSelector: "[data-fo-redact]",
      blockSelector: ".fo-block",
      recordCanvas: false,
      recordCrossOriginIframes: false,
    });
    started = true;
  } catch {
    started = false;
    stopFn = undefined;
  }
}

/** Stop recording and release the buffer. Safe to call when not running. */
export function stopReplay(): void {
  if (stopFn) {
    try {
      stopFn();
    } catch {
      // ignore
    }
    stopFn = undefined;
  }
  started = false;
  buffer = [];
  metaEvent = null;
}

function pushEvent(event: eventWithTime): void {
  // The first Meta event (type 4) carries replay initialization state
  // (href/viewport); retain it separately so it can always be prepended.
  if (event.type === EventType.Meta) {
    metaEvent = event;
    return;
  }

  buffer.push(event);

  // Bound memory: drop events older than the buffer window (but keep the last
  // retained event as a baseline anchor; checkoutEveryNms guarantees a full
  // snapshot well within the window).
  const cutoff = event.timestamp - bufferMs;
  while (buffer.length > 1 && buffer[0].timestamp < cutoff) {
    buffer.shift();
  }
  // Hard cap on event count as a second bound.
  while (buffer.length > DEFAULT_MAX_EVENTS) {
    buffer.shift();
  }
}

function serializeEvents(): eventWithTime[] {
  const events: eventWithTime[] = [];
  if (metaEvent) events.push(metaEvent);
  events.push(...buffer);
  return events;
}

/** base64-encode bytes without a stack overflow on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** gzip-compress bytes via CompressionStream, or undefined if unsupported/failed. */
async function tryGzip(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    if (typeof CompressionStream === "undefined") return undefined;
    const stream = new Blob([bytes.buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}

/**
 * Synchronous payload: base64 of the raw JSON (no gzip). Prefer
 * `getReplayPayloadAsync` for the gzip-compressed upload path.
 */
export function getReplayPayload(): string | undefined {
  const events = serializeEvents();
  if (events.length === 0) return undefined;
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(events)));
}

/**
 * Upload payload: base64(gzip(JSON.stringify(events))). Falls back to plain
 * base64 (no gzip) when CompressionStream is unavailable — callers cannot tell
 * which; the server treats the value as opaque base64.
 */
export async function getReplayPayloadAsync(): Promise<string | undefined> {
  const events = serializeEvents();
  if (events.length === 0) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  const gzipped = await tryGzip(bytes);
  return bytesToBase64(gzipped ?? bytes);
}
