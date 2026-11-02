import { expect, type Page } from "@playwright/test";

/**
 * Submission-first flow: clicking an element opens the docked pane on its
 * Feedback tab, already showing the report form (`#__ef_report__`). The form
 * holds the comment textarea (`#__ef_comment__`), **Save** (`#__ef_submit__`),
 * **Create issue** (`#__ef_issue_submit__`) and the context/HTML preview;
 * the **Edit element** tab (`#__ef_tab_edit__`) shows the style editor
 * (`#__ef_design__`), and **All reports** (`#__ef_all_reports__`) opens the
 * page-level draft/submitted list. Any spec that reads or writes
 * `#__ef_comment__` or submits via `#__ef_submit__` must have this report form
 * open first. See client/src/dialog.ts (`__ef_report__`).
 */
export async function openIssueModal(page: Page): Promise<void> {
  await expect(page.locator("#__ef_panel_feedback__")).toBeVisible();
  await expect(page.locator("#__ef_report__")).toBeVisible();
}

/** The Changes tab's list. */
export async function expectChangesPanel(page: Page): Promise<void> {
  await expect(page.locator("#__ef_panel_changes__")).toBeVisible();
  await expect(page.locator("#__ef_changes__")).toBeVisible();
}
