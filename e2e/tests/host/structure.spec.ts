import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// Moving elements: drag a selected element to a new position, in a real browser
// with the real bundle. Covers the drop, the panel record, commit + reload
// replay from the stored anchors, and Remove restoring the original order.

test.describe("moving elements (structure fixture)", () => {
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

  /** Child ids of a container, in DOM order. */
  async function children(page: Page, selector: string): Promise<string[]> {
    return page.$$eval(`${selector} > *`, (els) => els.map((e) => e.id));
  }

  async function openEditorOn(page: Page, selector: string) {
    await page.goto("/structure.html");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    // Committed edits from a previous test would already be replayed on boot.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await activate(page);
    await page.locator(selector).click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    // Submission-first: "Edit element" swaps the issue modal for the editor.
    await page.locator("#__ef_edit_element__").click();
    await expect(page.locator("#__ef_style_editor__")).toBeVisible();
  }

  /** Press on `from`, drag past the threshold, drop on `to` (offset from its left edge). */
  async function drag(page: Page, from: string, to: string, offsetX = 4) {
    const src = (await page.locator(from).boundingBox())!;
    const dst = (await page.locator(to).boundingBox())!;
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    // First move crosses the 5px threshold and starts the drag.
    await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 2, { steps: 2 });
    await page.mouse.move(dst.x + offsetX, dst.y + dst.height / 2, { steps: 8 });
    await expect(page.locator("#__ef_drag_ghost__")).toBeVisible();
    await page.mouse.up();
  }

  test("drags a button twice, records one move, and replays it after commit + reload", async ({ page }) => {
    await openEditorOn(page, "#btn-c");
    await expect(page.locator(".ef-style-position")).toHaveText("3rd of 3 in #toolbar");

    await drag(page, "#btn-c", "#btn-a");

    // The DOM actually changed: press-drag reorders siblings live.
    expect(await children(page, "#toolbar")).toEqual(["btn-c", "btn-a", "btn-b"]);
    // The drop is swallowed — it did not also toggle the selection off.
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await expect(page.locator(".ef-style-position")).toHaveText("1st of 3 in #toolbar");

    // A second move of the SAME element: one record, keeping the original anchor.
    await drag(page, "#btn-c", "#btn-b");
    expect(await children(page, "#toolbar")).toEqual(["btn-a", "btn-c", "btn-b"]);
    await expect(page.locator(".ef-style-position")).toHaveText("2nd of 3 in #toolbar");

    // Listed as Position, from the first position to the latest — not a history.
    await page.click("#__ef_tab_changes__");
    await expect(page.locator("#__ef_panel_changes__")).toBeVisible();
    await expect(page.locator(".ef-changes-list")).toContainText("Position");
    await expect(page.locator(".ef-changes-list")).toContainText("3rd of 3 in #toolbar");
    await expect(page.locator(".ef-changes-list")).toContainText("2nd of 3 in #toolbar");
    await expect(page.locator(".ef-changes-list li")).toHaveCount(1);

    // Commit → the anchors are persisted, not just the live DOM order.
    await page.click("#__ef_commit__");
    await expect(page.locator(".ef-committed-list")).toContainText("Position");

    // Reload: the committed move replays from localStorage before any clicking.
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    expect(await children(page, "#toolbar")).toEqual(["btn-a", "btn-c", "btn-b"]);

    // Remove the committed move → the original order comes back.
    await activate(page);
    await page.locator("#btn-a").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    // Reopening lands on the Feedback tab; the Committed-changes list lives on
    // the Changes tab.
    await page.click("#__ef_tab_changes__");
    await expect(page.locator("#__ef_panel_changes__")).toBeVisible();
    await page.click(".ef-committed-remove");
    expect(await children(page, "#toolbar")).toEqual(["btn-a", "btn-b", "btn-c"]);
  });

  test("dropping over a container's own box reparents the element into it", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    // Select the element to move (clicking an element adds it to the selection).
    await page.locator("#row-1").click();
    await expect(page.locator(".ef-style-position")).toHaveText("1st of 2 in #stack");

    const toolbar = (await page.locator("#toolbar").boundingBox())!;
    const src = (await page.locator("#row-1").boundingBox())!;
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2, src.y - 12, { steps: 3 });
    // The toolbar's padding band: `elementFromPoint` returns the container, which
    // is the append/reparent case.
    await page.mouse.move(toolbar.x + toolbar.width / 2, toolbar.y + 4, { steps: 8 });
    await expect(page.locator("#__ef_drag_box__")).toBeVisible();
    await page.mouse.up();

    expect(await children(page, "#toolbar")).toEqual(["btn-a", "btn-b", "btn-c", "row-1"]);
    expect(await children(page, "#stack")).toEqual(["row-2"]);
    await expect(page.locator(".ef-changes-list")).toContainText("Position");
  });

  test("refuses to drop an element into itself", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    await page.locator("#row-1").click();
    const src = (await page.locator("#row-1").boundingBox())!;
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 10, { steps: 3 });
    // Hovering the dragged element itself is not a valid drop.
    await expect(page.locator("#__ef_drag_line__")).toBeHidden();
    await page.mouse.up();

    expect(await children(page, "#stack")).toEqual(["row-1", "row-2"]);
    await expect(page.locator(".ef-changes-list")).toHaveCount(0);
  });
});
