// api.ts — all fetch() calls to the emergent.feedback microservice.

import type { OverlayConfig } from "./config";
import type { VerificationContract } from "./envelope";
import { normalizeUrl, pageUrl as currentPageUrl, type UrlMode } from "./url";

export class APIError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Sentinel thrown by `withAuthRetry` when the user declined the re-auth prompt.
 * Callers keep their dialog open and re-enable their buttons on this error.
 */
export class AuthCancelledError extends Error {
  constructor() {
    super("Authentication cancelled.");
    this.name = "AuthCancelledError";
  }
}

/**
 * Human-readable message for an error. Never leaks the raw `"<status>: "`
 * prefix that `APIClient` prefixes messages with; 401 gets a friendly
 * session-expired explanation.
 */
export function describeAPIError(err: unknown): string {
  if (!(err instanceof APIError)) return String(err);
  if (err.status === 401) return "Your session expired. Sign in to continue.";
  const prefix = `${err.status}: `;
  return err.message.startsWith(prefix)
    ? err.message.slice(prefix.length)
    : err.message;
}

/**
 * Wraps an operation so a 401 triggers a single re-auth + retry of the SAME
 * operation. Returns a thunk so the caller controls when it runs.
 *
 * - 401 → call `ensureAuth()`; if it resolves true, retry `fn` exactly once.
 * - 401 → `ensureAuth()` resolves false → throw `AuthCancelledError`.
 * - non-401 → rethrow unchanged (including a 401 from the retry itself).
 */
export function withAuthRetry<T>(
  fn: () => Promise<T>,
  ensureAuth: () => Promise<boolean>
): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof APIError && err.status === 401) {
        const ok = await ensureAuth();
        if (ok) return await fn();
        throw new AuthCancelledError();
      }
      throw err;
    }
  };
}

export type VerifyResult = "green" | "amber" | "red";

export interface VerifyPendingItem {
  id: number;
  selector: string;
  contract: VerificationContract;
}

export interface VerifyInfo {
  id: number;
  selector: string;
  contract: VerificationContract;
  last_result: VerifyResult | null;
  last_detail: string | null;
}

export interface FeedbackComment {
  id: number;
  selector: string;
  comment: string;
  github_user: string;
  created_at: string;
}

export interface BadgeSummary {
  selector: string;
  count: number;
  ids: number[];
}

export interface IssueBadge {
  selector: string;
  issue_number: number;
  issue_url: string;
  title: string;
}

export interface CreateFeedbackParams {
  url: string;
  selector: string;
  comment: string;
  context: Record<string, unknown>;
  repo: string;
  label: string;
  screenshot?: string;
  snapshot?: string;
  /** Opt-in session replay: base64 of gzip(rrweb JSON). */
  replay?: string;
  /** Reported opt-in when the repo's Memory mode is "ask". */
  memory_sync?: boolean;
}

/** Public overlay probe for a repo's Memory destination. No secrets. */
export interface MemoryStatus {
  connected: boolean;
  mode: "ask" | "auto" | "off";
}

/** One chat turn's message. The transcript is client-side only. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatTurnParams {
  repo: string;
  messages: ChatMessage[];
  /** Redacted capture context for the element under discussion. */
  context?: Record<string, unknown>;
  /** Optional Memory agent hint (data-chat-agent). */
  agent?: string;
}

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ExportIssueParams {
  ids: number[];
  repo: string;
  labels?: string[];
  title?: string;
}

export interface ExportIssueResult {
  issue_url: string;
  issue_number: number;
}

export interface FeedbackStatus {
  id: number;
  selector: string;
  status: string;
  issue_url: string;
}

export class APIClient {
  private base: string;
  private urlMode: UrlMode;
  private token: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  constructor(config: OverlayConfig) {
    this.base = config.apiBase;
    this.urlMode = config.badgeUrlMode === "path" ? "path" : "exact";
  }

  /** The current page URL under the configured badge URL mode. */
  pageUrl(): string {
    return currentPageUrl(this.urlMode);
  }

  /**
   * Build `name=value` for a URL query. In `path` mode the value is normalised
   * and `url_mode=path` tells the server to include legacy hash-keyed rows.
   */
  private urlQuery(name: string, url: string): string {
    const params = new URLSearchParams({ [name]: normalizeUrl(url, this.urlMode) });
    if (this.urlMode === "path") params.set("url_mode", "path");
    return params.toString();
  }

  /** Register a callback invoked when the server returns 401. */
  setOnUnauthorized(cb: () => void): void {
    this.onUnauthorized = cb;
  }

  setToken(token: string): void {
    this.token = token;
    localStorage.setItem("__ef_token__", token);
  }

  loadToken(): void {
    this.token = localStorage.getItem("__ef_token__");
  }

