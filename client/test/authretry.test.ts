// test/authretry.test.ts — unit tests for describeAPIError + withAuthRetry.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APIError,
  AuthCancelledError,
  describeAPIError,
  withAuthRetry,
} from "../src/api";

test("describeAPIError renders a friendly message for 401", () => {
  assert.equal(
    describeAPIError(new APIError(401, "401: expired token")),
    "Your session expired. Sign in to continue."
  );
});

test("describeAPIError strips the '<status>: ' prefix", () => {
  assert.equal(
    describeAPIError(new APIError(403, "403: repo not in scope")),
    "repo not in scope"
  );
  assert.equal(
    describeAPIError(new APIError(500, "500: internal error")),
    "internal error"
  );
});

test("describeAPIError leaves unprefixed messages intact", () => {
  assert.equal(
    describeAPIError(new APIError(502, "bad gateway")),
    "bad gateway"
  );
});

test("describeAPIError stringifies non-APIError values", () => {
  assert.equal(describeAPIError(new Error("boom")), "Error: boom");
  assert.equal(describeAPIError("plain"), "plain");
});

test("withAuthRetry rethrows non-401 errors unchanged", async () => {
  const boom = new APIError(500, "500: nope");
  const fn = withAuthRetry(() => Promise.reject(boom), async () => true);
  await assert.rejects(fn(), (err) => err === boom);
});

test("withAuthRetry retries the same operation once on 401", async () => {
  let calls = 0;
  const fn = withAuthRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new APIError(401, "401: expired");
      return "ok";
    },
    async () => true
  );
  const result = await fn();
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withAuthRetry throws AuthCancelledError when the user declines", async () => {
  let calls = 0;
  const fn = withAuthRetry(
    async () => {
      calls += 1;
      throw new APIError(401, "401: expired");
    },
    async () => false
  );
  await assert.rejects(fn(), AuthCancelledError);
  assert.equal(calls, 1);
});

test("withAuthRetry does not retry a 401 from the retry itself", async () => {
  let ensureCalls = 0;
  const fn = withAuthRetry(
    async () => {
      throw new APIError(401, "401: still expired");
    },
    async () => {
      ensureCalls += 1;
      return true;
    }
  );
  await assert.rejects(
    fn(),
    (err) => err instanceof APIError && err.status === 401
  );
  assert.equal(ensureCalls, 1);
});
