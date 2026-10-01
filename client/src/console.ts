// console.ts — ring buffer of console errors/warnings + uncaught errors.
//
// Captures the last N console.error/console.warn calls and window-level
// 'error' / 'unhandledrejection' events for the feedback `repro.console`
// payload. Every message is token-redacted and has sensitive URL query params
// scrubbed before being retained.

import { redactText, sanitizeURL } from "./redact";

export interface ConsoleEntry {
  level: "error" | "warning";
  message: string;
  at: string; // ISO timestamp
  stack?: string; // capture-time stack trace (redacted, ≤4000 chars)
}

const MAX_ENTRIES = 20;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

let entries: ConsoleEntry[] = [];
let started = false;

/** Stringify any console arg (including Error objects) safely. */
function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) {
    return v.stack ? `${v.name}: ${v.message}\n${v.stack}` : `${v.name}: ${v.message}`;
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Sanitize URLs embedded in free text without mangling the surrounding prose. */
function sanitizeMessage(raw: string): string {
  const redacted = redactText(raw);
  return redacted.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => sanitizeURL(url));
}

/** Read a `.stack` off an arbitrary thrown value, if it is a string. */
function errorStack(v: unknown): string | undefined {
  if (v && typeof v === "object" && typeof (v as { stack?: unknown }).stack === "string") {
    return (v as { stack: string }).stack;
  }
  return undefined;
}

/** Redact + truncate a stack trace. Server unmaps it against source maps. */
function redactStack(stack: string): string {
  return redactText(stack).slice(0, MAX_STACK);
}

function push(level: ConsoleEntry["level"], message: string, stack?: string): void {
  const trimmed = sanitizeMessage(message).slice(0, MAX_MESSAGE);
  const entry: ConsoleEntry = { level, message: trimmed, at: new Date().toISOString() };
  if (stack) entry.stack = redactStack(stack);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Begin capturing console output. Idempotent; no-op inside iframes. */
export function startConsoleCapture(): void {
  if (started) return;
  if (window.top !== window.self) return;
  started = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    push("error", args.map(stringify).join(" "), new Error().stack);
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warning", args.map(stringify).join(" "));
    origWarn(...args);
  };

  window.addEventListener("error", (e: ErrorEvent) => {
    push("error", stringify(e.error ?? e.message), errorStack(e.error) ?? new Error().stack);
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    push("error", stringify(e.reason), errorStack(e.reason));
  });
}

/** Return a copy of the current console buffer (oldest first). */
export function getConsoleErrors(): ConsoleEntry[] {
  return entries.slice();
}
