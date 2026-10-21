import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// Editor affordances in a real browser, on a fixture host page:
// hover-driven outlines, Default / click-again-to-unset, and the dropdown
// controls every built-in group uses.
// Uses /fallback.html, which has no data-theme-url, so the BUILT-IN token
// groups (the fallback set) are what renders.

test.describe("editor affordances (structure fixture)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function openEditorOn(
    page: Page,
    selector: string,
    position?: { x: number; y: number }
  ) {
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
    await page.locator(selector).click({ position });
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    // Submission-first: clicking opens the issue modal; "Edit element" swaps
    // it for the style editor.
    await page.locator("#__ef_edit_element__").click();
    await expect(page.locator("#__ef_style_editor__")).toBeVisible();
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

  test("layout groups render as dropdowns and apply their Tailwind class", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    // The CSS position group's id is "positioning": "position" is reserved for
    // recorded DOM moves, so an applied `relative` must not read as a reorder.
    const row = page.locator('.ef-prop-row[data-group="positioning"]');

    // Uniform control chrome: a dropdown, never an icon row.
    await expect(row.locator(".ef-select-trigger")).toHaveCount(1);
    await expect(row.locator("svg")).toHaveCount(0);

    await row.locator(".ef-select-trigger").click();
    const opt = row.locator('[data-token="relative"]');
    await expect(opt).toHaveAttribute("aria-selected", "false");
    await opt.click();

    await expect(page.locator("#btn-a")).toHaveClass(classRe("relative"));
    await expect(row.locator(".ef-select-label")).toHaveText("Relative");

    // Listed as a plain style change — not as a Position (move) record.
    await expect(page.locator(".ef-changes-list")).toContainText("positioning");
    await expect(page.locator(".ef-changes-list")).not.toContainText("Position");

    // Re-opening and re-selecting the active option unsets it.
    await row.locator(".ef-select-trigger").click();
    await row.locator('[data-token="relative"]').click();
    await expect(page.locator("#btn-a")).not.toHaveClass(classRe("relative"));
    await expect(row.locator(".ef-select-label")).toHaveText("Default");
  });

  test("chip groups render as dropdowns too", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    // textSize used to be a chip row; it is a dropdown now, like everything else.
    const row = page.locator('.ef-prop-row[data-group="textSize"]');
    await expect(row.locator(".ef-select-trigger")).toHaveCount(1);
    await expect(row.locator(".ef-token-chip")).toHaveCount(0);

    await row.locator(".ef-select-trigger").click();
    await row.locator('[data-token="lg"]').click();
    await expect(page.locator("#btn-a")).toHaveClass(classRe("text-lg"));
    await expect(row.locator(".ef-select-label")).toHaveText("Large");
  });

  // Per-element group filtering (client/src/applicability.ts): the editor hides
  // token groups whose `requires` cannot affect the selected element — container
  // vs. item, flex vs. grid, box/replaced/text/positioned, and the daisyUI
  // base-class gate — with a "Show all" escape hatch and an applied-edit
  // override. Rows are `.ef-prop-row[data-group="<id>"]`; the footer note is
  // `.ef-style-hidden-note` with `.ef-hidden-reasons` + `#__ef_show_all__`.

  test("flex container offers container-only groups", async ({ page }) => {
    // Click the toolbar's padding (top-left corner), not its centre: the three
    // flex-grow buttons fill the content box, so a centre click would select a
    // child button instead of the flex container.
    await openEditorOn(page, "#toolbar", { x: 2, y: 2 });
    await expect(page.locator(".ef-style-target-sel")).toHaveText("#toolbar");

    for (const id of ["gap", "align", "justify", "flexDir", "wrap"]) {
      await expect(page.locator(`.ef-prop-row[data-group="${id}"]`)).toHaveCount(1);
    }
    // `self` (align-self) applies to flex *items*, not the flex container
    // itself: the toolbar's parent is <body> (block), so its container-item
    // requirement is unmet. objectFit (replaced) and inset (positioned) also
    // don't apply here.
    for (const id of ["self", "objectFit", "inset"]) {
      await expect(page.locator(`.ef-prop-row[data-group="${id}"]`)).toHaveCount(0);
    }
  });

  test("inapplicable groups are hidden for a block heading, with a Show all escape hatch", async ({ page }) => {
    await openEditorOn(page, "#structure-heading");

    for (const id of [
      "gap", "align", "justify", "flexDir", "wrap", "self", "inset", "objectFit",
      "btnColor", "btnModifier", "btnSize", "badgeColor", "badgeModifier", "badgeSize",
    ]) {
      await expect(page.locator(`.ef-prop-row[data-group="${id}"]`)).toHaveCount(0);
    }
    for (const id of [
      "padding", "margin", "display", "positioning", "textSize", "fontWeight",
      "textAlign", "textColor", "backgroundColor", "width", "rounded", "shadow",
    ]) {
      await expect(page.locator(`.ef-prop-row[data-group="${id}"]`)).toHaveCount(1);
    }

    await expect(page.locator("#__ef_show_all__")).toBeVisible();
    await expect(page.locator(".ef-hidden-reasons")).toContainText("settings hidden");

    await page.locator("#__ef_show_all__").click();
    await expect(page.locator('.ef-prop-row[data-group="gap"]')).toHaveCount(1);
    await expect(page.locator("#__ef_show_all__")).toHaveText("Hide inapplicable");

    await page.locator("#__ef_show_all__").click();
    await expect(page.locator('.ef-prop-row[data-group="gap"]')).toHaveCount(0);
  });

  test("daisyUI component groups need the base class", async ({ page }) => {
    await openEditorOn(page, "#btn-a");
    await expect(page.locator('.ef-prop-row[data-group="btnColor"]')).toHaveCount(0);
    await expect(page.locator('.ef-prop-row[data-group="badgeColor"]')).toHaveCount(0);
    // Its parent #toolbar is flex, so align-self (container-item) applies.
    await expect(page.locator('.ef-prop-row[data-group="self"]')).toHaveCount(1);
  });

  test("an applied edit keeps its group visible after it stops applying", async ({ page }) => {
    await openEditorOn(page, "#structure-heading");

    // `gap` can't affect a block heading, so reveal it via Show all to apply an
    // edit to an element it otherwise cannot.
    await page.locator("#__ef_show_all__").click();
    const gap = page.locator('.ef-prop-row[data-group="gap"]');
    await gap.locator(".ef-select-trigger").click();
    await gap.locator('[data-token="lg"]').click();
    await expect(page.locator("#structure-heading")).toHaveClass(classRe("gap-4"));

    // Hide inapplicable again: `gap` no longer applies to the heading on its
    // own, but the applied gap-4 keeps the group visible (and revertable).
    await page.locator("#__ef_show_all__").click();
    await expect(page.locator('.ef-prop-row[data-group="gap"]')).toHaveCount(1);
    await expect(page.locator('.ef-prop-row[data-group="gap"] .ef-select-label')).toHaveText("Large");
  });
});
