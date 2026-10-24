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

## Live style editing (v5, implemented)

Clicking an element opens the **issue submission modal** first — the former
"Send to GitHub" step is gone. The reporter fills the comment, title, type and
intent, then **Create issue** or **Save**. **Edit element** (header or footer)
swaps to the style editor, which the reporter can dock to the side of the page
(non-modal, page undimmed and interactive) or keep centered, to restyle one or
more selected elements by choosing tokens from a project-provided theme. The
editor shows only the **Design** editor — the former Design/Issues tabs are gone;
the report form and the captured context/HTML live in the issue submission modal
instead. Tokens cover the common Tailwind and daisyUI utilities —
spacing (padding/margin/gap), layout (max-width, width/height, display, flex),
typography (text size, font weight), colors, borders/effects and daisyUI
button/badge modifiers — organised into collapsible sections. Each group renders
as a horizontal property row (label left, control right). Every built-in group
renders as a **dropdown** (color groups carry a swatch in the trigger and beside
each option), giving the editor one uniform control. `render` still accepts
`chips` or `icons` (an inline-SVG glyph row) for host manifests; the fallback set
opts into neither. Group ids must not collide with `position`, which is
reserved for recorded DOM moves (the CSS position tokens are grouped under
`positioning`). Every dropdown ends with a **Custom
class…** item (chip groups expose a **+ Custom** toggle) that reveals an inline
field for a free-typed class. Applied class/style edits are recorded per element
and rendered in the issue modal and panel.

**Applicability filtering.** Groups that cannot affect the selected element are
hidden: `gap` needs a flex/grid container with children, `align`/`justify` a
flex/grid container, `flexDir`/`wrap` a flex container, `self` a flex/grid
parent, `width`/`height`/`max-width`/`shadow` a box (or replaced element), the
text groups a text-bearing element, `objectFit` a replaced element, `inset` a
positioned element, and the daisyUI button/badge groups an element carrying the
`btn`/`badge` class. A group with an applied edit is always shown so it stays
revertable; a footer note reports how many settings are hidden and a **Show
all** toggle reveals them. On failure (no computed style, detached element, or a
style-read error) the editor shows everything rather than hiding settings by
mistake.

**View model.** Both surfaces live in one root (`#__ef_dialog__`) and swap via a
`data-view` attribute: `data-view="submit"` shows the issue modal,
`data-view="edit"` shows the style editor (`.ef-card`). Nothing inside either
surface is re-rendered on the swap, so typed text, chips and pending edits
survive the round trip. **Edit element** (`#__ef_edit_element__` in the header,
`#__ef_edit_element_foot__` in the footer) sets `edit`; **Back to issue**
(`#__ef_back_to_issue__`) sets `submit`. The editor's **Cancel**
(`#__ef_cancel__`) discards the whole report (draft + uncommitted edits); the
modal's **Cancel** (`#__ef_issue_cancel__`) does the same. `Escape` cancels the
report while the modal is up, and returns to the modal while the editor is up.
`#__ef_change_count__` in the modal header shows the attached style-change count.
The dock toggle (`#__ef_dock__`) applies to the editor only — the modal is
always centered.

Every group also carries a **Default** control — the leading chip in a chip row,
the leading item in a dropdown — which resets the group to the element's own
styling: the recorded edit (pending or committed) is reverted and dropped, so a
committed edit stops being replayed too. Clicking an already-active chip (or the
selected dropdown option) is the same action. `Default` differs from the `None`
tokens (`p-0`, `m-0`, `gap-0`), which apply an explicit zero value. A group whose
value comes from the host markup has no recorded edit, so Default is reported as
a no-op instead of stripping the page's class.

