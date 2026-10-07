// test/api.test.ts — unit tests for APIClient error handling (APIError).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { APIClient, APIError } from "../src/api";
import type { OverlayConfig } from "../src/config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient(): APIClient {
  return new APIClient({ apiBase: "https://example.test" } as OverlayConfig);
}

/** Stub globalThis.fetch to return a non-ok JSON response. */
function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () => ({
    ok: false,
    status,
    statusText: "Forbidden",
    text: async () => JSON.stringify(body),
    json: async () => body,
  })) as unknown as typeof fetch;
}

async function expectExportRejection(): Promise<unknown> {
  try {
    await makeClient().exportIssue({ ids: [1], repo: "owner/name" });
    throw new Error("expected exportIssue to reject");
  } catch (err) {
    return err;
  }
}

test("exportIssue surfaces app_access_required 403 as a typed APIError", async () => {
  const body = {
    error: "app_access_required",
    message: "The feedback app lacks access to this repo",
    repo: "owner/name",
    authorize_url: "https://github.com/apps/slug/installations/new",
  };
  stubFetch(403, body);

  const err = await expectExportRejection();

  assert.ok(err instanceof APIError);
  assert.equal((err as APIError).status, 403);
  assert.equal((err as APIError).code, "app_access_required");
  assert.deepEqual((err as APIError).body, body);
  assert.equal(
    ((err as APIError).body as { authorize_url: string }).authorize_url,
    body.authorize_url,
  );
});

test("exportIssue treats a plain message-only 403 as code undefined", async () => {
  stubFetch(403, { message: "repo not in scope" });

  const err = await expectExportRejection();

  assert.ok(err instanceof APIError);
  assert.equal((err as APIError).status, 403);
  assert.equal((err as APIError).code, undefined);
});
