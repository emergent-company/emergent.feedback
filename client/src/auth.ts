// auth.ts — GitHub OAuth popup flow.

import type { APIClient } from "./api";
import type { OverlayConfig } from "./config";

export interface AuthUser {
  login: string;
  avatarUrl: string;
}

const AUTH_MESSAGE_TYPE = "emergent_feedback_auth";
const USER_KEY = "__ef_user__";

export class AuthManager {
  private user: AuthUser | null = null;
  private config: OverlayConfig;
  private api: APIClient;
  private messageHandler: ((e: MessageEvent) => void) | null = null;

  constructor(config: OverlayConfig, api: APIClient) {
    this.config = config;
    this.api = api;
    this.api.loadToken();
    // Restore user profile synchronously from localStorage — no round-trip needed.
    this.user = this.loadUser();
  }

  getUser(): AuthUser | null {
    return this.user;
  }

  isAuthenticated(): boolean {
    return this.api.isAuthenticated() && this.user !== null;
  }

  /**
   * Opens the GitHub OAuth popup. Resolves when the user completes auth
   * (via postMessage from the callback page) or rejects on timeout/cancel.
   */
  login(): Promise<AuthUser> {
    return new Promise((resolve, reject) => {
      const apiOrigin = this.apiOrigin();
      const authUrl = `${this.config.apiBase}/auth/github?origin=${encodeURIComponent(window.location.origin)}`;
      const popup = window.open(
        authUrl,
        "emergent_feedback_auth",
        "width=600,height=700,left=200,top=100"
      );

      if (!popup) {
        reject(new Error("Popup was blocked. Please allow popups for this site."));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Authentication timed out."));
      }, 5 * 60 * 1000); // 5 minutes

      const handler = (e: MessageEvent) => {
        if (e.data?.type !== AUTH_MESSAGE_TYPE) return;
        // Only accept the token from our own API origin — reject messages posted
        // by any other window to prevent login forgery.
        if (apiOrigin && e.origin !== apiOrigin) return;
        clearTimeout(timeout);
        cleanup();

        const { token, login, avatar } = e.data as {
          type: string;
          token: string;
          login: string;
          avatar: string;
        };
        this.api.setToken(token);
        this.user = { login, avatarUrl: avatar };
        this.saveUser(this.user);
        resolve(this.user);
      };

      const cleanup = () => {
        window.removeEventListener("message", handler);
        this.messageHandler = null;
        if (!popup.closed) popup.close();
      };

      this.messageHandler = handler;
      window.addEventListener("message", handler);

      // Poll for popup closure (user closed without completing auth).
      const poll = setInterval(() => {
        if (popup.closed) {
          clearInterval(poll);
          if (this.messageHandler === handler) {
            cleanup();
            clearTimeout(timeout);
            reject(new Error("Authentication cancelled."));
          }
        }
      }, 500);
    });
  }

  logout(): void {
    this.clearSession();
  }

  /** Returns the origin of the API base URL, or "" if it can't be parsed. */
  private apiOrigin(): string {
    try {
      return new URL(this.config.apiBase).origin;
    } catch {
      return "";
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private saveUser(user: AuthUser): void {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* storage unavailable */ }
  }

  private loadUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as
        | (Partial<AuthUser> & { avatar?: string })
        | null;
      if (!parsed || typeof parsed !== "object" || typeof parsed.login !== "string") {
        return null;
      }
      return {
        login: parsed.login,
        avatarUrl: parsed.avatarUrl ?? parsed.avatar ?? "",
      };
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    this.user = null;
    this.api.clearToken();
    try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
  }
}
