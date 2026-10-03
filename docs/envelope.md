# Feedback Envelope — Implementation Reference

Precise reference for the **shipped** AI-first feedback system (Phases A–C). Every
field, route, flag, and tool below is read from the current code. The canonical
JSON Schema lives at [`docs/schema/envelope.v1.json`](schema/envelope.v1.json) and
is served publicly at `GET /schema/envelope.v1.json` (embedded via `go:embed`).

---

## 1. The envelope JSON

The envelope is built server-side by `BuildEnvelope` (`server/handler/envelope.go`)
from a persisted `feedback` row (`server/store/feedback.go`) and its `context_json`.
It degrades gracefully: any section whose source data is absent is **omitted**,
not emitted as `null`.

Top-level shape (order as emitted):

| Key | Type | Notes |
|---|---|---|
| `schema` | string | `https://feedback.emergent-company.ai/schema/envelope.v1.json` |
| `version` | string | `1.0.0` |
| `id` | integer | feedback row id |
| `created_at` | string | RFC3339 |
| `status` | string | persisted lifecycle status (§3) |
| `type` | string | `bug` \| `enhancement` \| `question` \| `task` |
| `summary` | string | explicit `context.summary` → heuristic (§8) → truncated comment |
| `actor` | object | `{ "github_user": string }` |
| `target` | object | see below |
| `intent` | object | omitted if absent |
| `explanation` | object | omitted if empty |
| `repro` | object | omitted if empty |
| `environment` | object | omitted if empty |
| `visual` | object | omitted if no screenshot/snapshot (`replay_ref` is Phase C — PR #8) |
| `verification` | object | omitted if absent |
| `applied_at` / `verified_at` / `resolved_at` | string | RFC3339, only when recorded |
| `dedupe` | object | omitted unless a dedupe key exists |
| `provenance` | object | per-field provenance map (§2) |
| `trust_order` | array | the fixed evidence-trust ranking (§2) |

`target`:

- `element`: `{ tag, role?, label?, selector, data_component?, fingerprint? }`
  - `fingerprint`: `{ attrs, path, text? }` (client stamp, or a legacy fallback built
    from captured `attributes` + `innerText`)
- `region` / `selection`: passed through from context when present
- `source`: `{ component?, file?, line?, column?, framework?, resolution, confidence }`

`intent`: `{ kind, action, expected?, actual?, scope: { breadth, targets[] } }`

`explanation`: `{ text, quality?, quality_score? }`

`repro`: `{ steps?, console?, network?, session_history? }` — `replay?` is
Phase C (PR #8), not present in this PR.

`environment`: `{ url, viewport?, device_pixel_ratio?, user_agent?, framework?,
css_framework?, branch?, version?, session_id?, trace_id? }`

`visual`: `{ screenshot_ref?, snapshot_ref? }` — refs are
`feedback://{id}/screenshot|snapshot`. `replay_ref` is Phase C (PR #8), not
available in this PR.

`verification`: `{ contract?, criteria?, result?, detail? }` — `contract`/`criteria`
come from `context.verification`; `result`/`detail` are the persisted
`verification_result`/`verification_detail` (the last recorded outcome).

`dedupe`: `{ key, duplicate_of?, possible_duplicates[] }`.

### Concise variant

`feedback_get` defaults to a **concise** envelope (`BuildConciseEnvelope`), which
keeps only: `schema`, `version`, `id`, `status`, `type`, `summary`,
`target.{element{tag,label,selector,data_component}, source}`, `intent`,
`verification`, `trust_order`, `provenance`. It drops DOM dumps, styles,
snapshot/replay refs, session history, console/network, explanation, environment,
actor, `created_at`, lifecycle timestamps, and `dedupe`.

---

## 2. Provenance + trust order

`provenance` is a `Record<string, Provenance>` keyed by the `trust_order` keys.
The enum is the honesty contract:

| Value | Meaning |
|---|---|
| `captured` | machine-stamped at capture time (selector, fingerprint, computed styles, source when `confidence != none`, screenshot when taken) |
| `inferred` | derived by the AI/server (e.g. `summary`, `environment.css_framework`) |
| `stated` | the human stated it (e.g. `intent.expected`) |
| `absent` | no evidence for that field |

`trust_order` (fixed, `server/handler/envelope.go` + `client/src/envelope.ts`):

```
target.source → target.element.fingerprint → intent.expected → intent.actual →
target.element.selector → visual.screenshot_ref → target.element.computed_styles →
environment.css_framework → summary
```

An agent resolving a field conflict reads most→least trusted. Source location beats
selector; human intent beats both on **what** to build but loses on **where** it is.

---

## 3. Lifecycle statuses + transitions

Statuses (`server/store/feedback.go`): `open | applied | verified | resolved | exported`.

| Transition | How | Event |
|---|---|---|
| create | `POST /feedback` → `Create` | `created` |
| export | `POST /issue/export` → `MarkExported` (sets `issue_url` + `exported`) | *(none)* |
| mark applied | `POST /feedback/:id/applied` / `feedback_mark_applied` → `SetStatus(applied)` | `applied` (+ `applied_at`) |
| verify green | `POST /feedback/:id/verify-result` (result `green`) → `SetVerificationResult` + `SetStatus(verified)` | `verified` (+ `verified_at`, `verification_result/detail`) |
| resolve | `POST /feedback/:id/resolve` / `feedback_mark_resolved` → `SetStatus(resolved)` | `resolved` (+ `resolved_at`) |
| duplicate | `Create` when a matching open/applied item shares the dedupe key | `duplicate` |

`feedback_events` rows (migration 5): `seq` (monotonic, for replay),
`feedback_id`, `type` (`created|duplicate|applied|verified|resolved|open`),
`actor`, `detail`, `created_at`.

> Note: `exported` was added in Phase C to decouple "exported to a GitHub issue"
> from "genuinely resolved". `MarkExported` no longer sets `resolved`. Envelope
> `status` reads the **persisted** status verbatim and never infers
> `applied/verified/resolved` from `issue_url`.

Notes:

- `verified_at` is set only on a `green` result; `amber`/`red` record
  `verification_result`/`verification_detail` without touching `verified_at`.
- `DELETE /feedback/:id` cascades: it also deletes the item's `feedback_events`
  rows.

---

## 4. Element → source resolution

`client/src/source.ts` resolves a clicked element to a source ref via a
most→least reliable ladder, **never fabricating a file/line**:

| Tier | Signal | `resolution` | `confidence` |
|---|---|---|---|
| 1 | `data-fo-src="file:line:col"` (build plugin) | `build-stamp` | `exact` |
| 2 | React fiber `_debugSource` (dev) | `fiber` | `exact` |
| 3 | React fiber component name | `fiber` | `approximate` |
| 4 | Vue `__vueParentComponent.type.__file` | `framework-meta` | `approximate` |
| 5 | Svelte `__svelte_ctx` / `__svelte_dev` | `framework-meta` | `approximate` |
| 6 | `data-inspector-*` / `data-v-inspector` / `data-astro-source-file` | `dev-stamp` | `approximate` |
| 7 | `data-component` name (no location) | `none` | `none` |

`confidence`: `exact` only for a build stamp or dev `_debugSource`; `approximate`
for component-name / framework-meta / dev-stamp; `none` when only a component name
exists. An un-instrumented prod page still yields `{ resolution: "none",
confidence: "none" }` — the envelope is correct at every tier, only precision varies.

### Build-plugin stamping (in-repo)

The tier-1 stamp is produced by [`plugins/vite-plugin-emergent-feedback/`](../plugins/vite-plugin-emergent-feedback/README.md),
shipped in this repo. It parses **JSX/TSX** at build time and injects
`data-fo-src="<repo-relative-path>:<line>:<column>"` (path repo-relative, no leading
slash; line/column 1-based) onto every identifiable DOM element.

- **Supported:** React JSX/TSX (`.jsx`/`.tsx`) — and any dialect Babel's `jsx`
  plugin accepts (Preact, Solid).
- **Unsupported (v0.1):** Vue `.vue` SFC and Svelte — use a framework inspector
  (`vite-plugin-vue-inspector`, etc.) or wait for a future release.
- **Usage:** `plugins: [emergentFeedback()]` in `vite.config.ts`. Optional
  `componentAttribute: true` also stamps `data-fo-component` with the nearest
  component name.

### Console stack unmapping

> **Phase C (PR #8) — not available in this PR.**

Console entries carry `stack?: {path,line,column}[]` (parsed frames) plus a
`stack_text?: string` (redacted raw trace for humans). The server
(`server/handler/sourcemap.go`) unmaps the `stack` frames against uploaded source
maps (`POST /sourcemaps`, keyed `(repo, appVersion, basename)`) using
`github.com/go-sourcemap/sourcemap`, writing the result to `unmapped_stack`.
When unmapping fails, absolute **filesystem** paths are shortened to their last 3
segments (both in the frames and in `stack_text`) so build paths never leak;
relative paths, URLs, and virtual (`webpack://`) paths are left unchanged.

---

## 5. Verification contract

Contract kinds (`client/src/envelope.ts`, `client/src/verify.ts`):

| Kind | `check` fields | Evaluation |
|---|---|---|
| `style_assertion` | `{selector, prop, before, operator}` | `equals`/`not_equals`/`present` → `green` when the live value matches (else `red`); `changed` → `amber` on a change (cannot verify direction), `red` when unchanged; unknown operator / missing `selector`/`prop`/`before` → `amber` |
| `anchor_stable` | `{selector, path}` | element found → `amber` (anchored, but mere presence/tag-match cannot confirm the fix — needs human/agent); missing → `red`; never `green` |
| `test_exists` | — | treated as `amber` ("needs human") client-side |
| `human` | — | always `amber` ("needs human confirmation") |

`green` = contract passes via a genuine machine check (auto-verified) · `amber` =
cannot auto-verify / needs human or agent confirmation · `red` = contract fails.
Only a real check (a `style_assertion` with `equals`/`not_equals`/`present`) may
produce `green`; `anchor_stable`, `human`, `test_exists`, and `changed` can only
yield `amber`/`red` and never a false green.

**Who evaluates:** the page-side client polls `GET /feedback/verify-pending`
(`client/src/verify.ts`, every ~15s while the overlay is active and authenticated),
evaluates `style_assertion`/`anchor_stable` against the live DOM, and posts
conclusive results back to `POST /feedback/:id/verify-result`. `amber` results are
**not posted** — they neither verify nor fail the item, so the loop skips them and
waits for a human (or the MCP agent) to act. `anchor_stable` resolves to `amber`
(anchored, awaiting confirmation) or `red` (missing), never `green`; only a genuine
machine check (`style_assertion` `equals`/`not_equals`/`present`) can produce the
`green` that flips status to `verified`.

---

## 6. MCP tools

All tools are repo-scoped via API-key `scopes` (DB keys) or a `*` bootstrap key.
Per-item tools (`feedback_get`, `feedback_get_snapshot/screenshot/context`,
`feedback_verify`, `feedback_mark_applied`, `feedback_mark_resolved`) operate on
**repo-scoped items regardless of export state** — freshly-created (`open`) items
are readable/verifiable/markable. `feedback_list` lists items across **all
lifecycle statuses** (`open|applied|verified|resolved|exported` — its store query
no longer filters `issue_url != ''`), and handles `*` with an all-repos query.
(`feedback_get_replay` is Phase C — PR #8, not in this PR.)

| Tool | Input | Output |
|---|---|---|
| `feedback_list` | `{ repo?, status?, type?, since? (RFC3339) }` | `[{ id, summary, type, status, source_confidence, issue_url }]`, sorted by `source_confidence` desc (exact first) |
| `feedback_get` | `{ feedback_id, response_format? = "concise" \| "detailed" }` | envelope (concise or full) |
| `feedback_verify` | `{ feedback_id }` | `{ status, contract, last_result, last_detail }` (+ text instruction when the contract is `human`) |
| `feedback_mark_applied` | `{ feedback_id, summary? }` | `{ id, status: "applied" }` |
| `feedback_mark_resolved` | `{ feedback_id, summary? }` | `{ id, status: "resolved" }` |
| `feedback_watch` | `{ since_seq?, wait_seconds? (cap 25) }` | `{ events: [{seq, feedback_id, type, actor, detail, created_at}], next_seq }` — long-poll |
| `feedback_get_replay` | `{ feedback_id }` | `{ events }` (decompressed rrweb JSON) — **Phase C (PR #8), not in this PR** |
| `feedback_get_snapshot` | `{ feedback_id }` | `{ html }` |
| `feedback_get_screenshot` | `{ feedback_id }` | `{ image_base64, media_type }` |
| `feedback_get_context` | `{ feedback_id }` | `{ context }` |
| `feedback_list_for_issue` | `{ issue_number }` | `{ issue_number, feedback: [{id, selector, url, comment, has_screenshot, has_snapshot}] }` |

`feedback_get` is the primary context bundle; `feedback_get_snapshot/screenshot/
context` are thin fetch tools. Server: `emergent-feedback` v1.0.0, streamable HTTP.

---

## 7. REST endpoints

Public (no auth):

- `GET /feedback?url=` → per-selector badge counts `[{selector, count, ids}]`
- `GET /issues?url=` → open GitHub issue badges
- `GET /schema/envelope.v1.json` → the JSON Schema
- `GET /health`, `GET /`, `GET /panel`, `GET /auth/github`, `GET /auth/callback`,
  `GET /emergent-feedback.js`, `GET /static/*`

Authenticated (Bearer JWT, owner-scoped where noted):

- `POST /feedback` → create (owner = caller). Body: `{url, selector, comment, context,
  repo, label, feedbackType?, screenshot?, snapshot?}` (`replay?` is Phase C — PR #8).
- `GET /feedback/list?url=` → full comment details for open items on a page
- `GET /feedback/:id` → single item (owner-only)
- `DELETE /feedback/:id` → delete (owner-only)
- `POST /feedback/:id/applied` body `{summary?}` → `SetStatus(applied)` + best-effort
  GitHub comment
- `POST /feedback/:id/resolve` body `{summary?}` → `SetStatus(resolved)` + comment +
  close GitHub issue
- `POST /feedback/:id/verify-result` body `{result: green|amber|red, detail?}` →
  record result; `green` also sets `verified` (+ `verified_at`). `amber`/`red`
  record `verification_result`/`detail` but leave `verified_at` untouched.
- `GET /feedback/:id/verify` → `{id, status, contract?, criteria?, last_result, last_detail}`
- `GET /feedback/verify-pending?url=` → `[{id, selector, contract}]`
- `GET /feedback/status?url=` → caller's own items `[{id, selector, status, issue_url}]`
- `GET /feedback/:id/replay` → decompressed rrweb events JSON (owner-only; 413 if
  decompressed > 20MB) — **Phase C (PR #8), not in this PR**
- `POST /issue/export` body `{ids, repo, labels?, title?}` → `{issue_url, issue_number}`
- `POST /sourcemaps` body `{repo, version?, maps: {"<path>": "<sourcemap JSON>"}}` →
  `{stored}` (413 > ~20MB). Fails **closed** (403) when the caller's repo scope
  cannot be determined. — **Phase C (PR #8), not in this PR**
- `GET /api/reports`, `GET /api/reports/:id` → exported reports (repo-scoped)
- `GET /api/repos`, `GET/POST/DELETE /api/keys(/:id)`, `GET /me`

`POST /feedback` and `POST /issue/export` are rate-limited per client IP
(`RATE_LIMIT_RPS`/`EXPORT_RATE_LIMIT_RPS`, defaults 10/1).

---

## 8. Auto-title (summary)

`deriveSummary` is deterministic: explicit `context.summary` → heuristic → truncated
comment. The heuristic (`server/handler/autotitle.go`) builds
`"<Verb> <expected> on <Label>"` from `intent.action` + element `label`/`data_component`.

> **Phase C (PR #8) — LLM auto-title is not available in this PR.**

Optional LLM (isolated in `autotitle.go`, **never blocks a request path**): when
`FEEDBACK_LLM_BASE_URL` + `FEEDBACK_LLM_API_KEY` are set (optional
`FEEDBACK_LLM_MODEL`), `POST {base}/chat/completions` produces a title with a 2s
timeout; on any error/timeout it falls back to the heuristic. The result is
persisted **asynchronously** into `context_json.summary` after create.

The comment is passed through `redactSecrets` before it reaches the summary
fallback, the LLM prompt, the issue body, and `explanation.text` (see §12).

---

## 9. Client configuration

Read from the `<script>` tag (`client/src/config.ts`):

| Attribute | Meaning | Default |
|---|---|---|
| `data-api` | API base URL | `https://feedback.emergent-company.ai` |
| `data-repo` | `owner/repo` | *(required)* |
| `data-label` | GitHub issue label | `feedback` |
| `data-hotkey` | `alt+shift` \| `ctrl+shift` \| `meta+shift` | `alt+shift` |
| `data-branch` | Git branch | — |
| `data-version` | App version (→ `context.appVersion`) | — |
| `data-session-id` | server-injected session ID | — |
| `data-session-id-selector` | CSS selector to read a trace ID from the DOM | — |
| `data-replay` | presence enables replay; `"false"` disables — **Phase C (PR #8), not in this PR** | off |
| `data-replay-buffer-ms` | replay buffer window — **Phase C (PR #8)** | `60000` |
| `data-replay-src` | explicit URL for the lazy replay bundle (else derived from the main bundle URL) — **Phase C (PR #8)** | — |

Authentication is GitHub OAuth (popup → `POST /auth/callback`); there is **no**
`data-token` attribute — the JWT is stored in `localStorage["__ef_token__"]`.

---

## 10. Replay

> **Phase C (PR #8) — session replay is not available in this PR.**

Opt-in (`data-replay`), rrweb, **lazily loaded** in a second bundle:

- The main bundle (`emergent-feedback.js`, ~269 KB) imports a thin loader
  (`client/src/replay.ts`) that, when replay is enabled, injects a `<script>` for
  the **separate replay bundle** (`emergent-feedback-replay.js`, ~179 KB) and
  delegates to `window.__EF_REPLAY__`. rrweb is only fetched/executed when replay
  is on.
- Sliding buffer, **~60s** (default), max 5000 events; full snapshot every 30s.
- Masking on by default: `maskAllInputs`, `password`/`email`/`tel`, `[data-fo-redact]`
  text masked, `.fo-block` subtrees excluded, no canvas, no cross-origin iframes.
- Payload on submit: `base64(gzip(JSON events))` (falls back to plain base64 when
  `CompressionStream` is unavailable).
- Server stores it in the `feedback.replay` BLOB (gzip), serves it decompressed at
  `GET /feedback/:id/replay`; upload guard rejects > ~5MB decoded (413) and
  decompression is capped at 20MB (413).
- Envelope exposes `visual.replay_ref = feedback://{id}/replay` when present, and
  `repro.replay` is populated as `feedback://{id}/replay` (a `feedback://` ref)
  when a replay blob exists.

---

## 11. Dedupe (heuristic)

On create the server computes `dedupe_key = sha256(repo + selector + normalized
page URL + fingerprint.path + normalized comment)` (URL stripped of query/fragment;
comment lowercased + whitespace-collapsed). If an existing `open`/`applied` item
in the same repo shares the key, the new item's `duplicate_of` is set to that id
and a `duplicate` event is emitted. Envelope exposes
`dedupe: {key, duplicate_of?, possible_duplicates[]}`. Heuristic only — fingerprint
equality ≠ bug equality; items are never auto-merged.

---

## 12. Security & redaction

- `redactSecrets` (`server/handler/redact.go`) scrubs token values, sensitive
  assignments, and URL query params from the comment before it reaches the issue
  body, `explanation.text`, the summary fallback, and (in Phase C — PR #8) the LLM
  auto-title prompt.
- Source-map upload (`POST /sourcemaps`) **fails closed** — 403 if the caller's
  repo scope cannot be determined (no silent allow-any-repo) — **Phase C (PR #8)**.
- Replay: upload capped at ~5MB decoded (413); decompression capped at 20MB (413)
  to prevent zip-bomb decompression — **Phase C (PR #8)**.
- Console stack frames and `stack_text` have absolute filesystem paths shortened
  to their last 3 segments when source-map unmapping fails (§4) — **Phase C (PR #8)**.
- Deleting feedback cascades its `feedback_events`.
