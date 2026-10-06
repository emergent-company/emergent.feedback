// test/envelope.test.ts — unit tests for provenance + explanation scoring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProvenance, scoreExplanation } from "../src/envelope";
import type { FeedbackIntent } from "../src/envelope";

function intent(overrides: Partial<FeedbackIntent> = {}): FeedbackIntent {
  return {
    kind: "bug",
    action: "fix",
    scope: { breadth: "element", targets: [] },
    expected: "",
    actual: "",
    ...overrides,
  };
}

test("computeProvenance: empty expected → absent", () => {
  const out = computeProvenance({ intent: intent({ expected: "" }), hasScreenshot: false });
  assert.equal(out["intent.expected"], "absent");
});

test("computeProvenance: actual unedited → captured, edited → stated", () => {
  const unedited = computeProvenance({
    intent: intent({ actual: "color: rgb(255, 0, 0)" }),
    hasScreenshot: false,
  });
  assert.equal(unedited["intent.actual"], "captured");

  const edited = computeProvenance({
    intent: intent({ actual: "make it red", actualEdited: true }),
    hasScreenshot: false,
  });
  assert.equal(edited["intent.actual"], "stated");
});

test("computeProvenance: source confidence none → absent, else captured", () => {
  const none = computeProvenance({
    intent: intent(),
    hasScreenshot: false,
    source: { resolution: "none", confidence: "none" },
  });
  assert.equal(none["target.source"], "absent");

  const exact = computeProvenance({
    intent: intent(),
    hasScreenshot: false,
    source: { resolution: "build-stamp", confidence: "exact" },
  });
  assert.equal(exact["target.source"], "captured");
});

test("computeProvenance: css frameworks empty → absent, else inferred", () => {
  assert.equal(
    computeProvenance({ intent: intent(), hasScreenshot: false, cssFrameworks: [] })[
      "environment.css_framework"
    ],
    "absent"
  );
  assert.equal(
    computeProvenance({
      intent: intent(),
      hasScreenshot: false,
      cssFrameworks: ["Tailwind CSS"],
    })["environment.css_framework"],
    "inferred"
  );
});

test("computeProvenance: screenshot flag captured/absent", () => {
  assert.equal(
    computeProvenance({ intent: intent(), hasScreenshot: true })["visual.screenshot_ref"],
    "captured"
  );
  assert.equal(
    computeProvenance({ intent: intent(), hasScreenshot: false })["visual.screenshot_ref"],
    "absent"
  );
});

test("computeProvenance: intent.changes stated only when non-empty", () => {
  const none = computeProvenance({ intent: intent({ changes: [] }), hasScreenshot: false });
  assert.equal(none["intent.changes"], "absent");

  const withChanges = computeProvenance({
    intent: intent({ changes: [{ target: "#a", group: "padding", before: "p-0", after: "p-4" }] }),
    hasScreenshot: false,
  });
  assert.equal(withChanges["intent.changes"], "stated");
});

test("scoreExplanation: precise when expected+actual present and ≥8 words", () => {
  const out = scoreExplanation("the button should be much larger with a bigger font", {
    expected: "make it bigger",
    actual: "font size: 12px",
  });
  assert.equal(out.quality, "precise");
  assert.equal(out.quality_score, 1);
});

test("scoreExplanation: vague when only expected present", () => {
  const out = scoreExplanation("make it bigger", {
    expected: "make it bigger",
    actual: "",
  });
  assert.equal(out.quality, "vague");
  assert.ok(out.quality_score > 0 && out.quality_score < 0.7, `score=${out.quality_score}`);
});

test("scoreExplanation: missing when no expected/actual/words", () => {
  const out = scoreExplanation("", { expected: "", actual: "" });
  assert.equal(out.quality, "missing");
  assert.equal(out.quality_score, 0);
});
