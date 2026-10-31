// history.ts — session event recorder (ring buffer).
// Starts on page load, captures last N events for feedback context.

import { buildSelector, nearestComponent } from "./selector";
import { redactPII, sanitizeURL } from "./redact";

export interface SessionEvent {
  type: "navigation" | "input" | "click";
  timestamp: string;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 15;
let events: SessionEvent[] = [];
let started = false;
let lastInputKey = "";
let lastInputTime = 0;

type UrlChangeListener = (url: string) => void;
const urlChangeListeners = new Set<UrlChangeListener>();
let urlTrackingStarted = false;
let lastTrackedUrl = "";

function isOwnElement(el: Element): boolean {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (node.id && node.id.startsWith("__ef_")) return true;
    node = node.parentElement;
  }
  return false;
}

function pushEvent(type: SessionEvent["type"], data: Record<string, unknown>): void {
  events.push({ type, timestamp: new Date().toISOString(), data });
  if (events.length > MAX_EVENTS) events.shift();
}

// Common sensitive-field signals (name, id, autocomplete, aria-label) so
// tokens, card numbers, emails, phones, names, and SSNs never get recorded.
const SENSITIVE_FIELD =
  /(password|passwd|pwd|secret|token|api[_-]?key|credit|card|cvv|cvc|ssn|social.?security|routing|iban|email|e-mail|tel|phone|mobile|name|firstname|lastname|address|username|login|dob|birth)/;

// isSensitive reports whether a control's value should be redacted from session
// history. Treats password/email/tel inputs as sensitive regardless of name/id/
// autocomplete, plus any control whose name/id/autocomplete/aria-label matches
// the sensitive-field signals.
function isSensitive(el: Element): boolean {
  const type = (el as HTMLInputElement).type;
  if (type === "password" || type === "email" || type === "tel") return true;
  const hay = [
    el.getAttribute("name") ?? "",
    el.id,
    el.getAttribute("autocomplete") ?? "",
    el.getAttribute("aria-label") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return SENSITIVE_FIELD.test(hay);
}

// clickIsSensitive reports whether a clicked control's text should be redacted.
// Extends isSensitive to cover the control's associated <label> text and, when
// the target is itself a <label>, the control it labels.
function clickIsSensitive(el: Element): boolean {
  if (isSensitive(el)) return true;
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    for (const label of Array.from(labels)) {
      if (label.textContent && SENSITIVE_FIELD.test(label.textContent.toLowerCase())) return true;
    }
  }
  if (el.tagName.toLowerCase() === "label") {
    const htmlFor = el.getAttribute("for");
    if (htmlFor) {
      const control = document.getElementById(htmlFor);
      if (control && isSensitive(control)) return true;
    }
  }
  return false;
}

/**
 * Update `lastTrackedUrl`, record a navigation event (only when recording is
 * active) and notify overlay listeners. Called by the history patches and by
 * native popstate / hashchange / pageshow events.
 */
function notifyUrlChange(): void {
  const nextUrl = window.location.href;
  const prevUrl = lastTrackedUrl;
  if (nextUrl === prevUrl) return;
  lastTrackedUrl = nextUrl;

  if (started) {
    pushEvent("navigation", { url: sanitizeURL(nextUrl), previousUrl: sanitizeURL(prevUrl), title: document.title });
  }

  for (const cb of Array.from(urlChangeListeners)) {
    try {
      cb(nextUrl);
    } catch {
      // A listener must never break navigation tracking.
    }
  }
}

/**
 * Install URL tracking (including SPA pushState/replaceState) once. This is
 * independent of session recording so badges still follow navigation in a
 * frame or before startRecording flips `started`.
 */
function startUrlTracking(): void {
  if (urlTrackingStarted) return;
  urlTrackingStarted = true;
  lastTrackedUrl = window.location.href;

  window.addEventListener("popstate", notifyUrlChange);
  window.addEventListener("hashchange", notifyUrlChange);
  window.addEventListener("pageshow", notifyUrlChange);

  // Idempotent monkey-patching: wrap only once even if this is re-entered, and
  // preserve the original return values.
  const PATCHED = "__ef_history_patched__";
  if (!(history as unknown as Record<string, unknown>)[PATCHED]) {
    (history as unknown as Record<string, unknown>)[PATCHED] = true;

    const origPushState = history.pushState.bind(history);
    history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = origPushState(...args);
      notifyUrlChange();
      return r;
    };

    const origReplaceState = history.replaceState.bind(history);
    history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
      const r = origReplaceState(...args);
      notifyUrlChange();
      return r;
    };
  }
}

/**
 * Subscribe to page URL changes (popstate, hashchange, pushState,
 * replaceState). Returns an unsubscribe function.
 */
export function onUrlChange(cb: UrlChangeListener): () => void {
  startUrlTracking();
  urlChangeListeners.add(cb);
  return () => {
    urlChangeListeners.delete(cb);
  };
}

export function startRecording(): void {
  startUrlTracking();
  if (started) return;
  if (window.top !== window.self) return;
  started = true;

  document.addEventListener("input", (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target || isOwnElement(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    const el = target as HTMLInputElement;

    const selector = buildSelector(target);
    const component = nearestComponent(target);
    const key = `${selector}_${tag}`;
    const now = Date.now();

    if (key === lastInputKey && now - lastInputTime < 500) {
      const last = events[events.length - 1];
      if (last?.type === "input") {
        last.data.value = isSensitive(el) ? "[redacted]" : redactPII(el.value);
        last.timestamp = new Date().toISOString();
        lastInputTime = now;
        return;
      }
    }
    lastInputKey = key;
    lastInputTime = now;

    pushEvent("input", {
      selector,
      component,
      tagName: tag,
      inputType: el.type || "text",
      value: isSensitive(el) ? "[redacted]" : redactPII(el.value),
    });
  }, true);

  document.addEventListener("change", (e: Event) => {
    const target = e.target as HTMLElement;
    if (!target || isOwnElement(target)) return;
    if (target.tagName.toLowerCase() !== "select") return;
    const el = target as HTMLSelectElement;
    pushEvent("input", {
      selector: buildSelector(target),
      component: nearestComponent(target),
      tagName: "select",
      inputType: "select",
      value: isSensitive(el) ? "[redacted]" : redactPII(el.value),
    });
  }, true);

  document.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as Element;
    if (!target || isOwnElement(target)) return;
    const tag = target.tagName.toLowerCase();
    const role = target.getAttribute("role");
    if (tag !== "a" && tag !== "button" && role !== "button") return;
    const raw = (target.textContent || "").trim().slice(0, 80);
    const text = clickIsSensitive(target) ? "[redacted]" : redactPII(raw);
    pushEvent("click", {
      selector: buildSelector(target),
      component: nearestComponent(target),
      tagName: tag,
      text,
    });
  }, true);
}

export function getHistory(): SessionEvent[] {
  return events.slice();
}

export function clearHistory(): void {
  events = [];
  lastInputKey = "";
  lastInputTime = 0;
}
