import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// Page-level report registry: the Edit tab, the All reports master list, and
// draft-scoped style edits (suspend on leave, re-apply on resume).

test.describe("report registry on the landing page (own)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function start(page: Page): Promise<void> {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await page.evaluate(() => sessionStorage.clear());
    await page.click("#try-it");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
  }

  test("Edit is a tab between Feedback and Changes, with its own Discard control", async ({ page }) => {
    await start(page);
    await page.locator("#hero-title").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();

    const labels = (await page.locator("#__ef_dialog__ .ef-tab").allTextContents()).map((s) =>
      s.trim()
    );
    expect(labels[0]).toContain("Feedback");
    expect(labels[1]).toContain("Edit");
    expect(labels[2]).toContain("Changes");

    // The old in-panel editor buttons are gone.
    await expect(page.locator("#__ef_edit_element__")).toHaveCount(0);
    await expect(page.locator("#__ef_back_to_issue__")).toHaveCount(0);

    await page.locator("#__ef_tab_edit__").click();
    await expect(page.locator("#__ef_panel_edit__")).toBeVisible();
    await expect(page.locator("#__ef_style_editor__")).toBeVisible();
    await expect(page.locator("#__ef_report__")).toBeHidden();
    await expect(page.locator("#__ef_discard_draft__")).toBeVisible();

    // Tabs navigate back without a separate footer button.
    await page.locator("#__ef_tab_feedback__").click();
    await expect(page.locator("#__ef_report__")).toBeVisible();
  });

  test("All reports lists drafts, resumes one with its text, and cancels another", async ({ page }) => {
    await start(page);
    await page.locator("#hero-title").click();
    await page.fill("#__ef_comment__", "first draft text");
    await page.locator("#__ef_all_reports__").click();

    await expect(page.locator("#__ef_reports__")).toBeVisible();
    await expect(
      page.locator('#__ef_reports__ .ef-report-item[data-kind="draft"] .ef-report-title')
    ).toContainText("first draft text");
    // The list is not a peer tab.
    await expect(page.locator("#__ef_dialog__ .ef-tabs")).toBeHidden();

    await page.locator("#__ef_reports_close__").click();
    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);

    // A second draft on another element.
    await page.locator("#problem-title").click();
    await page.fill("#__ef_comment__", "second draft text");
    await page.locator("#__ef_all_reports__").click();
    await expect(
      page.locator('#__ef_reports__ .ef-report-item[data-kind="draft"]')
    ).toHaveCount(2);

    // Resume the first draft: the pane rebinds to its element and restores text.
    await page
      .locator('#__ef_reports__ .ef-report-item[data-kind="draft"] .ef-report-main', {
        hasText: "first draft text",
      })
      .click();
    await expect(page.locator("#__ef_reports__")).toBeHidden();
    await expect(page.locator("#__ef_comment__")).toHaveValue("first draft text");

    // Cancel the second draft from the list (two-step confirm).
    await page.locator("#__ef_all_reports__").click();
    const secondRow = page.locator("#__ef_reports__ .ef-report-item", {
      hasText: "second draft text",
    });
    await secondRow.locator(".ef-report-cancel").click();
    await secondRow.locator(".ef-report-cancel").click();
    await expect(
      page.locator("#__ef_reports__ .ef-report-title", { hasText: "second draft text" })
    ).toHaveCount(0);
    await expect(
      page.locator('#__ef_reports__ .ef-report-item[data-kind="draft"]')
    ).toHaveCount(1);
  });

  test("style edits are draft-scoped: leaving reverts, resuming re-applies", async ({ page }) => {
    await start(page);
    await page.locator("#problem-title").click();
    await page.fill("#__ef_comment__", "heading copy");

    await page.locator("#__ef_tab_edit__").click();
    const row = page.locator('.ef-prop-row[data-group="text"]');
    await expect(row).toHaveCount(1);
    const input = row.locator(".ef-text-input");
    const original = await input.inputValue();
    await input.fill("Changed heading copy");
    await input.press("Enter");
    await expect(page.locator("#problem-title")).toHaveText("Changed heading copy");

    // Leaving the report suspends it: the page returns to baseline.
    await page.locator("#__ef_all_reports__").click();
    await expect(page.locator("#__ef_reports__")).toBeVisible();
    await expect(page.locator("#problem-title")).toHaveText(original);

    // Reopening the draft re-applies its edits.
    await page
      .locator('#__ef_reports__ .ef-report-item[data-kind="draft"] .ef-report-main', {
        hasText: "heading copy",
      })
      .click();
    await expect(page.locator("#__ef_comment__")).toHaveValue("heading copy");
    await expect(page.locator("#problem-title")).toHaveText("Changed heading copy");

    // Discard the draft: its edits are reverted for good.
    await page.locator("#__ef_tab_edit__").click();
    await page.locator("#__ef_discard_draft__").click();
    await page.locator("#__ef_discard_draft__").click();
    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);
    await expect(page.locator("#problem-title")).toHaveText(original);
  });

  test("Escape steps back to Feedback, then to All reports without discarding", async ({ page }) => {
    await start(page);
    await page.locator("#hero-title").click();
    await page.fill("#__ef_comment__", "escape keeps me");

    await page.locator("#__ef_tab_edit__").click();
    await expect(page.locator("#__ef_panel_edit__")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#__ef_report__")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#__ef_reports__")).toBeVisible();
    await expect(
      page.locator('#__ef_reports__ .ef-report-item[data-kind="draft"] .ef-report-title')
    ).toContainText("escape keeps me");
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
  });
});
