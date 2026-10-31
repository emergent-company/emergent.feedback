import { test, expect } from "@playwright/test";
import { signIn } from "../../support/auth";
import { openIssueModal } from "../../support/dialog";
import { API_URL, JWT_SECRET, TEST_USER } from "../../support/env";
import { mintToken } from "../../support/jwt";

// Draft-safe re-auth regression: a 401 while saving triggers a login layer over
// the still-mounted issue modal (draft intact), and sign-in retries the original
// POST exactly once — 401 then 201, never a duplicate comment.

test.describe("draft-safe re-auth (own)", () => {
  test("keeps the draft across a 401 and retries the POST once after sign-in", async ({
    page,
    context,
  }) => {
    await signIn(context);

    // Force only the first Save POST to 401. The token itself stays valid, so
    // background verification calls cannot race this test into a logout.
    let postAttempts = 0;
    await context.route("**/feedback", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      postAttempts += 1;
      if (postAttempts === 1) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "unauthorized" }),
        });
      }
      return route.fallback();
    });

    // Stub the OAuth popup: post a fresh valid token back to the opener at the
    // API origin, then close — no real GitHub round-trip.
    await context.route("**/auth/github**", (route) => {
      const token = mintToken({ login: TEST_USER.login, secret: JWT_SECRET });
      const payload = {
        type: "emergent_feedback_auth",
        token,
        login: TEST_USER.login,
        avatar: "",
      };
      const body = `<!doctype html><html><body><script>
        window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(API_URL)});
        window.close();
      </script></body></html>`;
      return route.fulfill({ contentType: "text/html", body });
    });

    await page.goto("/");
    await page.waitForFunction(
      () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback,
    );

    await page.click("#try-it");
    await expect(page.locator("#__ef_indicator__")).toBeVisible();

    await page.locator("#hero-title").click();
    await expect(page.locator("#__ef_dialog__")).toBeVisible();
    await openIssueModal(page);
    await expect(page.locator("#__ef_comment__")).toBeVisible();

    const draft = `reauth-draft-${Date.now()}-keep-me`;
    await page.fill("#__ef_comment__", draft);

    // First submit: the stubbed 401 → login layer.
    const firstResponse = page.waitForResponse(
      (r) => r.url().includes("/feedback") && r.request().method() === "POST",
    );
    await page.click("#__ef_submit__");
    expect((await firstResponse).status()).toBe(401);

    // The login layer appears over the still-mounted pane; the draft survives.
    await expect(page.locator("#__ef_auth_login__")).toBeVisible();
    await expect(page.locator("#__ef_comment__")).toHaveValue(draft);

    // Sign in; the original POST is retried exactly once and now succeeds.
    const retryResponse = page.waitForResponse(
      (r) => r.url().includes("/feedback") && r.request().method() === "POST",
    );
    await page.click("#__ef_auth_login__");
    expect((await retryResponse).status()).toBe(201);

    // Success closes the pane.
    await expect(page.locator("#__ef_dialog__")).toBeHidden();

    // Exactly two attempts: one 401, one pass-through 201 — no duplicate.
    expect(postAttempts).toBe(2);
  });
});