  clearToken(): void {
    this.token = null;
    localStorage.removeItem("__ef_token__");
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  private authHeaders(): HeadersInit {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  private async fetchJSON<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const contentTypeHeader: HeadersInit =
      method !== "GET" && method !== "HEAD"
        ? { "Content-Type": "application/json" }
        : {};
    const resp = await fetch(this.base + path, {
      ...init,
      headers: {
        ...contentTypeHeader,
        ...this.authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    if (!resp.ok) {
      if (resp.status === 401 && this.onUnauthorized) {
        this.onUnauthorized();
      }
      const text = await resp.text().catch(() => resp.statusText);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        const message = String(b.message ?? b.error ?? text);
        const code = typeof b.error === "string" ? b.error : undefined;
        throw new APIError(resp.status, `${resp.status}: ${message}`, code, body);
      }
      throw new APIError(resp.status, `${resp.status}: ${text}`);
    }
    if (resp.status === 204 || resp.status === 205) {
      return undefined as T;
    }
    return resp.json() as Promise<T>;
  }

  /** Returns badge counts keyed by CSS selector for the given page URL. */
  async listBadges(url: string): Promise<BadgeSummary[]> {
    return this.fetchJSON<BadgeSummary[]>(
      `/feedback?${this.urlQuery("url", url)}`
    );
  }

  /** Returns open GitHub issues recorded for the given page URL. */
  async listIssueBadges(url: string): Promise<IssueBadge[]> {
    return this.fetchJSON<IssueBadge[]>(
      `/issues?${this.urlQuery("url", url)}`
    );
  }

  /** Returns full comment details for all open items on a page. */
  async listComments(url: string): Promise<FeedbackComment[]> {
    return this.fetchJSON<FeedbackComment[]>(
      `/feedback/list?${this.urlQuery("url", url)}`
    );
  }

  /** Submits a new feedback item. Requires authentication. */
  async createFeedback(p: CreateFeedbackParams): Promise<{ id: number }> {
    return this.fetchJSON<{ id: number }>("/feedback", {
      method: "POST",
      body: JSON.stringify({ ...p, url: normalizeUrl(p.url, this.urlMode) }),
    });
  }

  /** Whether this repo has a Memory destination, and its submit mode. */
  async getMemoryStatus(repo: string): Promise<MemoryStatus> {
    return this.fetchJSON<MemoryStatus>(
      `/api/memory/status?repo=${encodeURIComponent(repo)}`
    );
  }

  /**
   * Streams one chat turn through the server's Memory-agent proxy.
   *
   * The proxy owns the prompt and the Memory credentials; the client only sends
   * the conversation plus the capture context it already redacts for feedback.
   * Events: token (incremental text), error (terminal), done (terminal).
   */
  async streamChat(
    p: ChatTurnParams,
    onEvent: (ev: ChatStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const resp = await fetch(this.base + "/api/memory/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(p),
      signal,
    });
    if (!resp.ok) {
      if (resp.status === 401 && this.onUnauthorized) this.onUnauthorized();
      const text = await resp.text().catch(() => resp.statusText);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const message = String(b.message ?? b.error ?? text);
      const code = typeof b.error === "string" ? b.error : undefined;
      // Chat errors are shown to the reporter verbatim, so no status prefix.
      throw new APIError(resp.status, message, code, body);
    }
    if (!resp.body) {
      onEvent({ type: "done" });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === "token" && typeof ev.token === "string") {
            onEvent({ type: "token", text: ev.token });
          } else if (ev.type === "error") {
            onEvent({ type: "error", message: String(ev.error ?? "The agent stopped.") });
          } else if (ev.type === "done") {
            onEvent({ type: "done" });
          }
          // meta / thinking / mcp_tool / citations are not rendered here.
        }
        idx = buf.indexOf("\n\n");
      }
    }
  }

  /** Deletes a feedback item. Requires authentication (own items only). */
  async deleteFeedback(id: number): Promise<void> {
    await this.fetchJSON<void>(`/feedback/${id}`, { method: "DELETE" });
  }

  /** Exports selected feedback items to a GitHub issue. */
  async exportIssue(p: ExportIssueParams): Promise<ExportIssueResult> {
    return this.fetchJSON<ExportIssueResult>("/issue/export", {
      method: "POST",
      body: JSON.stringify(p),
    });
  }

  /** Mark a feedback item as applied (edit landed). */
  async markApplied(id: number, summary?: string): Promise<unknown> {
    return this.fetchJSON(`/feedback/${id}/applied`, {
      method: "POST",
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  /** Mark a feedback item as resolved (verified done). */
  async markResolved(id: number, summary?: string): Promise<unknown> {
    return this.fetchJSON(`/feedback/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  /** Post a live verification-contract result for a feedback item. */
  async postVerifyResult(id: number, result: VerifyResult, detail?: string): Promise<unknown> {
    const body: Record<string, unknown> = { result };
    if (detail) body.detail = detail;
    return this.fetchJSON(`/feedback/${id}/verify-result`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** List feedback items on a page whose verification contract is awaiting re-check. */
  async getVerifyPending(url: string): Promise<VerifyPendingItem[]> {
    return this.fetchJSON<VerifyPendingItem[]>(
      `/feedback/verify-pending?${this.urlQuery("url", url)}`
    );
  }

  /** Fetch a single feedback item's verification contract and last result. */
  async getVerify(id: number): Promise<VerifyInfo> {
    return this.fetchJSON<VerifyInfo>(`/feedback/${id}/verify`);
  }

  /** List feedback items + statuses for a page URL. */
  async listStatus(url: string): Promise<FeedbackStatus[]> {
    return this.fetchJSON<FeedbackStatus[]>(
      `/feedback/status?${this.urlQuery("url", url)}`
    );
  }

}
