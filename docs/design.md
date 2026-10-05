# emergent.feedback — Context Enrichment Design

Status: **v1 + v2 + v3 + P1 implemented**. P2 (panel UI) pending.
**v4 (host-provided metadata) designed, not implemented.**

## Goal

Give the agent that triages a GitHub issue full, correlated context:

1. **Which session** produced the feedback (overlay-minted session ID).
2. **The app's own trace ID**, so the agent can cross-reference the app's logs / Sentry / OTel.
3. **A screenshot** of the element (v1) and later a **full redacted DOM snapshot** (v2).
4. **Programmatic access** for the agent via an **MCP server** (v3).

## Current capture (baseline)

`client/src/index.ts#gatherContext` attaches to every feedback item:

`url`, `viewport`, `devicePixelRatio`, `tagName`, `dataComponent`, `outerHTML`
(truncated 4000), `innerText` (200), `attributes`, `cssFramework`,
`computedStyles`, `boundingRect`, `userAgent`, `timestamp`, `branch`,
`appVersion`, `sessionHistory` (15-event ring buffer).

Stored as `context_json` in SQLite, rendered inline into the GitHub issue body
on export. The `screenshot` column already exists end-to-end (schema, store,
handler) but the client never sends it — dead path.

---

## v1 — Correlation IDs + element screenshot

### Overlay session ID

- Mint a UUID on first load, persist in `sessionStorage` under
  `__ef_session_id__`. Falls back to ephemeral random ID if `sessionStorage`
  or `crypto.randomUUID` is unavailable.
- Attach as `context.sessionId`.
- Purpose: group all feedback items produced by one browser session, so the
  agent can tell "these three comments came from the same visit".

### App trace ID

The overlay cannot guess the app's correlation ID — the app must expose it.
Supported sources, resolved in priority order:

1. `data-session-id` — static ID injected server-side into the script tag.
2. `data-session-id-selector` — CSS selector; read `textContent` of first match.
3. `window.__feedbackSessionId` — a string, or a `() => string` function.

Attach as `context.traceId`. The agent correlates this against the app's own
observability (Sentry `lastEventId`, OTel `traceparent`, backend request ID).
The value is only as real as the app's willingness to expose it; one script
attribute is enough, do not auto-detect telemetry internals.

```html
<script
  src="https://feedback.emergent-company.ai/emergent-feedback.js"
  data-repo="org/repo"
  data-session-id="b8f3…"
  data-session-id-selector="#trace-id"
  async
></script>
```

### Element screenshot

- `html2canvas`, scoped to the clicked element (not full page), best-effort.
- Attach as `screenshot` (base64 PNG data URL) on `POST /feedback`. Server
  already decodes and stores it — no server change.
- On capture failure (cross-origin image taint, `display:contents`, etc.),
  silently omit the screenshot.

Caveat: `html2canvas` approximates rendering; cross-origin images may blank
regions. This is a best-effort aid, not pixel-truth.

---

## v2 — Full DOM snapshot

Do **not** put full HTML in the issue (noise, PII, bloat). Store server-side;
retrieve via MCP.

### Capture

On submit, capture `document.documentElement.outerHTML`, run the redaction
pass, gzip, store as a BLOB keyed to the feedback item.

### Redaction rules (mandatory)

Full-page HTML leaks user data. Strip before storing:

- `<input>`, `<textarea>`, `<select>` values.
- `contenteditable` text.
- `<script>` and `<style>` bodies (huge + may contain secrets).
- Attributes matching token/secret signals: `data-key`, `data-token`,
  `data-secret`, `accesskey`, `autocomplete`, and any `data-*` value that
  looks like a credential.
- Query-string params with token-like keys in `src`/`href`.
- `localStorage` values are **never** captured — keys only if ever needed.

Cap gzipped size (~500 KB).

### Retrieval (no secret in the issue)

The snapshot is **never** referenced from the issue body — no secret, no
pointer. Retrieval is authenticated by a **per-user API key**, scoped to one
or more repos:

- Key stored **hashed** (`sha256`) in `api_keys`; repo scope in
  `api_key_repos`.
