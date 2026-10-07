import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  API_PORT,
  API_URL,
  E2E_DIR,
  FIXTURE_PORT,
  FIXTURE_URL,
  HOST_STORAGE_STATE,
  HOST_URL,
  JWT_SECRET,
  MCP_API_KEY,
  ROOT,
} from "./support/env";

// Absolute path the remote project reads its host-app session from. The
// remote-auth setup project writes this exact path when creds are supplied.
const REMOTE_STORAGE_STATE = HOST_STORAGE_STATE || path.join(E2E_DIR, ".auth", "host.json");

const DB_PATH = path.join(E2E_DIR, ".tmp", "e2e.db");
const env = process.env as Record<string, string>;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The test server uses SQLite; concurrent feedback writes can transiently
  // fail with a lock error. Run serially for deterministic results. Raise
  // E2E_WORKERS only if you point the suite at a Postgres-backed server.
  workers: Number(process.env.E2E_WORKERS || 1),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: API_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "own",
      testDir: "./tests/own",
      use: { ...devices["Desktop Chrome"], baseURL: API_URL },
    },
    {
      name: "host",
      testDir: "./tests/host",
      // These specs submit feedback (writes). Run them serially to avoid
      // concurrent SQLite writes against the single test server.
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], baseURL: FIXTURE_URL },
    },
    {
      // Optional one-time login for the remote host app. Writes the storage
      // state consumed by the `remote` project. Skips when no creds are set.
      name: "remote-auth",
      testDir: "./tests/remote",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "remote",
      testDir: "./tests/remote",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["remote-auth"],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: HOST_URL || undefined,
        storageState: REMOTE_STORAGE_STATE,
      },
    },
  ],
  webServer: [
    {
      // Go API + panel + overlay bundle. Reuses the repo's own server on a
      // fixed test port with known secrets so tokens can be minted offline.
      command: "node e2e/support/start-api.mjs",
      cwd: ROOT,
      url: `${API_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      // Inherit the shell env for toolchain vars (PATH, HOME, GOCACHE, ...) but
      // explicitly neutralise anything that could point the test server at real
      // infrastructure: a live DATABASE_URL would override the throwaway SQLite
      // DB, and real GitHub/LLM creds would arm it against production.
      env: {
        ...env,
        PORT: String(API_PORT),
        JWT_SECRET,
        DATABASE_URL: "",
        GH_APP_CLIENT_ID: "e2e-client-id",
        GH_APP_CLIENT_SECRET: "e2e-client-secret",
        GH_REDIRECT_URI: `${API_URL}/auth/callback`,
        GH_APP_ID: "",
        GH_INSTALLATION_ID: "",
        GH_APP_PRIVATE_KEY: "",
        GH_APP_PRIVATE_KEY_PATH: "",
        GH_BOT_TOKEN: "",
        GH_APP_SLUG: "",
        FEEDBACK_LLM_BASE_URL: "",
        FEEDBACK_LLM_API_KEY: "",
        FEEDBACK_NOTIFY_WEBHOOK: "",
        DB_PATH,
        MCP_API_KEY,
        ALLOWED_ORIGINS: "*",
        ISSUE_AUTHOR_MODE: "bot",
        RATE_LIMIT_RPS: "1000",
        EXPORT_RATE_LIMIT_RPS: "1000",
      },
    },
    {
      // Static "other page" fixture server. Emulates a third-party app that
      // embeds the overlay script.
      command: "node e2e/support/serve-fixtures.mjs",
      cwd: ROOT,
      url: `${FIXTURE_URL}/host.html`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...env,
        FIXTURE_PORT: String(FIXTURE_PORT),
        E2E_API_URL: API_URL,
      },
    },
  ],
});
