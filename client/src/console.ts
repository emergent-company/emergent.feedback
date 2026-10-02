// console.ts — ring buffer of console errors/warnings + uncaught errors.
//
// Captures the last N console.error/console.warn calls and window-level
// 'error' / 'unhandledrejection' events for the feedback `repro.console`
// payload. Every message is content-shaped PII-redacted and has sensitive URL
// query params scrubbed before being retained.

import { redactPII, sanitizeURL } from "./redact";

export interface StackFrame {
  path: string;
  line: number;
  column: number;
}

export interface ConsoleEntry {
  level: "error" | "warning";
  message: string;
  at: string; // ISO timestamp
  stack?: StackFrame[]; // parsed frames [{path,line,column}]
  stack_text?: string; // redacted raw stack (≤4000 chars) for humans
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
  const redacted = redactPII(raw);
  return redacted.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => sanitizeURL(url));
}

/** Read a `.stack` off an arbitrary thrown value, if it is a string. */
function errorStack(v: unknown): string | undefined {
  if (v && typeof v === "object" && typeof (v as { stack?: unknown }).stack === "string") {
    return (v as { stack: string }).stack;
  }
  return undefined;
}

/** Shorten an absolute filesystem path to its last 3 path segments. */
export function shortenFramePath(path: string): string {
  // URL / scheme (http:, https:, webpack:, file:) — keep as-is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return path;
  // Windows absolute path (C:\... or C:/...).
  const win = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (win) {
    const parts = win[2].split(/[\\/]/).filter(Boolean);
    if (parts.length <= 3) return path;
    return win[1] + ":\\" + parts.slice(-3).join("\\");
  }
  // Unix absolute path.
  if (path.startsWith("/")) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 3) return path;
    return "/" + parts.slice(-3).join("/");
  }
  return path;
}

/** Parse `path:line:col` into a frame, shortening absolute paths. */
function parseLocation(loc: string): StackFrame | undefined {
  const m = /^(.*?):(\d+):(\d+)$/.exec(loc.trim());
  if (!m) return undefined;
  const path = m[1].trim();
  if (!path) return undefined;
  return {
    path: shortenFramePath(path),
    line: parseInt(m[2], 10),
    column: parseInt(m[3], 10),
  };
}

/** Parse one stack line (V8 `at fn (path:l:c)` / `at path:l:c`, Firefox `fn@path:l:c`). */
function parseStackLine(line: string): StackFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  // Firefox: fn@path:line:col
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx >= 0) {
    const parsed = parseLocation(trimmed.slice(atIdx + 1));
    if (parsed) return parsed;
  }

  let rest = trimmed;
  const mAt = /^at\s+/.exec(rest);
  if (mAt) rest = rest.slice(mAt[0].length);

  // V8: at fn (path:line:col)
  const paren = rest.match(/\(([^()]*:\d+:\d+)\)$/);
  if (paren) {
    const parsed = parseLocation(paren[1]);
    if (parsed) return parsed;
  }

  // V8: at path:line:col (anonymous / module top-level)
  return parseLocation(rest);
}

/** Split a raw stack trace into frames, dropping unparseable lines. */
export function parseStack(raw: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const frame = parseStackLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** Redact + truncate the raw stack string for humans. */
export function redactStack(stack: string): string {
  return redactPII(stack).slice(0, MAX_STACK);
}

function push(level: ConsoleEntry["level"], message: string, stack?: string): void {
  const trimmed = sanitizeMessage(message).slice(0, MAX_MESSAGE);
  const entry: ConsoleEntry = { level, message: trimmed, at: new Date().toISOString() };
  if (stack) {
    const frames = parseStack(stack);
    if (frames.length > 0) entry.stack = frames;
    const stackText = redactStack(stack);
    if (stackText) entry.stack_text = stackText;
  }
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
