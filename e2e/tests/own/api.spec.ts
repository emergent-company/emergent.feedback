import { test, expect } from "@playwright/test";
import { DEFAULT_REPO, JWT_SECRET, MCP_API_KEY, TEST_USER } from "../../support/env";
import { mintToken } from "../../support/jwt";

// Direct HTTP coverage of the API surface, authenticated with an offline-minted
// session token (no GitHub OAuth round-trip).

const token = mintToken({ login: TEST_USER.login, secret: JWT_SECRET });
const auth = { Authorization: `Bearer ${token}` };

test.describe("API", () => {
  test("unauthenticated requests are rejected", async ({ request }) => {
    expect((await request.get("/me")).status()).toBe(401);
  });

  test("/me returns the session identity", async ({ request }) => {
    const res = await request.get("/me", { headers: auth });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ login: TEST_USER.login });
  });

  test("feedback lifecycle: create → list → get → delete", async ({ request }) => {
    const url = `https://e2e.test/page/${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const create = await request.post("/feedback", {
      headers: auth,
      data: {
        url,
        selector: "#x",
        comment: "e2e comment",
        context: { source: "e2e" },
        repo: DEFAULT_REPO,
        label: "feedback",
      },
    });
    expect(create.status()).toBe(201);
    const { id } = (await create.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const list = await request.get(`/feedback/list?url=${encodeURIComponent(url)}`, {
      headers: auth,
    });
    expect(list.ok()).toBeTruthy();
    const items = (await list.json()) as { id: number }[];
    expect(items.some((i) => i.id === id)).toBeTruthy();

    const get = await request.get(`/feedback/${id}`, { headers: auth });
    expect(get.ok()).toBeTruthy();

    const del = await request.delete(`/feedback/${id}`, { headers: auth });
    expect(del.status()).toBeLessThan(300);
  });

  test("api key lifecycle and MCP initialize", async ({ request }) => {
    const create = await request.post("/api/keys", {
      headers: auth,
      data: { repos: [DEFAULT_REPO] },
    });
    expect(create.status()).toBe(201);
    const key = (await create.json()) as { id: number; key: string };
    expect(key.key).toMatch(/^ef_/);

    const list = await request.get("/api/keys", { headers: auth });
    expect(list.ok()).toBeTruthy();
    const keys = (await list.json()) as { id: number }[];
    expect(keys.length).toBeGreaterThan(0);

    const init = await request.post("/mcp", {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${MCP_API_KEY}`,
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "e2e", version: "1.0" },
        },
      },
    });
    expect(init.ok()).toBeTruthy();
    const body = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("emergent-feedback");

    const revoke = await request.delete(`/api/keys/${key.id}`, { headers: auth });
    expect(revoke.status()).toBeLessThan(300);
  });
});
