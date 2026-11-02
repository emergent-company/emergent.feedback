import { test, expect, type Page } from "@playwright/test";
import { signIn } from "../../support/auth";

// The design gallery: the agent proposes variants, the reporter previews them
// in sandboxed iframes, and the pick rides along with the report. The agent is
// stubbed over SSE so the test never needs a live model.

const GALLERY_REPLY = {
  report: {
    title: "Hero is flat",
    type: "enhancement",
    action: "change",
    actual: "The hero reads as one grey block.",
    comment: "Two layout options to compare.",
  },
  gallery: {
    title: "Hero options",
    variants: [
      {
        id: "a",
        label: "Split hero",
        notes: "Copy left, visual right.",
        html: '<section style="padding:24px"><h1>Split</h1></section>',
      },
      {
        id: "b",
        label: "Stacked hero",
        notes: "Copy above the fold, visual below.",
        html: '<section style="padding:36px"><h1>Stacked</h1></section>',
        css: "h1{letter-spacing:-0.02em}",
      },
      {
        id: "c",
        label: "Centered hero",
        notes: "One column, centered.",
        html: '<section style="padding:40px;text-align:center"><h1>Centered</h1></section>',
      },
    ],
  },
};

function sse(frames: unknown[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
}

async function stubAgent(page: Page): Promise<void> {
  await page.route("**/api/memory/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: sse([
        {
          type: "token",
          token: `Three options, and the report below.\n\n\`\`\`json\n${JSON.stringify(GALLERY_REPLY)}\n\`\`\``,
        },
        { type: "done" },
      ]),
    })
  );
}

async function openChat(page: Page): Promise<void> {
  await page.goto("/host.html");
  await page.waitForFunction(
    () => !!(window as unknown as { EmergentFeedback?: unknown }).EmergentFeedback
  );
  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await expect(page.locator("#__ef_indicator__")).toBeVisible();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  await page.locator("#target-btn").click();
  await expect(page.locator("#__ef_panel_feedback__")).toBeVisible();
  await page.click("#__ef_tab_chat__");
}

async function askForOptions(page: Page): Promise<void> {
  await page.fill("#__ef_chat_input__", "Show me 3 layout options for this hero");
  await page.click("#__ef_chat_send__");
  await expect(page.locator(".ef-gallery-card")).toBeVisible();
}

test.describe("design gallery (host fixture)", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("an agent gallery renders as a card with the variants listed", async ({ page }) => {
    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    await expect(page.locator(".ef-gallery-card-head")).toContainText("Hero options");
    await expect(page.locator(".ef-gallery-options li")).toHaveCount(3);
    await expect(page.locator(".ef-gallery-options")).toContainText("Split hero");
    await expect(page.locator(".ef-gallery-options")).toContainText("Centered hero");
    // The report proposal still renders and still does not touch the form.
    await expect(page.locator(".ef-report-card")).toContainText("Hero is flat");
  });

  test("the gallery opens in sandboxed iframes and the pick sticks", async ({ page }) => {
    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    await page.click("[data-open-gallery]");
    const layer = page.locator(".ef-gallery-layer");
    await expect(layer).toBeVisible();
    await expect(layer.locator(".ef-gallery-tile")).toHaveCount(3);

    // Every preview is script-free and opaque-origin.
    const iframes = layer.locator("iframe.ef-gallery-iframe");
    await expect(iframes).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(iframes.nth(i)).toHaveAttribute("sandbox", "");
      const srcdoc = await iframes.nth(i).getAttribute("srcdoc");
      expect(srcdoc).toContain("default-src 'none'");
      expect(srcdoc).toContain("script-src 'none'");
    }
    await expect(iframes.nth(1)).toHaveAttribute("srcdoc", /Stacked/);

    // Preview width is a view toggle, not a page change.
    await page.click('[data-gallery-width="mobile"]');
    await expect(layer.locator(".ef-gallery-grid")).toHaveAttribute("data-width", "mobile");

    // Pick the second variant.
    await layer.locator('[data-variant="b"] [data-pick]').click();
    await expect(layer.locator('[data-variant="b"]')).toHaveClass(/is-picked/);
    await expect(layer.locator('[data-variant="b"] [data-pick]')).toHaveText("Chosen");
    await expect(layer.locator('[data-variant="a"]')).not.toHaveClass(/is-picked/);

    // Escape closes the layer without closing the pane.
    await page.keyboard.press("Escape");
    await expect(layer).toHaveCount(0);
    await expect(page.locator("#__ef_dialog__")).toBeVisible();

    // The choice is visible on the report form.
    await page.click("#__ef_tab_feedback__");
    await expect(page.locator("#__ef_variant_chip__")).toBeVisible();
    await expect(page.locator("#__ef_variant_name__")).toHaveText("Stacked hero");
  });

  test("the picked variant is submitted with the report as evidence", async ({ page }) => {
    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    await page.click("[data-open-gallery]");
    await page.locator('[data-variant="b"] [data-pick]').click();
    await page.keyboard.press("Escape");

    await page.click("#__ef_tab_feedback__");
    await page.fill("#__ef_comment__", "Go with the stacked hero.");

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/feedback") && r.method() === "POST"),
      page.click("#__ef_submit__"),
    ]);

    const body = request.postDataJSON() as {
      context?: { intent?: { design?: { variant?: { id?: string; label?: string; html?: string }; alternatives?: unknown[] } } };
    };
    expect(body.context?.intent?.design?.variant?.id).toBe("b");
    expect(body.context?.intent?.design?.variant?.label).toBe("Stacked hero");
    expect(body.context?.intent?.design?.variant?.html).toContain("Stacked");
    expect(body.context?.intent?.design?.alternatives).toHaveLength(2);

    await expect(page.locator("#__ef_dialog__")).toHaveCount(0);
  });

  test("clearing the choice removes it from the report", async ({ page }) => {
    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    await page.click("[data-open-gallery]");
    await page.locator('[data-variant="a"] [data-pick]').click();
    await page.keyboard.press("Escape");
    await page.click("#__ef_tab_feedback__");
    await expect(page.locator("#__ef_variant_chip__")).toBeVisible();

    await page.click("#__ef_variant_clear__");
    await expect(page.locator("#__ef_variant_chip__")).toBeHidden();
  });

  test("undocked, the gallery owns Tab while it is open", async ({ page }) => {    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    // Undock: the pane becomes modal, which installs the card's Tab trap.
    await page.click("#__ef_dock__");
    await page.click("[data-open-gallery]");
    await expect(page.locator(".ef-gallery-layer")).toBeVisible();

    for (let i = 0; i < 8; i += 1) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof Element && !!el.closest(".ef-gallery-layer");
      })
    ).toBe(true);
  });

  test("a later turn tells the agent which variant was chosen", async ({ page }) => {
    await stubAgent(page);
    await openChat(page);
    await askForOptions(page);

    await page.click("[data-open-gallery]");
    await page.locator('[data-variant="b"] [data-pick]').click();
    await page.keyboard.press("Escape");

    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/api/memory/chat") && r.method() === "POST"
      ),
      (async () => {
        await page.fill("#__ef_chat_input__", "Make the button bigger in that one");
        await page.click("#__ef_chat_send__");
      })(),
    ]);

    const body = request.postDataJSON() as {
      context?: { selectedVariant?: { id?: string; label?: string } };
    };
    expect(body.context?.selectedVariant?.id).toBe("b");
    expect(body.context?.selectedVariant?.label).toBe("Stacked hero");
    // The markup stays in the browser; only the label travels.
    expect(JSON.stringify(body.context)).not.toContain("<section");
  });
});
