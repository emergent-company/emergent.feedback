import { expect, type Page } from "@playwright/test";

/**
 * Submission-first flow: clicking an element opens the issue submission modal
 * (`#__ef_issue_modal__`) immediately — there is no separate **Send to GitHub**
 * (`#__ef_export__`) step anymore. The modal holds the comment textarea
 * (`#__ef_comment__`), **Save** (`#__ef_submit__`), **Create issue**
 * (`#__ef_issue_submit__`) and the context/HTML preview; **Edit element**
 * (`#__ef_edit_element__`) swaps to the style editor. Any spec that reads or
 * writes `#__ef_comment__` or submits via `#__ef_submit__` must have this
 * modal open first. See client/src/dialog.ts (`__ef_issue_modal__`).
 */
export async function openIssueModal(page: Page): Promise<void> {
  await expect(page.locator("#__ef_issue_modal__")).toBeVisible();
}
