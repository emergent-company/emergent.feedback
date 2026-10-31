import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn } from "../../support/auth";
import { API_URL, DEFAULT_REPO } from "../../support/env";

// Badge behaviour is tested independently of the submission dialog: feedback
// is seeded through the API, then the overlay is loaded as a returning visitor.

async function seedFeedback(
  request: APIRequestContext,
  token: string,
  url: string,
  selector: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/feedback`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      url,
      selector,
      comment: `badge seed ${Date.now()}`,
      context: {},
      repo: DEFAULT_REPO,
      label: "feedback",
    },
  });
  expect(response.status()).toBe(201);
}

test.describe("persistent badges", () => {
  let token = "";

  test.beforeEach(async ({ context, request }) => {
    token = await signIn(context);
    // A returning visitor: comment mode has been opened before, badges on.
    await context.addInitScript(() => {
      try {
        localStorage.setItem("__ef_badges_activated__", "1");
      } catch {
        /* storage unavailable */
      }
    });
    await seedFeedback(request, token, `${API_URL}/`, "#hero-title");
  });

  test("renders on load without re-entering comment mode", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    await expect(page.locator("#__ef_badge__0")).toBeVisible();
  });

  test("the top-bar switch hides, restores and remembers badges", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await expect(page.locator("#__ef_badge__0")).toBeVisible();

    await page.click("#try-it");
    const toggle = page.locator("#__ef_badge_switch__");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#__ef_dashboard_link__")).toHaveAttribute("href", "/panel");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#__ef_badge__0")).toBeHidden();

    // The preference survives a reload: no badge layer is rendered at all.
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await expect(page.locator("#__ef_badge__0")).toHaveCount(0);

    await page.click("#try-it");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(page.locator("#__ef_badge__0")).toBeVisible();
  });
});
