// env.ts — tiny .env loader + typed configuration shared by config and tests.
// No third-party dependency: reads e2e/.env if present and only fills vars that
// are not already set in the process environment.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** e2e/support directory. */
export const SUPPORT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** e2e/ directory. */
export const E2E_DIR = path.resolve(SUPPORT_DIR, "..");
/** Repository root. */
export const ROOT = path.resolve(E2E_DIR, "..");

function loadEnvFile(): void {
  const file = path.join(E2E_DIR, ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export const API_PORT = Number(process.env.E2E_API_PORT || 18095);
export const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT || 18096);
export const API_URL = `http://localhost:${API_PORT}`;
export const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}`;

/** Must match the JWT_SECRET the test server is launched with. */
export const JWT_SECRET = process.env.E2E_JWT_SECRET || "e2e-secret";
/** Must match the server's MCP_API_KEY. */
export const MCP_API_KEY = process.env.E2E_MCP_API_KEY || "e2e-mcp-key";

export const DEFAULT_REPO = process.env.E2E_REPO || "e2e/demo";

/** Identity baked into minted session tokens. */
export const TEST_USER = {
  login: process.env.E2E_USER || "e2e-user",
  avatar: process.env.E2E_AVATAR || "",
};

/** Remote host app under test (empty disables the `remote` project). */
export const HOST_URL = process.env.E2E_HOST_URL || "";
export const HOST_STORAGE_STATE = process.env.E2E_STORAGE_STATE || "";
export const ALLOW_WRITES = process.env.E2E_ALLOW_WRITES === "1" || process.env.E2E_ALLOW_WRITES === "true";
