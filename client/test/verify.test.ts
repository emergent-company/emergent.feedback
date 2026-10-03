// test/verify.test.ts — unit tests for verification-contract evaluation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateContract } from "../src/verify";
import type { VerificationContract } from "../src/envelope";

/** Minimal element fake: `tagName` + a kebab-case computed-style map. */
class FakeElement {
  tagName: string;
  private styles: Record<string, string>;

  constructor(tagName: string, styles: Record<string, string> = {}) {
    this.tagName = tagName;
    this.styles = styles;
  }
}

/** Install a fake `document.querySelector` + `window.getComputedStyle`. */
function installDOM(elements: Record<string, FakeElement>): void {
  const g = globalThis as unknown as { document: unknown; window: unknown };
  g.document = {
    querySelector(selector: string): FakeElement | null {
      return elements[selector] ?? null;
    },
  };
  g.window = {
    getComputedStyle(el: FakeElement) {
      return {
        getPropertyValue(prop: string): string {
          return el.styles[prop] ?? "";
        },
      };
    },
  };
}

function styleContract(check: Record<string, string>): VerificationContract {
  return { kind: "style_assertion", check };
}

test("style_assertion changed → amber (cannot verify direction), unchanged → red", () => {
  installDOM({ ".btn": new FakeElement("button", { "background-color": "rgb(0, 0, 255)" }) });

  const changed = evaluateContract(
    styleContract({
      selector: ".btn",
      prop: "backgroundColor",
      before: "rgb(255, 0, 0)",
      operator: "changed",
    })
  );
  assert.equal(changed.result, "amber");

  const unchanged = evaluateContract(
    styleContract({
      selector: ".btn",
      prop: "backgroundColor",
      before: "rgb(0, 0, 255)",
      operator: "changed",
    })
  );
  assert.equal(unchanged.result, "red");
});

test("unknown style_assertion operator returns amber, not green", () => {
  installDOM({ ".btn": new FakeElement("button", { "background-color": "rgb(0, 0, 255)" }) });

  const out = evaluateContract(
    styleContract({
      selector: ".btn",
      prop: "backgroundColor",
      before: "rgb(255, 0, 0)",
      operator: "surpasses",
    })
  );
  assert.equal(out.result, "amber");
});

test("changed-but-wrong-direction value does not falsely claim success", () => {
  // Value changed 12px → 8px (wrong direction: smaller, not larger).
  installDOM({ ".btn": new FakeElement("button", { "font-size": "8px" }) });

  const out = evaluateContract(
    styleContract({
      selector: ".btn",
      prop: "fontSize",
      before: "12px",
      operator: "changed",
    })
  );
  assert.notEqual(out.result, "green");
  assert.equal(out.result, "amber");
});

test("style_assertion equals operator matches/refuses target", () => {
  installDOM({ ".x": new FakeElement("div", { color: "rgb(0, 0, 0)" }) });

  const green = evaluateContract(
    styleContract({ selector: ".x", prop: "color", value: "rgb(0, 0, 0)", operator: "equals" })
  );
  assert.equal(green.result, "green");

  const red = evaluateContract(
    styleContract({
      selector: ".x",
      prop: "color",
      value: "rgb(255, 255, 255)",
      operator: "equals",
    })
  );
  assert.equal(red.result, "red");
});

test("style_assertion present operator checks non-empty value", () => {
  installDOM({ ".x": new FakeElement("div", { color: "rgb(0, 0, 0)" }) });
  const present = evaluateContract(
    styleContract({ selector: ".x", prop: "color", operator: "present" })
  );
  assert.equal(present.result, "green");
});

test("style_assertion missing selector/prop → amber", () => {
  installDOM({});
  const noSelector = evaluateContract(styleContract({ prop: "color", operator: "changed" }));
  assert.equal(noSelector.result, "amber");
  const noProp = evaluateContract(styleContract({ selector: ".x", operator: "changed" }));
  assert.equal(noProp.result, "amber");
});

test("anchor_stable found → amber, missing → red (never green)", () => {
  installDOM({ ".btn": new FakeElement("button") });

  // Found with a matching fingerprint tag: anchored, but mere presence/tag
  // match cannot confirm the fix — must be amber, NOT green.
  const matching = evaluateContract({
    kind: "anchor_stable",
    check: { selector: ".btn", path: "main > section > button" },
  });
  assert.equal(matching.result, "amber");

  // Found without a path (no expected tag): still anchored → amber.
  const noPath = evaluateContract({
    kind: "anchor_stable",
    check: { selector: ".btn" },
  });
  assert.equal(noPath.result, "amber");

  // Found but tag changed → amber.
  const tagChanged = evaluateContract({
    kind: "anchor_stable",
    check: { selector: ".btn", path: "main > section > a" },
  });
  assert.equal(tagChanged.result, "amber");

  // Missing → red.
  const missing = evaluateContract({
    kind: "anchor_stable",
    check: { selector: ".missing", path: "main > section > button" },
  });
  assert.equal(missing.result, "red");
});

test("anchor_stable never returns green (no false auto-verify)", () => {
  // Every anchor_stable evaluation path: found (matching tag), found (no
  // path), found (tag changed), missing, missing selector. None may be green —
  // anchor_stable is not machine-checkable and must never auto-verify.
  installDOM({ ".btn": new FakeElement("button") });

  const cases: VerificationContract[] = [
    { kind: "anchor_stable", check: { selector: ".btn", path: "main > section > button" } },
    { kind: "anchor_stable", check: { selector: ".btn" } },
    { kind: "anchor_stable", check: { selector: ".btn", path: "main > section > a" } },
    { kind: "anchor_stable", check: { selector: ".missing", path: "main > section > button" } },
    { kind: "anchor_stable", check: { path: "main > section > button" } }, // missing selector
  ];

  for (const contract of cases) {
    assert.notEqual(
      evaluateContract(contract).result,
      "green",
      `anchor_stable must not return green: ${JSON.stringify(contract)}`
    );
  }
});

test("human contract always amber", () => {
  assert.equal(evaluateContract({ kind: "human" }).result, "amber");
});
