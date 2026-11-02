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

  test("dogfoods the overlay: navbar button picks panel elements", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.locator("#app")).toBeVisible();

    // The overlay bundle is installed on the panel itself, and the navbar
    // button enters picking mode without the Alt+Shift hotkey.
    await expect(page.locator('script[src="/emergent-feedback.js"]')).toHaveCount(1);
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback,
    );
    await page.locator("#panel-feedback").click();
    await expect(page.locator("#__ef_indicator__")).toBeVisible();

    // Picking a dashboard element opens the pane with the shared session.
    await page.locator("#overview h1").click();
    await expect(page.locator("#__ef_report__")).toBeVisible();
    await expect(page.locator("#__ef_dialog__ .ef-user-pill")).toContainText(TEST_USER.login);
  });
});
