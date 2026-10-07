import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ALLOW_WRITES,
  E2E_DIR,
  HOST_PASS,
  HOST_STORAGE_STATE,
  HOST_URL,
  HOST_USER,
} from "../../support/env";

// Env-gated specs for a deployed page ("other page") that already embeds the
// overlay. Skips unless E2E_HOST_URL is set. Read-only by default; submitting
// feedback requires E2E_ALLOW_WRITES=1.

const statePath = HOST_STORAGE_STATE || path.join(E2E_DIR, ".auth", "host.json");
const haveCreds = Boolean(HOST_USER && HOST_PASS);

test.skip(!HOST_URL, "E2E_HOST_URL not set — skipping remote host specs.");
test.skip(
  Boolean(HOST_URL) && !haveCreds && !existsSync(statePath),
  "no E2E_STORAGE_STATE file and no E2E_HOST_USER/E2E_HOST_PASS — skipping remote host specs.",
);

test.describe("remote host app", () => {
  test("overlay bundle boots and activates", async ({ page }) => {
    await page.goto(HOST_URL);
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback,
      undefined,
      { timeout: 20_000 },
    );

    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
  });

  test("dialog opens on the first interactive element", async ({ page }) => {
    await page.goto(HOST_URL);
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback,
      undefined,
      { timeout: 20_000 },
    );

    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");

    const target = page.locator("a, button, [role=button]").first();
    await target.click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await page.click("#__ef_cancel__");
  });

  test("submitting feedback is gated by E2E_ALLOW_WRITES", async ({ page }) => {
    test.skip(!ALLOW_WRITES, "E2E_ALLOW_WRITES is not set — read-only run.");
    await page.goto(HOST_URL);
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback,
      undefined,
      { timeout: 20_000 },
    );

    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");

    await page.locator("a, button, [role=button]").first().click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await page.fill("#__ef_comment__", "automated e2e feedback submission");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/feedback") && r.request().method() === "POST",
      ),
      page.click("#__ef_submit__"),
    ]);
    expect(response.status()).toBeLessThan(300);
  });
});
