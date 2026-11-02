// test/labels.test.ts — unit tests for component-aware element labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultIssueTopic,
  componentName,
  elementLabel,
} from "../src/labels";

test("componentName prefers the framework component", () => {
  assert.equal(
    componentName({
      dataComponent: "PricingCard > div > span",
      source: { component: "UpgradeButton" },
    }),
    "UpgradeButton"
  );
});

test("componentName falls back to the nearest data-component name", () => {
  assert.equal(componentName({ dataComponent: "Checkout > div > span" }), "Checkout");
  assert.equal(componentName({ dataComponent: "Checkout" }), "Checkout");
});

test("componentName ignores minified one-character component names", () => {
  assert.equal(
    componentName({ dataComponent: "Checkout", source: { component: "e" } }),
    "Checkout"
  );
});

test("componentName returns undefined when nothing names the component", () => {
  assert.equal(componentName({}), undefined);
  assert.equal(componentName({ source: { component: "  " } }), undefined);
});

test("elementLabel falls back to the selector tail", () => {
  assert.equal(elementLabel({}, "main > div:nth-of-type(1)"), "div:nth-of-type(1)");
  assert.equal(
    elementLabel({ source: { component: "UpgradeButton" } }, "main > button"),
    "UpgradeButton"
  );
});

test("buildDefaultIssueTopic uses the component and keeps the singular title", () => {
  assert.equal(
    buildDefaultIssueTopic(
      { source: { component: "UpgradeButton" } },
      "main > div:nth-of-type(1)",
      0
    ),
    "Feedback on UpgradeButton"
  );
  assert.equal(
    buildDefaultIssueTopic(
      { dataComponent: "Checkout > div" },
      "main > div:nth-of-type(1)",
      2
    ),
    "Feedback: 3 comments on Checkout"
  );
});
