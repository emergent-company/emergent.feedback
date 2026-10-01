// api.ts — all fetch() calls to the emergent.feedback microservice.

import type { OverlayConfig } from "./config";
import type { VerificationContract } from "./envelope";

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
  feedbackType?: string;
  screenshot?: string;
  snapshot?: string;
}

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

export class APIClient {
  private base: string;
  private token: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  constructor(config: OverlayConfig) {
    this.base = config.apiBase;
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
      throw new Error(`${resp.status}: ${text}`);
    }
    if (resp.status === 204 || resp.status === 205) {
      return undefined as T;
    }
    return resp.json() as Promise<T>;
  }

  /** Returns badge counts keyed by CSS selector for the given page URL. */
  async listBadges(url: string): Promise<BadgeSummary[]> {
    return this.fetchJSON<BadgeSummary[]>(
      `/feedback?url=${encodeURIComponent(url)}`
    );
  }

  /** Returns open GitHub issues recorded for the given page URL. */
  async listIssueBadges(url: string): Promise<IssueBadge[]> {
    return this.fetchJSON<IssueBadge[]>(
      `/issues?url=${encodeURIComponent(url)}`
    );
  }

  /** Returns full comment details for all open items on a page. */
  async listComments(url: string): Promise<FeedbackComment[]> {
    return this.fetchJSON<FeedbackComment[]>(
      `/feedback/list?url=${encodeURIComponent(url)}`
    );
  }

  /** Submits a new feedback item. Requires authentication. */
  async createFeedback(p: CreateFeedbackParams): Promise<{ id: number }> {
    return this.fetchJSON<{ id: number }>("/feedback", {
      method: "POST",
      body: JSON.stringify(p),
    });
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
      `/feedback/verify-pending?url=${encodeURIComponent(url)}`
    );
  }

  /** Fetch a single feedback item's verification contract and last result. */
  async getVerify(id: number): Promise<VerifyInfo> {
    return this.fetchJSON<VerifyInfo>(`/feedback/${id}/verify`);
  }

}
