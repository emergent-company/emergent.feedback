// test/source.test.ts — unit tests for source-location parsing + normalization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFileLineCol, normalizeRuntimePath } from "../src/source";

test("parseFileLineCol parses file:line:col", () => {
  assert.deepEqual(parseFileLineCol("src/App.tsx:12:3"), {
    file: "src/App.tsx",
    line: 12,
    column: 3,
  });
});

test("parseFileLineCol parses file:line", () => {
  assert.deepEqual(parseFileLineCol("src/App.tsx:12"), {
    file: "src/App.tsx",
    line: 12,
  });
});

test("parseFileLineCol tolerates Windows drive letters and webpack prefixes", () => {
  assert.deepEqual(parseFileLineCol("C:\\proj\\src\\App.tsx:10:5"), {
    file: "C:\\proj\\src\\App.tsx",
    line: 10,
    column: 5,
  });
  assert.deepEqual(parseFileLineCol("webpack:///./src/App.tsx:10:5"), {
    file: "webpack:///./src/App.tsx",
    line: 10,
    column: 5,
  });
});

test("parseFileLineCol returns file verbatim on malformed input (no line/col)", () => {
  assert.deepEqual(parseFileLineCol("src/App.tsx"), { file: "src/App.tsx" });
  assert.deepEqual(parseFileLineCol(""), { file: "" });
  // Trailing colon with no digits: treated as part of the file, no fabrication.
  assert.deepEqual(parseFileLineCol("src/App.tsx:"), { file: "src/App.tsx:" });
});

test("normalizeRuntimePath strips webpack:// prefixes", () => {
  assert.equal(normalizeRuntimePath("webpack:///./src/App.tsx"), "src/App.tsx");
  assert.equal(normalizeRuntimePath("webpack://next/./src/App.tsx"), "src/App.tsx");
});

test("normalizeRuntimePath strips query/hash suffixes", () => {
  assert.equal(normalizeRuntimePath("src/App.tsx?abc123"), "src/App.tsx");
  assert.equal(normalizeRuntimePath("src/App.tsx#L12"), "src/App.tsx");
});

test("normalizeRuntimePath preserves repo-relative paths verbatim (no /src/ truncation)", () => {
  assert.equal(normalizeRuntimePath("packages/web/src/App.tsx"), "packages/web/src/App.tsx");
  assert.equal(normalizeRuntimePath("src/App.tsx"), "src/App.tsx");
});

test("normalizeRuntimePath relativizes absolute paths without fabrication", () => {
  assert.equal(normalizeRuntimePath("/home/user/proj/src/App.tsx"), "home/user/proj/src/App.tsx");
  assert.equal(normalizeRuntimePath("C:\\proj\\src\\App.tsx"), "proj\\src\\App.tsx");
  assert.equal(normalizeRuntimePath("C:/proj/src/App.tsx"), "proj/src/App.tsx");
});
