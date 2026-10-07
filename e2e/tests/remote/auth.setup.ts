import { test as setup, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { E2E_DIR, HOST_PASS, HOST_STORAGE_STATE, HOST_URL, HOST_USER } from "../../support/env";

// Optional one-time login for the remote host app, producing a Playwright
// storageState file the `remote` project reuses.
//
// This is only a convenience for host apps with a simple email/password form.
// The recommended, most reliable path is a manual capture:
//   npx playwright codegen --save-storage=e2e/.auth/host.json <HOST_URL>
// Override the selectors with E2E_HOST_USER_SELECTOR / E2E_HOST_PASS_SELECTOR /
// E2E_HOST_SUBMIT_SELECTOR when the defaults do not match.

const USER = HOST_USER;
const PASS = HOST_PASS;
const STATE_PATH = HOST_STORAGE_STATE || path.join(E2E_DIR, ".auth", "host.json");

setup.skip(!HOST_URL, "E2E_HOST_URL not set.");
setup.skip(!USER || !PASS, "E2E_HOST_USER/E2E_HOST_PASS not set — use codegen to capture storage state.");

setup("authenticate against the host app", async ({ page }) => {
  const userSel = process.env.E2E_HOST_USER_SELECTOR || 'input[type="email"], input[name="email"]';
  const passSel = process.env.E2E_HOST_PASS_SELECTOR || 'input[type="password"], input[name="password"]';
  const submitSel = process.env.E2E_HOST_SUBMIT_SELECTOR || 'button[type="submit"]';

  await page.goto(HOST_URL);
  await page.fill(userSel, USER);
  await page.fill(passSel, PASS);
  await page.click(submitSel);
  // Avoid waitForLoadState("networkidle") — hosts with long-polling/websockets
  // never go idle. Assert the post-login destination instead.
  await page.waitForLoadState("load");
  await expect(page).not.toHaveURL(/login|signin|sign-in/i);

  const dir = path.dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await page.context().storageState({ path: STATE_PATH });
});
