// test/console.test.ts — unit tests for the console stack parser + redactor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStack, redactStack, shortenFramePath } from "../src/console";

test("parseStack parses V8 `at fn (path:line:col)`", () => {
  assert.deepEqual(parseStack("Error: boom\n    at foo (/a/b/c/d/e/f.js:10:5)"), [
    { path: "/d/e/f.js", line: 10, column: 5 },
  ]);
});

test("parseStack parses V8 `at path:line:col`", () => {
  assert.deepEqual(parseStack("at /a/b/c/d/e/f.js:10:5"), [
    { path: "/d/e/f.js", line: 10, column: 5 },
  ]);
});

test("parseStack parses Firefox `fn@path:line:col`", () => {
  assert.deepEqual(parseStack("foo@http://example.com/app.js:10:5"), [
    { path: "http://example.com/app.js", line: 10, column: 5 },
  ]);
});

test("parseStack drops unparseable lines but keeps parseable frames", () => {
  assert.deepEqual(parseStack("at /a/b/c/d/e/f.js:1:2\nnot-a-frame\nat /x/y.js:3:4"), [
    { path: "/d/e/f.js", line: 1, column: 2 },
    { path: "/x/y.js", line: 3, column: 4 },
  ]);
  assert.deepEqual(parseStack("Error: boom\n  at somefunction\n  <anonymous>\n  not a location"), []);
});

test("shortenFramePath keeps URL/app paths and shortens absolute filesystem paths", () => {
  // Scheme / URL paths preserved.
  assert.equal(shortenFramePath("http://example.com/a/b/c/d.js"), "http://example.com/a/b/c/d.js");
  assert.equal(shortenFramePath("webpack:///src/foo/bar.js"), "webpack:///src/foo/bar.js");
  assert.equal(shortenFramePath("file:///tmp/x.js"), "file:///tmp/x.js");
  assert.equal(shortenFramePath("app://bundle/main.js"), "app://bundle/main.js");
  // Relative (app-relative) path preserved.
  assert.equal(shortenFramePath("src/foo.js"), "src/foo.js");
  // Unix absolute → last 3 segments.
  assert.equal(shortenFramePath("/a/b/c/d/e/f.js"), "/d/e/f.js");
  // Windows absolute → last 3 segments.
  assert.equal(shortenFramePath("C:\\a\\b\\c\\d\\e.js"), "C:\\c\\d\\e.js");
});

test("redactStack redacts tokens and truncates to 4000 chars", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const out = redactStack(`boom ${jwt}`);
  assert.ok(!out.includes("eyJ"), "JWT leaked in stack_text");
  assert.ok(out.includes("[redacted]"));

  // Space-separated words: no 40-char token run, so only truncation applies.
  const long = "word ".repeat(1000); // 5000 chars
  assert.equal(redactStack(long).length, 4000);
});