- MCP tools authenticate via `Authorization: Bearer <key>`; the server checks
  the feedback item's repo is within the key's scope.
- `MCP_API_KEY` env remains as a bootstrap wildcard (`*`) fallback.

Snapshot/screenshot/context are served only for **exported** feedback
(`issue_url` set), scoped to the key's repos.

### Backlink

`github_issues` currently stores `issue_number / selector / page_url / repo`
but no feedback IDs, so issue→snapshot lookup is loose (selector + URL match).
Add `github_issues.feedback_ids` (JSON array) for exact resolution.

---

## v3 — MCP server

Add a streamable-HTTP MCP endpoint (`/mcp`) to the existing Echo server —
same binary, same auth surface.

### Tools

```
feedback_get_context(feedback_id)    → full context JSON
feedback_get_screenshot(feedback_id) → base64 PNG
feedback_get_snapshot(feedback_id)   → redacted full DOM snapshot
feedback_list_for_issue(issue_number) → resolve issue → feedback IDs
```

### Auth

MCP clients present `Authorization: Bearer <api-key>` — a DB-backed key scoped
to repos, or the `MCP_API_KEY` bootstrap. The server verifies the key and
checks each tool call's repo is within scope. No secret is ever embedded in an
issue.

---

## v4 — Host-provided metadata (`<meta name="ef:*">`)

Status: **designed, not implemented.**

### Goal

Let the host app attach arbitrary product metadata — environment, tenant,
plan, feature flags, route/feature name, correlation IDs — that travels with
every feedback item and is rendered alongside the auto-captured context.

Today the host can only contribute three fields: `data-branch`,
`data-version`, `data-session-id` (`client/src/config.ts`). Everything else is
auto-captured DOM/browser data. Adding more `data-*` attributes scales badly
because each new field needs client code. Instead, expose **one generic
channel**: document `<head>` meta tags under the `ef:` namespace.

### Channel (decided)

Only `<meta name="ef:*">` tags. No JS setter API, no `data-context` JSON bag in
v4. Rationale: meta tags work for SSR/server-rendered apps with zero client
wiring, are readable by the overlay at submit time, and need no new JS public
surface. A runtime setter (`window.feedbackOverlay.setContext`) is explicitly
deferred to a later version if SPA-dynamic metadata proves necessary.

Legacy `data-branch` / `data-version` / `data-session-id` are **unchanged** and
keep populating their existing top-level context keys. Meta tags are additive;
they do not override or replace them.

### Syntax

```html
<head>
  <!-- flat key -->
  <meta name="ef:env" content="staging">
  <!-- dotted key → nested object -->
  <meta name="ef:tenant.id" content="acme">
  <meta name="ef:feature.area" content="billing">
</head>
```

- Name must start with `ef:` (case-insensitive prefix; keys normalised to
  lower-case).
- The remainder is a dot path. Each segment must match `[a-z0-9_-]+`.
  Max **3 segments** (depth), deeper paths rejected.
- Value = trimmed `content` attribute. Empty content skipped.
- Collection happens in `gatherContext` (`client/src/index.ts`) by scanning
  `document.head` at submit time, so meta tags injected by client JS before
  submit are picked up as well as SSR-rendered ones.

### Context shape

All meta tags merge into one reserved object, `context.app`:

```json
{
  "url": "…",
  "viewport": { "width": 1440, "height": 900 },
  "sessionHistory": [ … ],
  "app": {
    "env": "staging",
    "tenant": { "id": "acme" },
    "feature": { "area": "billing" }
  }
}
```

`context.app` is reserved and never written by auto-capture. Legacy `branch` /
`appVersion` stay at the top level; renderers show `context.app` and the legacy
fields in one "App metadata" block.

### Recommended key catalog

Not enforced — the namespace is free-form — but these are the keys worth
capturing, grouped for documentation:

| Group | Example keys |
|---|---|
| Build / deploy | `env`, `commit`, `build`, `deploy.id`, `region`, `release` |
| App | `product`, `framework`, `framework.version`, `locale`, `timezone`, `theme` |
| Tenant / identity | `tenant.id`, `workspace.id`, `user.id`, `plan`, `role`, `flags.*` |
| Routing | `route`, `route.params`, `feature.area` |
| Correlation | `request.id`, `backend.trace.id` |

