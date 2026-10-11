#!/usr/bin/env node
// Ad-hoc session capture for the `remote` project. Manual tool — not run in CI.
//
// Signs in to a deployed host app and writes a Playwright storageState that the
// `remote` specs reuse. Built for hosts sitting behind a hosted identity
// provider (Zitadel, Auth0, ...), where `npx playwright codegen` is impractical
// (it needs a display) and tests/remote/auth.setup.ts is too naive (its
// selectors assume a plain email/password form on the host itself).
//
//   E2E_HOST_URL=https://admin.dev.emergent-company.ai \
//   E2E_TEST_USER_EMAIL=you@example.com E2E_TEST_USER_PASSWORD=... \
//   npm run login
//
// Then:
//   E2E_HOST_URL=https://admin.dev.emergent-company.ai npm run test:remote
//
// Env:
//   E2E_HOST_URL            deployed page that embeds the overlay (required)
//   E2E_TEST_USER_EMAIL     or E2E_HOST_USER
//   E2E_TEST_USER_PASSWORD  or E2E_HOST_PASS
//   E2E_STORAGE_STATE       output file, resolved against e2e/ (default .auth/host.json)

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`login: ${message}`);
  process.exit(2);
}

const BASE = process.env.E2E_HOST_URL || "";
const EMAIL = process.env.E2E_TEST_USER_EMAIL || process.env.E2E_HOST_USER || "";
const PASS = process.env.E2E_TEST_USER_PASSWORD || process.env.E2E_HOST_PASS || "";
const OUT = path.resolve(process.env.E2E_STORAGE_STATE || ".auth/host.json");

if (!BASE) fail("E2E_HOST_URL is required (the deployed page that embeds the overlay).");
if (!EMAIL || !PASS) {
  fail("set E2E_TEST_USER_EMAIL + E2E_TEST_USER_PASSWORD (or E2E_HOST_USER + E2E_HOST_PASS).");
}

const origin = new URL(BASE).origin;
const loggedIn = (url) => url.origin === origin && !/^\/auth\b/.test(url.pathname);

/**
 * Fill one field of the hosted login form and submit it. These SPAs hydrate
 * asynchronously: a fill that lands before hydration leaves the framework model
 * empty and the submit button disabled. Verify both the DOM value and an
 * enabled submit, retrying while the form settles.
 */
async function submitField(page, field, value) {
  await field.waitFor({ state: "visible", timeout: 30_000 });
  const submit = page.locator('button[type="submit"]').first();
  await submit.waitFor({ state: "visible", timeout: 30_000 });

  for (let attempt = 0; attempt < 6; attempt++) {
    await field.fill(value);
    await page.waitForTimeout(200);
    if ((await field.inputValue().catch(() => "")) !== value) {
      await page.waitForTimeout(250);
      continue;
    }
    const enabled = await page
      .waitForFunction(
        () => {
          const button = document.querySelector('button[type="submit"]');
          return !!button && !button.disabled;
        },
        undefined,
        { timeout: 2_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!enabled) {
      await page.waitForTimeout(250);
      continue;
    }
    await submit.click();
    return;
  }
  throw new Error("the login form never accepted the value and enabled its submit button");
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const atApp = () => {
  try {
    return loggedIn(new URL(page.url()));
  } catch {
    return false;
  }
};

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Some hosts route straight to the IdP; others show a first-party "Sign in".
  const signin = page
    .getByRole("link", { name: /sign\s*in/i })
    .or(page.getByRole("button", { name: /sign\s*in/i }));
  if (await signin.first().isVisible().catch(() => false)) {
    await signin.first().click();
  }

  // Hosted login is two steps: identifier, then password.
  const loginName = page
    .locator('input[name="loginName"], input#loginName, input[type="email"]')
    .first();
  await loginName.waitFor({ state: "visible", timeout: 30_000 });
  console.log(`login: identifier form at ${page.url()}`);
  await submitField(page, loginName, EMAIL);

  const password = page
    .locator('input[name="password"], input#password, input[type="password"]')
    .first();
  await password.waitFor({ state: "visible", timeout: 30_000 });
  await submitField(page, password, PASS);

  // The IdP may interpose a first-login interstitial (2FA enrolment) before it
  // redirects back to the app.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !atApp()) {
    const skip = page.getByRole("button", { name: "Skip" });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      await page.waitForLoadState("domcontentloaded");
      continue;
    }
    await page.waitForTimeout(500);
  }

  await page.waitForURL(loggedIn, { timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  console.log(`login: signed in at ${page.url()}`);

  // Report whether the overlay is actually installed — the question the
  // `remote` specs exist to answer.
  await page.waitForTimeout(2_000);
  const probe = await page.evaluate(() => ({
    global: !!globalThis.EmergentFeedback,
    scripts: [...document.querySelectorAll("script[src]")]
      .map((s) => s.getAttribute("src"))
      .filter((s) => s && /feedback|overlay/i.test(s)),
  }));
  console.log(
    `login: overlay ${probe.global ? "present" : "NOT FOUND"}` +
      (probe.scripts.length ? ` (${probe.scripts.join(", ")})` : ""),
  );

  mkdirSync(path.dirname(OUT), { recursive: true });
  await context.storageState({ path: OUT });
  console.log(`login: session written to ${OUT}`);
  console.log("login: next -> E2E_HOST_URL=... npm run test:remote");
} catch (error) {
  console.error(`login: failed at ${page.url()}\n${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
