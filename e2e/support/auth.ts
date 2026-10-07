// auth.ts — inject a valid session into a browser context.
//
// Both the panel and the embedded overlay read their session from
// `localStorage.__ef_token__` (+ `__ef_user__` for the profile). The panel also
// adopts an `ef_panel_token` cookie as a fallback. Setting all three before any
// page script runs makes the pages believe a real GitHub OAuth login happened.

import type { BrowserContext } from "@playwright/test";
import { API_URL, JWT_SECRET, TEST_USER } from "./env";
import { mintToken } from "./jwt";

export interface TestUser {
  login: string;
  avatar?: string;
}

/** Mints a token and installs it into the given context. Returns the token. */
export async function signIn(context: BrowserContext, user: TestUser = TEST_USER): Promise<string> {
  const avatar = user.avatar ?? "";
  const token = mintToken({ login: user.login, avatar, secret: JWT_SECRET });

  await context.addInitScript(
    ({ token, login, avatar }) => {
      try {
        localStorage.setItem("__ef_token__", token);
        // `avatarUrl` is what the overlay reads; `avatar` is what the panel reads.
        localStorage.setItem(
          "__ef_user__",
          JSON.stringify({ login, avatarUrl: avatar, avatar }),
        );
      } catch {
        /* storage unavailable — the cookie fallback below still applies to the panel */
      }
    },
    { token, login: user.login, avatar },
  );

  try {
    await context.addCookies([
      { name: "ef_panel_token", value: token, url: API_URL, sameSite: "Lax" },
    ]);
  } catch {
    /* cookie injection is best-effort */
  }

  return token;
}
