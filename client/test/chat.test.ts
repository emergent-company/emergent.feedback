// chat.test.ts — the Chat tab is a report composer. These tests pin the two
// things that keep it safe: the report block is validated against closed enums
// before it can touch a form field, and the context sent to the agent is a
// deliberately small, redacted subset of the capture.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildChatContext,
  extractReport,
  validateReport,
} from "../src/chat";

test("validateReport: accepts a complete proposal", () => {
  const r = validateReport({
    title: "  Contrast is too low  ",
    type: "bug",
    action: "fix",
    expected: "The label is readable",
    actual: "Grey on grey",
    scope: { breadth: "region" },
    comment: "Hard to read on a laptop.",
    missing: ["which page"],
  });
  assert.ok(r);
  assert.equal(r?.title, "Contrast is too low");
  assert.equal(r?.type, "bug");
  assert.equal(r?.action, "fix");
  assert.deepEqual(r?.scope, { breadth: "region" });
  assert.deepEqual(r?.missing, ["which page"]);
});

test("validateReport: unknown enums are dropped, not coerced", () => {
  assert.equal(validateReport({ type: "chore", action: "fix" }), null);
  assert.equal(validateReport({ type: "bug", action: "rewrite" }), null);
  assert.equal(validateReport(null), null);
  assert.equal(validateReport([]), null);
  assert.equal(validateReport("bug"), null);
});

test("validateReport: a bad breadth is dropped but the report survives", () => {
  const r = validateReport({ type: "enhancement", action: "add", scope: { breadth: "page" } });
  assert.ok(r);
  assert.equal(r?.scope, undefined);
});

test("validateReport: strings are collapsed and length-capped", () => {
  const long = "x".repeat(400);
  const r = validateReport({ type: "bug", action: "change", title: long, comment: "a\n\nb" });
  assert.ok(r);
  assert.equal(r?.comment, "a b");
  assert.equal(r?.title?.length, 140);
  assert.ok(r?.title?.endsWith("…"));
});

test("validateReport: missing is capped and empty entries dropped", () => {
  const r = validateReport({
    type: "bug",
    action: "fix",
    missing: ["a", "", "  ", "b", "c", "d", "e", "f"],
  });
  assert.ok(r);
  assert.deepEqual(r?.missing, ["a", "b", "c", "d", "e"]);
});

test("extractReport: keeps the prose and parses the fenced block", () => {
  const reply = [
    "The button blends into the header.",
    "",
    "```json",
    '{"report":{"title":"Weak button","type":"bug","action":"fix","actual":"Same colour as the header"}}',
    "```",
  ].join("\n");
  const { prose, report } = extractReport(reply);
  assert.equal(prose, "The button blends into the header.");
  assert.equal(report?.title, "Weak button");
  assert.equal(report?.action, "fix");
});

test("extractReport: prose-only reply yields no report", () => {
  const { prose, report } = extractReport("What did you expect the button to do?");
  assert.equal(report, null);
  assert.equal(prose, "What did you expect the button to do?");
});

test("extractReport: a malformed block does not produce a report", () => {
  const { report } = extractReport("Hmm.\n\n```json\n{not json}\n```");
  assert.equal(report, null);
});

test("extractReport: falls back to an unfenced trailing object", () => {
  const { report } = extractReport(
    'Here it is: {"report":{"type":"enhancement","action":"add","title":"Add a skip link"}}'
  );
  assert.equal(report?.title, "Add a skip link");
});

test("buildChatContext: excludes DOM dumps and replay data", () => {
  const ctx = buildChatContext({
    selector: "#hero > button.cta",
    url: "https://example.com/page?token=secret#frag",
    tagName: "BUTTON",
    dataComponent: "HeroCallToAction",
    source: { file: "src/Hero.tsx", line: 42, component: "Hero" },
    computedStyles: {
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(10, 10, 10)",
      // not on the allow-list
      zIndex: "9999",
    },
    changes: [{ group: "textColor", before: "grey", after: "black" }],
    targetCount: 2,
  });

  assert.equal(ctx.selector, "#hero > button.cta");
  assert.equal(ctx.tagName, "button");
  assert.equal(ctx.component, "HeroCallToAction");
  assert.deepEqual(ctx.source, { file: "src/Hero.tsx", line: 42, component: "Hero" });
  assert.deepEqual(ctx.computedStyles, {
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgb(10, 10, 10)",
  });
  assert.equal(ctx.targetCount, 2);

  // Never sent: the query string (it can carry tokens), the fragment, any HTML.
  const raw = JSON.stringify(ctx);
  assert.ok(!raw.includes("secret"));
  assert.ok(!raw.includes("frag"));
  assert.ok(!("outerHTML" in ctx));
  assert.ok(!("userAgent" in ctx));
});

test("buildChatContext: single-target reports omit the count and empty fields", () => {
  const ctx = buildChatContext({
    selector: "main",
    url: "https://example.com/",
    targetCount: 1,
  });
  assert.equal(ctx.targetCount, undefined);
  assert.equal(ctx.computedStyles, undefined);
  assert.equal(ctx.changes, undefined);
});
