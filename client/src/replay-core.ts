// replay-core.ts — rrweb-backed buffered session replay (lazy bundle).
//
// This module is the rrweb-dependent implementation. It is bundled into the
// SEPARATE lazy bundle (`emergent-feedback-replay.js`) via replay.entry.ts, NOT
// into the main overlay bundle. The main bundle imports only the thin loader
// (`./replay`), so rrweb is never shipped unless replay is enabled.
//
// Behavior is unchanged from the previous in-bundle version: a bounded sliding
// buffer (~last 60s by default), a full-snapshot cadence derived from that
// window, privacy-by-default masking, and base64(gzip(JSON)) via
// CompressionStream with a plain-base64 fallback. The buffer + cadence logic
// lives in ./replay-buffer (pure, unit-testable); this module only adapts it to
// rrweb.

import { record } from "rrweb";
import { ReplayBuffer, checkoutEveryNms as computeCheckoutEveryNms } from "./replay-buffer";

let started = false;
let stopFn: (() => void) | undefined;
const buffer = new ReplayBuffer();

/**
 * Start buffering. Idempotent; no-op in iframes; catches any rrweb init
 * failure so the host page is never affected.
 */
export function startReplay(bufferMsOverride?: number, maskText?: boolean): void {
  if (started) return;
  if (window.top !== window.self) return;
  try {
    buffer.reset(bufferMsOverride);
    stopFn = record({
      emit: (event) => buffer.push(event),
      checkoutEveryNms: computeCheckoutEveryNms(buffer.window),
      maskAllInputs: true,
      maskInputOptions: { password: true, email: true, tel: true },
      // rrweb 2.x has no `maskAllText`; mask every element's text (via the
      // universal selector) when the opt-in flag is set, else only
      // [data-fo-redact].
      maskTextSelector: maskText === true ? "*" : "[data-fo-redact]",
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
  buffer.reset();
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
  const events = buffer.serialize();
  if (events.length === 0) return undefined;
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(events)));
}

/**
 * Upload payload: base64(gzip(JSON.stringify(events))). Falls back to plain
 * base64 (no gzip) when CompressionStream is unavailable — callers cannot tell
 * which; the server treats the value as opaque base64.
 */
export async function getReplayPayloadAsync(): Promise<string | undefined> {
  const events = buffer.serialize();
  if (events.length === 0) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  const gzipped = await tryGzip(bytes);
  return bytesToBase64(gzipped ?? bytes);
}
