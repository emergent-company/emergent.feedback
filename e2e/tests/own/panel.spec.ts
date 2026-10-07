import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";
import { TEST_USER } from "../../support/env";

// The panel authenticates with the minted session JWT. Endpoints that fan out
// to the GitHub App (/api/repos, /api/reports) cannot succeed in an isolated
// test environment, and a 401 there makes the panel treat the session as
// expired. Stub those two so the shell/auth behaviour is what we exercise.

async function stubGitHubBackedEndpoints(page: Page): Promise<void> {
  await page.route(/\/api\/(reports|repos)(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

test.describe("panel — signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows the GitHub sign-in gate", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#signin")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });
});

test.describe("panel — signed in", () => {
  test.beforeEach(async ({ context, page }) => {
    await signIn(context);
    await stubGitHubBackedEndpoints(page);
  });

  test("overview renders for the authenticated user", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#gate")).toBeHidden();
    await expect(page.locator("#user-login")).toHaveText(TEST_USER.login);
  });

  test("keys route renders", async ({ page }) => {
    await page.goto("/panel/keys");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#user-login")).toHaveText(TEST_USER.login);
  });

  test("reports route renders", async ({ page }) => {
    await page.goto("/panel/reports");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#user-login")).toHaveText(TEST_USER.login);
  });
});
