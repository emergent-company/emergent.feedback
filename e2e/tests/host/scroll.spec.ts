import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn } from "../../support/auth";
import { API_URL, DEFAULT_REPO, FIXTURE_URL } from "../../support/env";

// Badges must stay glued to their target when an ancestor scroll container
// scrolls, not just when the window scrolls.

async function seedFeedback(
  request: APIRequestContext,
  token: string,
  url: string,
  selector: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/feedback`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      url,
      selector,
      comment: "deep button needs a clearer label",
      context: {},
      repo: DEFAULT_REPO,
      label: "feedback",
    },
  });
  expect(response.status()).toBe(201);
}

test.describe("badges in a nested scroll container", () => {
  test("a badge follows its target inside an overflow container", async ({ context, request, page }) => {
    const token = await signIn(context);
    await context.addInitScript(() => {
      try {
        localStorage.setItem("__ef_badges_activated__", "1");
      } catch {
        /* storage unavailable */
      }
    });
    await seedFeedback(request, token, `${FIXTURE_URL}/scroll.html`, "#scroll-target");

    await page.goto("/scroll.html");
    await page.waitForFunction(() => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback);

    const badge = page.locator("#__ef_badge__0");
    await expect(badge).toBeVisible();

    const target = page.locator("#scroll-target");
    const beforeBadge = await badge.boundingBox();
    const beforeTarget = await target.boundingBox();
    expect(beforeBadge).not.toBeNull();
    expect(beforeTarget).not.toBeNull();

    // Scroll the ancestor, not the window.
    await page.locator("#scroll-box").evaluate((el) => {
      el.scrollTop = 80;
    });
    await page.waitForTimeout(120);

    const afterBadge = await badge.boundingBox();
    const afterTarget = await target.boundingBox();
    expect(afterBadge).not.toBeNull();
    expect(afterTarget).not.toBeNull();

    const badgeDelta = afterBadge!.y - beforeBadge!.y;
    const targetDelta = afterTarget!.y - beforeTarget!.y;
    expect(Math.abs(badgeDelta - targetDelta)).toBeLessThan(2);

    // Anchored to the target's top-right corner.
    expect(Math.abs(afterBadge!.x + afterBadge!.width - (afterTarget!.x + afterTarget!.width))).toBeLessThan(3);
    expect(Math.abs(afterBadge!.y + afterBadge!.height / 2 - afterTarget!.y)).toBeLessThan(3);
  });
});
