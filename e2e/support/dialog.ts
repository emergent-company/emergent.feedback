import type { Page } from "@playwright/test";

/**
 * The dialog opens on the "Design" tab (the live style editor). The feedback
 * textarea lives in the "Issues" panel and is `hidden` until that tab is
 * selected, so any spec that reads or writes `#__ef_comment__` must switch
 * first. See client/src/dialog.ts (`__ef_tab_issues__` / `__ef_panel_issues__`).
 */
export async function openIssuesTab(page: Page): Promise<void> {
  await page.locator("#__ef_tab_issues__").click();
}
