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
    await expect(page.locator("#__ef_issue_modal__")).toBeVisible();
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

  test("round-trips to the style editor and back without losing the draft", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    await page.click("#try-it");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();

    // Submission-first: clicking an element opens the issue modal immediately.
    await page.locator("#hero-title").click();
    await expect(page.locator("#__ef_issue_modal__")).toBeVisible();

    const draft = `round-trip-${Date.now()}-keep-me`;
    await page.fill("#__ef_comment__", draft);

    // "Edit element" swaps the modal for the style editor; the modal hides.
    await page.locator("#__ef_edit_element__").click();
    await expect(page.locator("#__ef_style_editor__")).toBeVisible();
    await expect(page.locator("#__ef_issue_modal__")).toBeHidden();

    // "Back to issue" returns to the modal with the draft intact.
    await page.locator("#__ef_back_to_issue__").click();
    await expect(page.locator("#__ef_issue_modal__")).toBeVisible();
    await expect(page.locator("#__ef_comment__")).toHaveValue(draft);
  });
});