### Guardrails (mandatory)

Reuse the redaction signals already in `client/src/snapshot.ts`.

- **Sensitive keys/values dropped.** Apply `SENSITIVE_ATTR` (token/secret/
  password/apikey/authorization/jwt/csrf/cookie/sessionid…) to the full dotted
  key, and `TOKEN_VALUE` to the value. A match means the whole tag is dropped
  (not redacted) so it never reaches storage or the issue.
- **PII deny-list.** Keys matching `email|phone|ssn|dob|address|ip` are dropped
  by default. The app is responsible for what it emits; the overlay refuses the
  obvious offenders.
- **Size caps.** Per-value ≤ 500 chars; ≤ 50 keys total; ≤ 4 KB serialised.
  Exceeding a cap drops the offending tag (per-value) or the whole `context.app`
  (global caps) with a `console.warn`. Never fail the submit.
- **No interpretation.** Values are treated as opaque text and rendered through
  the existing `escapeHtml` path — never injected as HTML.

### Rendering call sites

No storage change: metadata rides in `context_json` under `context.app`.

| Surface | Change |
|---|---|
| `client/src/index.ts` `gatherContext` | read `ef:*` meta tags, build `context.app` |
| `client/src/config.ts` | unchanged (no new script attribute) |
| `client/src/dialog.ts` (~L490 meta rows) | "App metadata" group in the context grid |
| `server/handler/issue.go` `buildIssueContent` | "App metadata" block in the issue body |
| `server/panel/panel.templ` `contextSection` | rows for `context.app` |
| MCP `feedback_get_context` | unchanged — raw JSON already includes `context.app` |

### Non-goals

- No JS runtime setter / `window.feedbackOverlay.setContext` in v4.
- No typed schema or per-key validation beyond name syntax and caps.
- No auto-detection of framework/telemetry internals (only explicit tags).
- No path-level override or precedence machinery — meta tags only append.

### Acceptance criteria

1. `<meta name="ef:env">` and `<meta name="ef:tenant.id">` appear as
   `context.app.env` and `context.app.tenant.id` on a submitted item.
2. Malformed names (`ef:` empty, uppercase path, >3 segments, illegal chars)
   are ignored without error.
3. `ef:api.key`, `ef:user.email`, and a value that matches `TOKEN_VALUE` are
   dropped and never appear in `context_json` or the issue body.
4. Over-cap input is dropped with a console warning; submit still succeeds.
5. Legacy `data-branch` / `data-version` behaviour is byte-for-byte unchanged.
6. Metadata renders in the dialog, the GitHub issue body, and the panel preview.

---

## Schema (future migrations)

| Version | Change |
|---|---|
| v1 | none — new fields ride in `context_json`; `screenshot` column already exists |
| v2 | `feedback` + `snapshot BLOB`, `snapshot_size INT`; `github_issues` + `feedback_ids TEXT` (`snapshot_secret` legacy column, unused) |
| v3 | `api_keys` + `api_key_repos` — per-user repo-scoped API keys |
| v4 | none — host metadata rides in `context_json` under reserved `context.app` key |

---

## Security & PII rules (standing)

- Never capture `localStorage` values.
- Redact sensitive input values (already done in `history.ts`; extend to snapshot).
- Host metadata (`ef:*` tags) is filtered through the same sensitive-key/value
  and PII deny-lists before attach; over-cap input is dropped, never truncated mid-value.
- API keys stored hashed only; repo-scoped; never embedded in issues.
- Snapshot/screenshot/context served only for exported feedback, within the key's repo scope.

## Remaining

- **P2**: user panel (`/panel`) for managing API keys — list user's repos
  (GitHub OAuth), generate/rotate/revoke repo-scoped keys.
- Snapshot storage: SQLite BLOB is fine to start; S3 when volume grows.
- Whether `traceId` should also be sent as a GitHub issue label/tag for
  grouping (likely noise — keep it in context only).
