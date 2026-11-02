import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";
import { openIssueModal } from "../../support/dialog";

// The report form's destination dropdown replaces the old "Send to Memory"
// checkbox. Ask mode offers GitHub or Memory; the last choice is remembered.

const MEMORY_ASK = { connected: true, mode: "ask" };

test.describe("report destination dropdown", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function openReport(page: Page): Promise<void> {
    await page.route("**/api/memory/status?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MEMORY_ASK),
      })
    );
    await page.goto("/host.html");
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback
    );
    await page.evaluate(() => localStorage.removeItem("__ef_report_destination__"));

    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await page.locator("#target-btn").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await openIssueModal(page);
  }

  test("selecting Memory sends only to Memory and remembers the choice", async ({ page }) => {
    await openReport(page);
    const trigger = page.locator("#__ef_destination_trigger__");
    const primary = page.locator("#__ef_issue_submit__");

    await expect(trigger).toContainText("GitHub");
    await expect(primary).toHaveText("Create issue");

    await trigger.click();
    await expect(page.locator("#__ef_destination_menu__")).toBeVisible();
    await page.locator('[data-destination="memory"]').click();

    await expect(trigger).toContainText("Memory");
    await expect(primary).toHaveText("Send to Memory");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("__ef_report_destination__")))
      .toBe("memory");

    await page.fill("#__ef_comment__", "this belongs in memory");
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/feedback") && r.method() === "POST"
      ),
      primary.click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ memory_sync: true });
    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);
  });

  test("reopening the report keeps the last destination", async ({ page }) => {
    await openReport(page);
    const trigger = page.locator("#__ef_destination_trigger__");
    const primary = page.locator("#__ef_issue_submit__");

    await trigger.click();
    await page.locator('[data-destination="memory"]').click();
    await expect(primary).toHaveText("Send to Memory");

    await page.locator("#__ef_issue_cancel__").click();
    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);

    await page.locator("#target-btn").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await openIssueModal(page);
    await expect(trigger).toContainText("Memory");
    await expect(primary).toHaveText("Send to Memory");

    await trigger.click();
    await page.locator('[data-destination="github"]').click();
    await expect(trigger).toContainText("GitHub");
    await expect(primary).toHaveText("Create issue");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("__ef_report_destination__")))
      .toBe("github");
  });

  test("the dropdown stays usable in the mobile layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReport(page);

    const trigger = page.locator("#__ef_destination_trigger__");
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.locator("#__ef_destination_menu__")).toBeVisible();
    await expect(page.locator('[data-destination="memory"]')).toBeVisible();
    await page.locator('[data-destination="memory"]').click();
    await expect(page.locator("#__ef_issue_submit__")).toHaveText("Send to Memory");
  });
});
