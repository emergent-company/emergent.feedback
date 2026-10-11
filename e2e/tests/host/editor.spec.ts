import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// Editor affordances in a real browser, on a fixture host page:
// hover-driven outlines, Default / click-again-to-unset, and the icon rows.
// Uses /fallback.html, which has no data-theme-url, so the BUILT-IN token
// groups (the ones that carry the icon glyphs) are what renders.

test.describe("editor affordances (structure fixture)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function openEditorOn(page: Page, selector: string) {
    await page.goto("/fallback.html");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await page.locator(selector).click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
  }

  const classRe = (cls: string) => new RegExp(`(^|\\s)${cls}(\\s|$)`);

  test("outlines a target only while its label is hovered, and peeks the tab in reverse", async ({ page }) => {
    await openEditorOn(page, "#btn-a");

    // Selected, but not boxed: the short select-flash fades and the page stays clean.
    await expect(page.locator("#__ef_sel_highlight__")).toHaveCount(0);

    await page.locator(".ef-target-tab").first().hover();
    await expect(page.locator("#__ef_sel_highlight__")).toBeVisible();
    await expect(page.locator("#__ef_sel_highlight_badge__")).toHaveText("1");

    // Moving off the label (onto a non-target element) clears the outline.
    await page.locator("#structure-heading").hover();
    await expect(page.locator("#__ef_sel_highlight__")).toHaveCount(0);

    // Reverse hover: the element on the page peeks its tab.
    await page.locator("#btn-a").hover();
    await expect(page.locator(".ef-target-tab").first()).toHaveClass(/ef-target-tab--peek/);
  });

  test("Default unsets an applied option, and the selected option again does too", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    const row = page.locator('.ef-prop-row[data-group="padding"]');

    await row.locator(".ef-select-trigger").click();
    await row.locator('[data-token="lg"]').click();
    await expect(page.locator("#btn-a")).toHaveClass(classRe("p-6"));
    await expect(row.locator(".ef-select-label")).toHaveText("Large");

    // Re-opening and choosing Default restores the element's own styling…
    await row.locator(".ef-select-trigger").click();
    await row.locator("[data-default]").click();
    await expect(page.locator("#btn-a")).not.toHaveClass(classRe("p-6"));
    await expect(row.locator(".ef-select-label")).toHaveText("Default");
    // …and drops the pending record rather than leaving an empty edit behind.
    await expect(page.locator(".ef-changes-list")).toHaveCount(0);

    // Sitting on Default now: applying, then clicking the active option again, unsets.
    await row.locator(".ef-select-trigger").click();
    await row.locator('[data-token="md"]').click();
    await expect(page.locator("#btn-a")).toHaveClass(classRe("p-4"));
    await row.locator(".ef-select-trigger").click();
    await expect(row.locator('[data-token="md"]')).toHaveAttribute("aria-selected", "true");
    await row.locator('[data-token="md"]').click();
    await expect(page.locator("#btn-a")).not.toHaveClass(classRe("p-4"));
    await expect(page.locator(".ef-changes-list")).toHaveCount(0);
  });

  test("Default leaves a class that comes from the host markup alone", async ({ page }) => {
    await openEditorOn(page, "#markup-btn");
    const row = page.locator('.ef-prop-row[data-group="padding"]');
    // p-4 was authored in the page, so the group reads Medium with no overlay edit.
    await expect(row.locator(".ef-select-label")).toHaveText("Medium");

    await row.locator(".ef-select-trigger").click();
    await row.locator("[data-default]").click();

    await expect(page.locator("#__ef_toast__")).toContainText("page markup");
    await expect(page.locator("#markup-btn")).toHaveClass(classRe("p-4"));
  });

  test("layout groups render as icon buttons and apply their Tailwind class", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    // The CSS position group's id is "positioning": "position" is reserved for
    // recorded DOM moves, so an applied `relative` must not read as a reorder.
    const row = page.locator('.ef-prop-row[data-group="positioning"]');

    // Five options + the Default (unset) glyph, all inline SVG.
    await expect(row.locator("svg")).toHaveCount(6);
    const btn = row.locator('[data-token="relative"]');
    await expect(btn).toHaveAttribute("aria-pressed", "false");

    await btn.click();
    await expect(page.locator("#btn-a")).toHaveClass(classRe("relative"));
    await expect(btn).toHaveAttribute("aria-pressed", "true");

    // Listed as a plain style change — not as a Position (move) record.
    await expect(page.locator(".ef-changes-list")).toContainText("positioning");
    await expect(page.locator(".ef-changes-list")).not.toContainText("Position");

    await btn.click();
    await expect(page.locator("#btn-a")).not.toHaveClass(classRe("relative"));
  });
});
