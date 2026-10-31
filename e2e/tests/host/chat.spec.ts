import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// The Chat tab is a report composer. These tests cover the pane plumbing that
// unit tests cannot: the tab is opt-in per host, the empty state and composer
// render, a turn reaches the proxy, and a failed turn is reported in-line
// instead of being swallowed. The agent itself is stubbed by the absence of a
// Memory destination — that is the failure path — so nothing here needs a live
// model.

test.describe("chat tab (host fixture)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function activate(page: Page) {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
  }

  async function openPane(page: Page, path = "/host.html", selector = "#target-btn") {
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await activate(page);
    await page.locator(selector).click();
    await expect(page.locator("#__ef_panel_feedback__")).toBeVisible();
  }

  test("data-chat adds the Chat tab to the pane", async ({ page }) => {
    await openPane(page);
    await expect(page.locator("#__ef_tab_feedback__")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#__ef_tab_changes__")).toBeVisible();
    await expect(page.locator("#__ef_tab_chat__")).toBeVisible();
  });

  test("the tab opens an empty composer with the redacted context strip", async ({ page }) => {
    await openPane(page);
    await page.click("#__ef_tab_chat__");

    await expect(page.locator("#__ef_panel_chat__")).toBeVisible();
    await expect(page.locator("#__ef_tab_chat__")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#__ef_tab_feedback__")).toHaveAttribute("aria-selected", "false");

    // Context strip + empty state + composer.
    await expect(page.locator(".ef-chat-ctx-sel")).toContainText("#target-btn");
    await expect(page.locator(".ef-chat-ctx-meta")).toContainText("redacted");
    await expect(page.locator(".ef-chat-empty-title")).toContainText("Describe the change");
    await expect(page.locator("#__ef_chat_input__")).toBeVisible();
    await expect(page.locator(".ef-chat-note")).toContainText("does not change the page");

    // Switching back keeps the form, and nothing was edited on the page.
    await page.click("#__ef_tab_feedback__");
    await expect(page.locator("#__ef_report__")).toBeVisible();
    await expect(page.locator("#__ef_comment__")).toHaveValue("");
  });

  test("a failed turn is reported in the transcript, not swallowed", async ({ page }) => {
    await openPane(page);
    await page.click("#__ef_tab_chat__");
    await page.fill("#__ef_chat_input__", "The button label is wrong");

    await page.click("#__ef_chat_send__");

    // The turn is sent to the server proxy; with no Memory destination in the
    // test DB it must come back as an in-line error bubble.
    const error = page.locator(".ef-chat-turn.ef-chat-error .ef-chat-bubble");
    await expect(error).toBeVisible();
    await expect(error).not.toBeEmpty();
    await expect(page.locator(".ef-chat-user .ef-chat-bubble")).toContainText(
      "The button label is wrong"
    );

    // The reporter's message is not lost, and the report form is untouched.
    await page.click("#__ef_tab_feedback__");
    await expect(page.locator("#__ef_comment__")).toHaveValue("");
  });

  test("without data-chat the pane has no Chat tab", async ({ page }) => {
    await openPane(page, "/structure.html", "#btn-a");
    await expect(page.locator("#__ef_tab_changes__")).toBeVisible();
    await expect(page.locator("#__ef_tab_chat__")).toHaveCount(0);
    await expect(page.locator("#__ef_panel_chat__")).toHaveCount(0);
  });
});
