import { test, expect } from "@playwright/test";
import { signIn } from "../../support/auth";

// End-to-end through the real overlay bundle served on our own landing page:
// activate → pick an element → submit → reload → badge appears.

test.describe("overlay on the landing page (own)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("picks an element, saves feedback, and shows a badge after reload", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    await page.click("#try-it");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();

    await page.locator("#hero-title").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await expect(page.locator("#__ef_comment__")).toBeVisible();

    await page.fill("#__ef_comment__", "hero heading needs another pass");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/feedback") && r.request().method() === "POST",
      ),
      page.click("#__ef_submit__"),
    ]);
    expect(response.status()).toBe(201);

    // Reload, re-enter comment mode: the saved feedback surfaces as a badge.
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await page.click("#try-it");
    await expect(page.locator("#__ef_badge__0")).toBeVisible();
  });
});
