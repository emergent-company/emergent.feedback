import { test, expect } from "@playwright/test";
import { signIn } from "../../support/auth";

// "Other page": a third-party-style host page (served by the fixture server)
// that embeds the overlay via a <script> tag. Verifies activation, capture and
// the payload that would be exported to GitHub.

test.describe("embedded overlay on a host page", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  async function activate(page: import("@playwright/test").Page) {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
  }

  test("captures a stable selector and submits feedback", async ({ page }) => {
    await page.goto("/host.html");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    await activate(page);
    await page.locator("#target-btn").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();

    await page.fill("#__ef_comment__", "primary action label is unclear");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/feedback") && r.request().method() === "POST",
      ),
      page.click("#__ef_submit__"),
    ]);
    expect(response.status()).toBe(201);

    const payload = response.request().postDataJSON() as {
      selector: string;
      repo: string;
      context: Record<string, unknown>;
    };
    expect(payload.selector).toBe("#target-btn");
    expect(payload.repo).toBe("e2e/host-fixture");
    expect(payload.context.sessionId).toBeTruthy();
    expect(payload.context.cssFramework).toBeDefined();
  });

  test("data-testid is preferred as the selector anchor", async ({ page }) => {
    await page.goto("/host.html");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    await activate(page);
    await page.locator('[data-testid="pricing-upgrade"]').click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();

    await page.fill("#__ef_comment__", "upgrade CTA is unclear");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/feedback") && r.request().method() === "POST",
      ),
      page.click("#__ef_submit__"),
    ]);
    const body = await response.text();
    expect(response.status(), body).toBe(201);

    const payload = response.request().postDataJSON() as { selector: string };
    expect(payload.selector).toContain("pricing-upgrade");
  });
});
