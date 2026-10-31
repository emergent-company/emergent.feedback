// test/url.test.ts — page-identity normalisation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "../src/url";

test("exact mode keeps the full URL", () => {
  assert.equal(
    normalizeUrl("https://example.test/docs?tab=api#install", "exact"),
    "https://example.test/docs?tab=api#install",
  );
});

test("path mode drops the fragment but keeps the query string", () => {
  assert.equal(
    normalizeUrl("https://example.test/docs?tab=api#install", "path"),
    "https://example.test/docs?tab=api",
  );
});

test("path mode collapses hash-only navigation to the same page", () => {
  assert.equal(
    normalizeUrl("https://example.test/#how", "path"),
    normalizeUrl("https://example.test/", "path"),
  );
});

test("path mode on malformed input falls back to string slicing", () => {
  assert.equal(normalizeUrl("not a url#frag", "path"), "not a url");
});
