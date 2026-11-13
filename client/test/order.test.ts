// test/order.test.ts — the session destination (order-box) contract.
//
// These pin the two things that must not drift: what the order body contains
// (the reporter's message plus the evidence, nothing that needs a follow-up
// question) and how the browser posts it (endpoint, credentials, bearer header,
// and a refusal that reads as a refusal).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderPayload,
  orderConfigValid,
  orderEndpoint,
  pagePath,
  sendOrder,
  OrderError,
} from "../src/order";
import type { OrderPayload } from "../src/order";

const SESSION = "13e9fff6-dff0-4ec9-bcef-26aa2cb7ba28";

function payload(overrides: Partial<OrderPayload> = {}): OrderPayload {
  return {
    text: "cards: 3 across at lg",
    title: "Objects page card layout",
    type: "enhancement",
    repo: "emergent-company/emergent.memory",
    selector: ".grid",
    url: "http://app.test/objects/c8e2/wiki?view=article",
    page: "/objects/c8e2/wiki?view=article",
    sent_at: "2026-11-12T20:30:00.000Z",
    context: { intent: { action: "change" } },
    ...overrides,
  };
}

test("pagePath keeps the path and query, drops the host", () => {
  assert.equal(
    pagePath("http://memory-home.tail0358fa.ts.net:8097/objects/c8e2/wiki?view=article#x"),
    "/objects/c8e2/wiki?view=article"
  );
  assert.equal(pagePath("http://app.test/"), "/");
  assert.equal(pagePath("not a url"), "not a url");
});

test("buildOrderPayload carries the message, the page and the capture", () => {
  const out = buildOrderPayload({
    text: "  cards: 3 across at lg  ",
    title: " Objects page card layout ",
    type: "enhancement",
    repo: "emergent-company/emergent.memory",
    selector: ".grid",
    url: "http://app.test/objects?page=2",
    context: { intent: { action: "change", changes: [] } },
    screenshot: "data:image/png;base64,AAAA",
    now: new Date("2026-11-12T20:30:00.000Z"),
  });

  assert.equal(out.text, "cards: 3 across at lg");
  assert.equal(out.title, "Objects page card layout");
  assert.equal(out.page, "/objects?page=2");
  assert.equal(out.sent_at, "2026-11-12T20:30:00.000Z");
  assert.equal(out.screenshot, "data:image/png;base64,AAAA");
  assert.deepEqual(out.context, { intent: { action: "change", changes: [] } });
});

test("buildOrderPayload omits an absent screenshot rather than sending null", () => {
  const out = buildOrderPayload({
    text: "x",
    title: "",
    type: "bug",
    repo: "r",
    selector: "s",
    url: "http://app.test/a",
    context: {},
    now: new Date(0),
  });
  assert.equal("screenshot" in out, false);
});

test("buildOrderPayload reports why a screenshot is missing", () => {
  const out = buildOrderPayload({
    text: "x",
    title: "",
    type: "bug",
    repo: "r",
    selector: "s",
    url: "http://app.test/a",
    context: {},
    screenshotError: "Unable to find element in cloned iframe",
    now: new Date(0),
  });
  assert.equal("screenshot" in out, false);
  assert.equal(out.screenshot_error, "Unable to find element in cloned iframe");
});

test("a capture that succeeded carries no error", () => {
  const out = buildOrderPayload({
    text: "x",
    title: "",
    type: "bug",
    repo: "r",
    selector: "s",
    url: "http://app.test/a",
    context: {},
    screenshot: "data:image/png;base64,AAAA",
    screenshotError: "stale reason from a retry",
    now: new Date(0),
  });
  assert.equal(out.screenshot, "data:image/png;base64,AAAA");
  assert.equal("screenshot_error" in out, false);
});

test("orderEndpoint targets the session's order route", () => {
  assert.equal(
    orderEndpoint("http://box.test:8101/", SESSION),
    `http://box.test:8101/o/${SESSION}/order`
  );
  assert.equal(
    orderEndpoint("http://box.test:8101", SESSION),
    `http://box.test:8101/o/${SESSION}/order`
  );
});

test("orderConfigValid requires both halves and a full UUID", () => {
  assert.equal(orderConfigValid("http://box.test", SESSION), true);
  assert.equal(orderConfigValid(undefined, SESSION), false);
  assert.equal(orderConfigValid("http://box.test", undefined), false);
  assert.equal(orderConfigValid("http://box.test", "13e9fff6"), false);
  assert.equal(
    orderConfigValid("http://box.test", "13E9FFF6-dff0-4ec9-bcef-26aa2cb7ba28"),
    false
  );
});

test("sendOrder posts JSON with credentials and returns the delivery time", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ delivered: true, at: "20:31:04", screenshot: "/tmp/x.png" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const got = await sendOrder("http://box.test:8101/", SESSION, undefined, payload(), {
    fetch: fakeFetch,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `http://box.test:8101/o/${SESSION}/order`);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "include");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal("Authorization" in headers, false);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), payload());
  assert.deepEqual(got, { at: "20:31:04", screenshot: "/tmp/x.png" });
});

test("sendOrder sends the configured token as a bearer header", async () => {
  let headers: Record<string, string> = {};
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ delivered: true, at: "20:31:04" }), { status: 200 });
  }) as unknown as typeof fetch;

  await sendOrder("http://box.test", SESSION, "secret-token", payload(), { fetch: fakeFetch });
  assert.equal(headers["Authorization"], "Bearer secret-token");
});

test("sendOrder surfaces a refused token with the one action that fixes it", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: "missing or invalid token" }), { status: 401 })) as unknown as typeof fetch;

  await assert.rejects(
    () => sendOrder("http://box.test:8101", SESSION, undefined, payload(), { fetch: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof OrderError);
      assert.equal(err.status, 401);
      assert.match(err.message, /open http:\/\/box\.test:8101\/o\//);
      return true;
    }
  );
});

test("sendOrder surfaces the box's own error text", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: "Agent not found" }), { status: 502 })) as unknown as typeof fetch;

  await assert.rejects(
    () => sendOrder("http://box.test", SESSION, undefined, payload(), { fetch: fakeFetch }),
    (err: unknown) => {
      assert.ok(err instanceof OrderError);
      assert.equal(err.status, 502);
      assert.match(err.message, /Agent not found/);
      return true;
    }
  );
});
