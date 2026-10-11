import { expect, type Page } from "@playwright/test";

/**
 * The panel shows only the Design editor (the former Design/Issues tabs are
 * gone). Feedback submission happens through the issue modal: **Send to
 * GitHub** (`#__ef_export__`) opens `#__ef_issue_modal__`, which holds the
 * comment textarea (`#__ef_comment__`), **Save** (`#__ef_submit__`) and the
 * context/HTML preview. Any spec that reads or writes `#__ef_comment__` or
 * submits via `#__ef_submit__` must open this modal first. See
 * client/src/dialog.ts (`__ef_export__` / `__ef_issue_modal__`).
 */
export async function openIssueModal(page: Page): Promise<void> {
  await page.locator("#__ef_export__").click();
  await expect(page.locator("#__ef_issue_modal__")).toBeVisible();
}