**Moving elements.** While editing, a selected element can be dragged anywhere on
the page — there is no separate move mode. The gesture only owns the pointer past
a 5 px threshold (below it, links, buttons and text fields inside the element
keep working, and the click that follows a drop is swallowed so it cannot also
toggle the selection). Dragging inside a container reorders siblings (the
insertion line follows the container's flex/grid axis); dragging over a
container's own padding/gap area appends into it, which is how an element is
reparented. Drops that would put an element inside itself (or its own subtree),
onto overlay chrome, or onto the page root are refused.

Each move is recorded per element as an anchor pair (`from` → `to`) rather than a
node reference, so it survives a page reload and is replayed on boot alongside
committed style edits; repeated moves of one element collapse into a single
record that keeps the original from-position. Moves join the same pending /
Commit / Committed-changes lifecycle as style edits (Default does not touch them —
they are undone with Remove or revert), and the editor's **Position** row shows
where the active element currently sits (`2nd of 3 in .toolbar`).

When more than one element is selected they are presented as **per-element tabs**
in the Design editor; the editor configures only the active element, so edits are
bounded to that component instead of applying globally. A scope hint notes when
a selection spans multiple targets.

Selection outlines are **hover-driven, not persistent**: selecting an element
leaves no box on the page, because a permanent outline sits on top of the very
border/background/shadow the reporter is judging. Hovering (or focusing) a
target label in the editor outlines that element — amber box plus the badge
number matching its tab — and a short **select flash** confirms which element a
click just bound the editor to. Hovering a selected element on the page outlines
it too and peeks its tab in the editor (reverse hover).

Edits start **pending** — applied live but reverted on Cancel/close. The
**Commit** button freezes pending edits and persists them (localStorage) across
sidebar close, reopen and page reload until explicitly removed from the global
**Committed changes** list (per-entry Remove + Remove all).

Docked mode reserves the rail width (document-root `margin-right`), so the host
page reflows alongside the editor instead of being overlaid; the hover highlight
is repainted after the reflow. Modal mode sizes the card to ~50 vw (capped at
900 px, min 480 px) and, when **Add element** is pressed, hides the dialog for the
click-to-pick and restores it when the pick completes (Escape cancels the pick).

### Data added to the payload

- `context.targets: SelectionTarget[]` — every selected element
  (`{ selector, tagName, dataComponent? }`). The primary target's full capture
  (`context.computedStyles`, `outerHTML`, fingerprint, …) is unchanged.
- `context.intent.changes: StyleChange[]` — applied edits across all targets,
  where `StyleChange = { target: string; group: string; before: string; after:
  string }` (`before`/`after` are token class names or style values; `before` may
  be empty). Even though editing is per element, the payload aggregates every
  target's changes and each record carries its `target` selector. Scope breadth
  becomes `multi` when more than one target is selected.
- A text edit is the same record with `group: "text"`: `{ target, group: "text",
  before, after }`. The editor only offers the field when the element has exactly
  one non-whitespace direct text child, so mixed inline markup (`Hello <b>world</b>`)
  is never collapsed. The change's DOM node index is tracked internally for
  replay/revert but is not part of the payload.
- A DOM move is the same record with `group: "position"` and a `move` field:
  `{ from, to }`, each anchor `{ container, before, index, label }` (`before:
  null` = last child; selectors, so a reload can replay). `before`/`after` carry
  the human position text (`2nd of 3 in .toolbar`). `intent.action` defaults to
  `move` when the recorded edits include a move. A move is identified by the
  presence of `move`, never by the group id — the CSS position tokens live in a
  group named `positioning`, so `relative`/`absolute` can never be read as a
  reorder.
- Provenance: `intent.changes` is `stated` when non-empty, else `absent`.

No storage schema change — everything rides inside `context_json`.

### Rendering

| Surface | Change |
|---|---|
| `client/src/dialog.ts` | submission-first view model (`data-view="submit"|"edit"`): issue modal opens on click; **Edit element** (header/footer) → style editor (`.ef-card`), **Back to issue** → modal; modal Cancel/Escape cancel the report, editor Escape returns; dock toggle applies to the editor only. Design editor (no Issues tab), Commit + persistent Committed-changes list (localStorage, per-entry Remove / Remove all), context/HTML rendered in the modal only, per-element target tabs, token palette, per-target changes summary, drag ghost/insertion-line/container layers |
| `client/src/styleEditor.ts` | single-target Figma-like property rows, dropdown/chip/icon controls, Default (unset) control, custom-class affordance, Position row |
| `client/src/selection.ts` | per-target apply/change/revert API (`applyTokenToTarget`, `recordMove`, `getChangesFor`, `getChangeCountFor`, `revertChangesFor`, `clearTokenForTarget`), hover-driven highlight, `position` records |
| `client/src/structure.ts` | drop resolution (`computeDrop`), `moveElement`, replay (`placeAt`), `describePosition`/`ordinal` |
| `client/src/index.ts` | `editing` mode; picking stays live; always-on drag to move (5px threshold, click swallowed after a drop); pending edits revert on cancel/close; Commit freezes + persists in localStorage until removed |
| `server/handler/issue.go` | `## Requested changes` (`buildSingleItem`) / `### Requested changes` (`buildMultiItem`) incl. `move:` lines; `whatToDo` clause distinguishes style edits from moves |
| `server/handler/envelope.go` | `buildIntent` surfaces `changes`; `buildTarget` surfaces `targets` |
| `server/panel/panel.templ` | "Requested changes" list + `Targets (N)` row in `contextSection` |

### Theme token contract

Host app serves JSON at the `data-theme-url` script attribute; the overlay
validates and normalizes it and falls back to daisyUI `--color-*` variables read
from the live page plus a built-in spacing scale when absent. See the README
"Project theme tokens" section for the full manifest schema. Each token applies
as a class (default) or an inline style; class names, style properties and style
values are validated and all token text is escaped before rendering. A group may
set `render: "dropdown"` to render as a dropdown (every built-in group does), or
`render: "icons"` to render as a row of glyph buttons; the default is chips. A
group may also set `requires` (a single value or array of `container`,
`flex-grid-container`, `flex-container`, `container-item`, `box`, `text`,
`children`, `replaced`, `positioned`, or `has-class:<class>`) to hide itself
from elements it cannot affect — `container` matches flex/grid or a
multi-column layout (`column-count > 1`), while `flex-grid-container` matches
only flex/grid — unknown values are ignored, an applied edit keeps the group
visible, and a **Show all** toggle reveals everything. A token
may set an inline `icon: { viewBox, paths }` for icon rows; `viewBox` must match
`0 0 <n> <n>` (1–3 digits each) and every path `d` is held to a strict charset
(SVG commands, digits and whitespace, ≤ 400 chars, ≤ 12 paths). An invalid icon
is dropped while the token is kept.

## Remaining

- **P2**: user panel (`/panel`) for managing API keys — list user's repos
  (GitHub OAuth), generate/rotate/revoke repo-scoped keys.
- Snapshot storage: SQLite BLOB is fine to start; S3 when volume grows.
- Whether `traceId` should also be sent as a GitHub issue label/tag for
  grouping (likely noise — keep it in context only).
- Live editing: persist applied edits **server-side** (committed edits now persist
  client-side via localStorage until removed; nothing is stored server-side yet),
  and expose theme editing in the panel.
