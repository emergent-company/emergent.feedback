// order.ts — send a captured report to a coding-agent session (order-box).
//
// A third destination beside GitHub and Memory: instead of filing an issue, the
// report becomes one message in a running agent session, carrying the reporter's
// words plus everything the overlay already captured — the element, its source
// file, the edits the reporter made live on the page, the console errors and a
// screenshot. That is what makes it actionable without a follow-up question.
//
// Transport is order-box (a small session-front door, `cmd/order-box` in the
// rig repo). It is deliberately not part of this service's API: the destination
// is configured per host with `data-order-box` / `data-order-session`, and the
// browser posts to it directly. Nothing about the report is stored here.

import type { FeedbackIntent } from "./envelope";

/** One report as order-box receives it. */
export interface OrderPayload {
  /** The reporter's message, verbatim. */
  text: string;
  /** Report title (the composer's topic line). */
  title: string;
  /** bug | enhancement — the same tagging the issue export uses. */
  type: string;
  repo: string;
  /** CSS selector of the element the reporter pointed at. */
  selector: string;
  /** Full page URL. */
  url: string;
  /** Page path + query, which is what the order is prefixed with. */
  page: string;
  sent_at: string;
  /** Element screenshot as a data URL; order-box writes it to a file. */
  screenshot?: string;
  /**
   * Why the screenshot is missing, when the browser could not capture it. The
   * order says "unavailable — <reason>" instead of omitting the line, so a
   * silent gap never looks like a complete report.
   */
  screenshot_error?: string;
  /** The full capture, including `intent` and `intent.changes`. */
  context: Record<string, unknown>;
}

/** What order-box answers: when it landed, and where the screenshot went. */
export interface OrderDelivery {
  at: string;
  screenshot?: string;
  note?: string;
}

export interface BuildOrderInput {
  text: string;
  title: string;
  type: string;
  repo: string;
  selector: string;
  url: string;
  screenshot?: string;
  /** Why the capture failed, when it did. */
  screenshotError?: string;
  context: Record<string, unknown>;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Builds the order body. Pure, so the exact shape posted to order-box is
 * testable without a browser or a server.
 */
export function buildOrderPayload(input: BuildOrderInput): OrderPayload {
  const url = input.url;
  return {
    text: input.text.trim(),
    title: input.title.trim(),
    type: input.type,
    repo: input.repo,
    selector: input.selector,
    url,
    page: pagePath(url),
    sent_at: (input.now ?? new Date()).toISOString(),
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
    ...(!input.screenshot && input.screenshotError
      ? { screenshot_error: input.screenshotError }
      : {}),
    context: input.context,
  };
}

/** Page path plus query — the part an order is about, without the host. */
export function pagePath(url: string): string {
  // Only absolute URLs can be reduced; anything else is already a path.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url.startsWith("/") ? stripHash(url) : url;
  }
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function stripHash(value: string): string {
  const i = value.indexOf("#");
  return i >= 0 ? value.slice(0, i) : value;
}

/** Where a session destination posts, for the same base URL the box serves. */
export function orderEndpoint(base: string, session: string): string {
  return `${base.replace(/\/+$/, "")}/o/${encodeURIComponent(session)}/order`;
}

/**
 * Delivers one order. The browser posts straight to order-box: the token is
 * either the box's own cookie (`credentials: "include"`, same host) or an
 * explicit `data-order-token` sent as a bearer header.
 *
 * Errors are thrown as `OrderError` with a message the dialog shows verbatim —
 * a refused delivery must never look like a success.
 */
export async function sendOrder(
  base: string,
  session: string,
  token: string | undefined,
  payload: OrderPayload,
  init?: { fetch?: typeof fetch; signal?: AbortSignal }
): Promise<OrderDelivery> {
  const doFetch = init?.fetch ?? fetch;
  const resp = await doFetch(orderEndpoint(base, session), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    ...(init?.signal ? { signal: init.signal } : {}),
  });

  let body: unknown;
  const text = await resp.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!resp.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const message =
      resp.status === 401
        ? `order-box refused this browser — open ${base.replace(/\/+$/, "")}/o/${session}/ once with its token`
        : String(b.error ?? b.message ?? text ?? `HTTP ${resp.status}`);
    throw new OrderError(resp.status, message);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  return {
    at: String(b.at ?? ""),
    ...(typeof b.screenshot === "string" ? { screenshot: b.screenshot } : {}),
    ...(typeof b.note === "string" ? { note: b.note } : {}),
  };
}

/** A delivery failure, carrying the HTTP status for the caller to branch on. */
export class OrderError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "OrderError";
  }
}

/**
 * Whether an order can be offered at all: it needs a box URL and a session id.
 * A malformed id is a configuration mistake, so it is reported once, loudly,
 * rather than failing on the first send.
 */
export function orderConfigValid(base: string | undefined, session: string | undefined): boolean {
  if (!base || !session) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session);
}

/** Short session id, for button labels and toasts. */
export function shortSession(session: string): string {
  return session.slice(0, 8);
}

/** Re-exported for callers that build the order from a dialog intent. */
export type { FeedbackIntent };
