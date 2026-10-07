import { test, expect } from "@playwright/test";

test.describe("landing page (own)", () => {
  test("renders the marketing page and embeds the overlay", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#hero-title")).toBeVisible();
    await expect(page.locator("#try-it")).toBeVisible();
    await expect(page.getByText("Self-host").first()).toBeVisible();
    await expect(page.locator('script[src*="emergent-feedback.js"]')).toHaveCount(1);
  });

  test("health and schema endpoints respond", async ({ request }) => {
    const health = await request.get("/health");
    expect(health.ok()).toBeTruthy();
    expect(await health.json()).toMatchObject({ ok: true });

    const schema = await request.get("/schema/envelope.v1.json");
    expect(schema.ok()).toBeTruthy();
  });

  test("Try it enters comment mode", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);
    await page.click("#try-it");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
  });
});
