import { test, expect, type Page } from "@playwright/test";
import { openIssueModal } from "../../support/dialog";

// A host configured with `data-order-box` + `data-order-session` has a third
// report destination: the note is delivered into a coding-agent session.
//
// Two properties matter and neither needs a reporter account:
//   1. The pane opens and the session destination is the default — otherwise
//      the primary button reads "Create issue" and the channel is invisible.
//   2. The comment box is readable: its own surface, not light text on the UA
//      white default (that bug shipped once and the textarea looked empty).

const SESSION = "11111111-2222-3333-4444-555555555555";
const SHORT = SESSION.slice(0, 8);

async function openReport(page: Page): Promise<void> {
  // Deliberately no signIn(): the session destination carries its own token.
  await page.goto("/order.html");
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

test.describe("session destination", () => {
  test("opens without a reporter account and defaults to the session", async ({ page }) => {
    await openReport(page);

    // No GitHub login layer, no reporter pill.
    await expect(page.locator("#__ef_dialog__ .ef-auth-layer")).toHaveCount(0);
    await expect(page.locator("#__ef_dialog__ .ef-user-pill")).toHaveCount(0);

    // Session is the default, so the primary action names the channel.
    const trigger = page.locator("#__ef_destination_trigger__");
    const primary = page.locator("#__ef_issue_submit__");
    await expect(trigger).toContainText(`Session ${SHORT}`);
    await expect(primary).toHaveText("Send to session");

    const options = page.locator("#__ef_destination_menu__ [role=option]");
    await expect(options).toHaveCount(2);
    await expect(options.nth(1)).toContainText(`Session ${SHORT}`);

    // Save needs a GitHub account, so it is not offered here.
    await expect(page.locator("#__ef_submit__")).toBeHidden();
  });

  test("the comment box uses the dialog surface, not the UA white", async ({ page }) => {
    await openReport(page);

    const surfaces = await page.evaluate(() => {
      const bg = (sel: string): string => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : "missing";
      };
      return { comment: bg("#__ef_comment__"), topic: bg("#__ef_topic__") };
    });

    expect(surfaces.comment).not.toBe("missing");
    expect(surfaces.comment).not.toBe("rgba(0, 0, 0, 0)");
    // The title input already painted its own surface; the textarea must match.
    expect(surfaces.comment).toBe(surfaces.topic);
  });

  test("sends the note to the session and reports delivery", async ({ page }) => {
    let body: Record<string, unknown> | undefined;
    await page.route("**/orderbox/o/**/order", async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ at: "12:34:56" }),
      });
    });

    await openReport(page);
    await page.fill("#__ef_comment__", "the card grid needs a writer line");
    await page.locator("#__ef_issue_submit__").click();

    await expect(page.locator("#__ef_toast__")).toContainText(
      `Sent to session ${SHORT} at 12:34:56.`
    );
    expect(body?.text).toBe("the card grid needs a writer line");
    expect(body?.selector).toBeTruthy();
    // Nothing is stored in this service: the order is the only delivery.
    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);
  });
});
