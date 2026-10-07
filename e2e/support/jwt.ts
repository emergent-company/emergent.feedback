// jwt.ts — mint a session JWT offline.
//
// The server issues HS256 tokens with claims {login, avatar_url, iat, exp}
// (see server/middleware/auth.go). Reproducing that here lets the E2E suite
// authenticate the panel and the embedded overlay without driving the GitHub
// OAuth popup.

import { createHmac } from "node:crypto";

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export interface MintTokenOptions {
  login: string;
  avatar?: string;
  secret: string;
  /** Token lifetime in seconds. Defaults to 24h. */
  ttlSeconds?: number;
}

export function mintToken({ login, avatar = "", secret, ttlSeconds = 86_400 }: MintTokenOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ login, avatar_url: avatar, iat: now, exp: now + ttlSeconds }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
