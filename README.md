# emergent.feedback

A lightweight, drop-in feedback tool for any web app. Users hold `Alt+Shift` (configurable) to enter element-selection mode, click any element to leave a comment, and export feedback directly to GitHub Issues — with full CSS context, computed styles, and element HTML attached automatically.

---

## Features

- **Zero-config install** — one `<script>` tag, no framework required
- **Element-level feedback** — click any element; the CSS selector, computed styles, and element HTML are captured automatically
- **Bug / Enhancement tagging** — choose the type before submitting; the correct label is applied to the GitHub issue
- **CSS context** — detects framework (Tailwind, DaisyUI, Bootstrap, MUI, Chakra, Radix, shadcn), captures key computed styles, element position and viewport size
- **`data-component` support** — if an element or ancestor has `data-component="MyWidget"`, the component name is shown in the hover tooltip
- **GitHub OAuth** — users sign in with GitHub; session persists across page reloads (30-day JWT in `localStorage`)
- **Export to GitHub Issues** — creates a well-structured issue with comments, selector, position, CSS framework, computed styles, and pretty-printed HTML
- **Badge overlays** — elements with existing feedback show a count badge in selection mode; clicking a badge reopens the dialog for that element

---

## Installation

### 1. Add the script tag

Add the following snippet to your HTML, just before `</body>`:

```html
<script
  src="https://feedback.emergent-company.ai/emergent-feedback.js"
  data-api="https://feedback.emergent-company.ai"
  data-repo="your-org/your-repo"
  data-label="feedback"
  async
></script>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `data-api` | No | API base URL. Defaults to `https://feedback.emergent-company.ai` |
| `data-repo` | Yes | GitHub repo to create issues in (e.g. `acme/my-app`) |
| `data-label` | No | Base label applied to all issues. Defaults to `feedback` |
| `data-hotkey` | No | Activation key combo. Defaults to `alt+shift`. Options: `alt+shift`, `ctrl+shift`, `meta+shift` |
| `data-branch` | No | Git branch being tested. Shown in dialog and included in issue body |
| `data-version` | No | App version being tested. Shown in dialog and included in issue body |
| `data-theme` | No | Overlay theme: `auto` (default), `light` or `dark`. `auto` detects the host page theme, then falls back to the OS `prefers-color-scheme`. |
| `data-theme-url` | No | Absolute or same-origin URL of a JSON theme manifest (design-token groups) that powers the live style editor. See [Live style editing](#live-style-editing). When omitted, the overlay reads daisyUI color variables from the page and uses a built-in Tailwind/daisyUI utility set (spacing, layout, typography, colors, borders/effects, daisyUI components). |

The overlay dialog, activation bar, badges and toasts follow the resolved theme. The server-rendered
landing page and API-key panel share a persisted Light/Dark/System toggle (localStorage key
`emergent-feedback-theme`); the overlay's `auto` mode follows the page/OS independently and does not
read that key.

### Host metadata via `<meta name="ef:*">` (planned)

> Not implemented yet. See `docs/design.md` (v4) for the full design.

Attach arbitrary product metadata from the document `<head>` using the `ef:`
prefix. Flat names become keys; dotted names nest (max 3 segments). Collected
into `context.app` and rendered in the dialog, the GitHub issue body, and the
panel preview.

```html
<meta name="ef:env" content="staging">
<meta name="ef:tenant.id" content="acme">
<meta name="ef:feature.area" content="billing">
```

Sensitive keys/values (tokens, secrets, email, etc.) are dropped before attach;
input is capped (≤ 500 chars/value, ≤ 50 keys, ≤ 4 KB total).

### 2. Ensure GitHub labels exist

The repo must have `bug` and `enhancement` labels. GitHub creates these by default on new repos. To add them manually:

```bash
gh label create bug      --color d73a4a --repo your-org/your-repo
gh label create enhancement --color a2eeef --repo your-org/your-repo
gh label create feedback --color ededed  --repo your-org/your-repo
```

### 3. That's it

No build step, no npm install, no configuration file. The script self-initialises on page load.

---

## Usage

| Action | Result |
|--------|--------|
| Hold `Alt+Shift` (or configured hotkey) | Enter element-selection mode (crosshair cursor + highlights) |
| Hover an element | Tooltip shows element tag (or `data-component` name if set) |
| Click an element | Opens the issue submission modal |
| Release hotkey | Exits selection mode (dialog stays open if already clicked) |

### Feedback dialog

Clicking an element opens the **issue submission modal** first — the former
**Send to GitHub** button is gone. To report feedback:

1. In the modal, fill the comment (`#__ef_comment__`), issue title, type
   (**Bug** / **Enhancement**) and intent, then **Create issue**
   (`#__ef_issue_submit__`) to submit to GitHub, or **Save** (`#__ef_submit__`)
   to save the feedback locally without creating a GitHub issue.
2. Optionally, **Edit element** (`#__ef_edit_element__` in the modal header, or
   `#__ef_edit_element_foot__` in the footer) opens the style editor as a right
   sidebar (docked, the default) or centered card. Restyle the selected
   element(s) there, then **Back to issue** (`#__ef_back_to_issue__`) returns to
   the modal — typed text and pending edits are preserved. In the editor,
   **Cancel** (`#__ef_cancel__`) throws away the whole report.
3. In the modal, **Cancel** (`#__ef_issue_cancel__`) discards the report and
   closes the overlay. `Escape` does the same while the modal is up; in the
   editor it returns to the modal instead.

### Docked panel

Docking applies to the **style editor**, not the issue modal. The editor can
dock to the right edge instead of rendering as a centered card. Docked mode sits
**alongside** the page rather than over it: the editor reserves its rail width
(`margin-right` on the document root), so the host content reflows and stays
fully visible and undimmed — no overlay covering the page. Element picking,
multi-select and live style editing all continue while the editor is open; the
hover highlight is repainted after the reflow. Toggle dock/undock from the
editor header (`#__ef_dock__`); the choice is persisted per browser (localStorage
`__ef_dialog_docked__`) and docked is the default. On narrow viewports (≤ 520 px)
the editor takes the full width and the page is not reflowed.

The **issue submission modal is always centered** — it never docks. In centered
(undocked) mode the editor card takes roughly half the viewport width (50 vw,
capped at 900 px, min 480 px). Because the centered backdrop blocks the page,
pressing **Add element** hides the editor while you click the element to add,
then brings it straight back; press `Escape` to cancel the pick and stay in the
editor.

> Caveat: host elements positioned with `position: fixed` or `position: sticky`
> are not shifted by the reserved rail width, and an explicitly sized `html`
> (`width`/`min-width`) can defeat the reflow and produce a horizontal scrollbar
> under the editor.

### Live style editing

The style editor (`.ef-card`, opened via **Edit element**) shows only the
**Design** editor (the former Design/Issues tabs are gone). Writing the report
and viewing the captured context/HTML happen in the issue submission modal (see
[Feedback dialog](#feedback-dialog)), not in the editor. `#__ef_change_count__`
in the modal header shows the attached style-change count.

With the editor open, click additional elements to add them to the selection (a
click on an already-selected element toggles it off, and **Add element** enters a
pick mode). When more than one element is selected, the Design editor shows them
as **per-element tabs**: pick a tab to edit that element on its own. Each edit is
bounded to the active element — nothing is applied globally.

Outlines are hover-driven: a selected element is **not** permanently boxed (that
would cover the border/background/shadow being judged). Hover or focus a target
label in the editor to outline that element, or hover the element itself to peek
its tab — plus a short flash on select.

Properties are grouped into collapsible sections — **Spacing**, **Layout**,
**Typography**, **Color**, **Borders & Effects** and **daisyUI** — covering
Tailwind/daisyUI utilities such as padding, margin, gap, max-width, width/height,
display/flex, text size, font weight, rounding, borders, shadow and button/badge
modifiers. Each group renders as a Figma-like row (label left, control right).
Every built-in group renders as a **dropdown** (color groups show a swatch in
the trigger and next to each option), so the editor has one uniform control. The
`render` field still accepts `chips` or `icons` (an inline-SVG glyph row) for
host manifests; the fallback set uses neither.

Every dropdown ends with a **Custom class…** item (chip groups expose a
**+ Custom** toggle) — type any Tailwind/daisyUI class (e.g. `max-w-6xl`) and
press Enter to apply it. Choosing a token applies it live to the active element as
a CSS class (or inline style, per token); applied edits are recorded per element
and shown in the **Changes** list.

Every group also has a **Default** control — the first chip in a chip row, the
first item in a dropdown — which unsets the group: the overlay's edit is reverted
and dropped, restoring whatever the element had before (a committed edit too, so
it stops being replayed). Clicking an already-selected chip or choosing the
selected dropdown option does the same. `Default` (unset) is not `None`
(`p-0`, `m-0`, `gap-0`), which explicitly applies a zero value. When the value on
an element comes from the page's own markup rather than an overlay edit, Default
leaves it alone and says so.

Selected elements can also be **dragged to move them**. There is no move mode:
press a selected element on the page, move more than ~5 px and drop it. Inside a
container the drop reorders siblings (the insertion line follows the row/column
axis); dropping over a container's own padding/gap area appends into it, so an
element can be reparented. Below the threshold nothing is intercepted — links,
buttons and text fields inside the element keep working — and the click after a
drop is swallowed so it does not also toggle the selection. Illegal drops
(onto/into itself, onto overlay chrome, onto the page root) are refused.

A move is recorded per element as an anchor pair (container selector + the
sibling it sits before + index, plus the readable position, e.g.
`2nd of 3 in .toolbar`). It shows up in the **Changes**/**Committed changes**
lists as `Position`, is reverted with the element's other pending edits, replays
after a reload once committed, and rides in the payload as
`{ target, group: "position", before, after, move: { from, to } }` — the issue
body renders it as a `move:` line.

Edits start **pending**: they apply live to the page but are reverted when the
report is cancelled or the editing session ends. Press **Commit** to freeze the
pending edits — committed edits are written to localStorage and persist across
closing/reopening the editor and page reloads. Manage them from the global
**Committed changes** list (per-entry **Remove** plus **Remove all**); they are
cleared only by explicit removal. The issue submission modal and the server
panel preview render a **Requested changes** list (`target — group: before → after`).

Tokens come from the project via `data-theme-url` (below). Placeholder choices
are used when it is absent.

### Project theme tokens (`data-theme-url`)

The host app serves a JSON manifest describing the token groups offered by the
editor. The overlay fetches it once per session, validates it, and falls back to
daisyUI color variables read from the live page plus a built-in spacing scale
when the URL is missing or unreachable.

```json
{
  "version": 1,
  "groups": [
    { "id": "padding", "label": "Padding", "applyType": "class", "removePattern": "^p[xytrbl]?-",
      "tokens": [
        { "id": "none", "label": "None", "className": "p-0" },
        { "id": "sm", "label": "Small", "className": "p-2" },
        { "id": "md", "label": "Medium", "className": "p-4" },
        { "id": "lg", "label": "Large", "apply": { "type": "style", "prop": "padding", "value": "var(--space-lg)" } }
      ] },
    { "id": "textColor", "label": "Text color", "applyType": "class", "removePattern": "^text-",
      "tokens": [
        { "id": "base", "label": "Default", "className": "text-base-content", "swatch": "var(--color-base-content)" },
        { "id": "primary", "label": "Primary", "className": "text-primary", "swatch": "var(--color-primary)" }
      ] },
    { "id": "backgroundColor", "label": "Background", "applyType": "class", "removePattern": "^bg-",
      "tokens": [
        { "id": "base-100", "label": "Base", "className": "bg-base-100", "swatch": "var(--color-base-100)" },
        { "id": "primary", "label": "Primary", "className": "bg-primary", "swatch": "var(--color-primary)" }
      ] }
  ]
}
```

Each token is applied as a **class** (default, `applyType: "class"`) or as an
inline **style** (`"apply": { "type": "style", "prop": "...", "value": "..." }`).
Only the following style properties are accepted: `padding`, `padding-top`,
`padding-right`, `padding-bottom`, `padding-left`, `color`, `background-color`,
`background`, `border-radius`. Class names are validated, and all token text is
escaped before rendering.

Each group may also set `"section": "Layout"` to place it under a named
collapsible heading (default `"Style"`), and `"render": "dropdown"`, `"chips"`
or `"icons"` to pick the control: a dropdown (what every built-in group uses), a
chip row, or a row of glyph buttons. All three are optional — an unknown value
is ignored and the group falls back to chips. Dropdowns always offer a
**Custom class…** entry for a free-typed class, regardless of `render`.

A token may carry an inline glyph for icon rows via `"icon": { "viewBox":
"0 0 24 24", "paths": ["M4 5 …"] }`. The `viewBox` and every path `d` are
validated against a strict charset before rendering; an invalid icon is dropped
while the token itself is kept (the editor falls back to a text chip).

### Configuring the activation hotkey

If `Alt+Shift` conflicts with another tool, override it via `data-hotkey`:

```html
<script
  src="https://feedback.emergent-company.ai/emergent-feedback.js"
  data-repo="your-org/your-repo"
  data-hotkey="ctrl+shift"
  async
></script>
```

Supported values: `alt+shift` (default), `ctrl+shift`, `meta+shift`.

### `data-component` attribute

Add `data-component` to any element to make it show a friendly name in the hover tooltip instead of the raw CSS selector:

```html
<div data-component="PricingCard">
  <!-- child elements will show "PricingCard" in the tooltip -->
</div>
```

---

## Self-hosting

### Requirements

- Docker + Docker Compose
- A GitHub OAuth App
- A server reachable by your users

### 1. Create a GitHub OAuth App

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
|-------|-------|
| Application name | emergent.feedback |
| Homepage URL | `https://your-domain.example.com` |
| Authorization callback URL | `https://your-domain.example.com/auth/callback` |

Note the **Client ID** and generate a **Client Secret**.

### 2. Create a JWT secret

```bash
openssl rand -hex 32
```

### 3. Write your compose file

```yaml
# docker-compose.yml
services:
  emergent-feedback:
    image: ghcr.io/emergent-company/emergent-feedback:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - feedback_data:/data
    environment:
      PORT: "8080"
      DB_PATH: /data/feedback-overlay.db
      GH_APP_CLIENT_ID: ${GH_APP_CLIENT_ID}
      GH_APP_CLIENT_SECRET: ${GH_APP_CLIENT_SECRET}
      GH_REDIRECT_URI: https://your-domain.example.com/auth/callback
      JWT_SECRET: ${JWT_SECRET}

volumes:
  feedback_data:
```

### 4. Write your `.env`

```env
GH_APP_CLIENT_ID=<your client id>
GH_APP_CLIENT_SECRET=<your client secret>
JWT_SECRET=<your random secret>
```

### 5. Start

```bash
docker compose up -d
```

### 6. Update your script tag

Point `data-api` to your own domain:

```html
<script
  src="https://your-domain.example.com/emergent-feedback.js"
  data-api="https://your-domain.example.com"
  data-repo="your-org/your-repo"
  async
></script>
```

---

## GitHub Issue format

When feedback is exported, the issue looks like this:

```
Title: Feedback on button.fo-btn-primary

## Feedback

**URL:** https://app.example.com/dashboard
**Viewport:** 1440 × 900 px

---

### Comment 1

**@alice**
The button colour doesn't meet contrast requirements.

---

**Selector:** `main > section > button.fo-btn-primary`
**Position:** top 340, left 120 — **Size:** 120 × 36 px
**CSS framework:** Tailwind CSS, DaisyUI

<details><summary>Computed styles</summary>
...
</details>

<details><summary>Element HTML & full context</summary>
...
</details>
```

Labels applied: `feedback`, `bug` or `enhancement` (whichever was selected in the dialog).

---

## Development

### Prerequisites

- Go 1.21+
- Node.js 18+
- [go-task](https://taskfile.dev) (`brew install go-task`)

### Run locally

```bash
# Install Node deps
npm install

# Build JS bundle + start the Go server with live reload
task dev
```

The server listens on `http://localhost:8080` by default.

### Build

```bash
# Build JS bundle only
npm run build --prefix client

# Build Go binary
go build ./server/...

# Build Docker image
docker build -t emergent-feedback .
```

### E2E tests (Playwright)

A Playwright suite lives in `e2e/` and covers both our own pages (landing,
panel, overlay, API) and other pages that embed the script (a local host
fixture plus env-gated remote host apps).

```bash
task e2e:install     # npm install + download Chromium (first run)
task e2e             # run own + host specs; remote specs auto-skip
```

The suite starts the Go server and a fixture host server itself, using known
test secrets, and authenticates by **minting a session JWT offline** from
`E2E_JWT_SECRET` — no GitHub OAuth round-trip. Remote host apps use a Playwright
`storageState` captured once. See [`e2e/README.md`](e2e/README.md) for the full
credential matrix and configuration knobs (`e2e/.env.example`).

### Environment variables

**Required**

| Variable | Description |
|----------|-------------|
| `GH_APP_CLIENT_ID` | GitHub OAuth App client ID |
| `GH_APP_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GH_REDIRECT_URI` | Must match the OAuth App callback URL (`https://your-domain.example.com/auth/callback`) |
| `JWT_SECRET` | Secret used to sign session JWTs (`openssl rand -hex 32`) |

**Server / storage**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `/data/feedback-overlay.db` | SQLite database path (used when `DATABASE_URL` is unset) |
| `DATABASE_URL` | — | Postgres DSN; when set, uses Postgres instead of SQLite |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `MAX_BODY_BYTES` | `10MB` | Maximum request body size |

**GitHub issue authoring** (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ISSUE_AUTHOR_MODE` | `bot` | `bot` (server token / GitHub App) or `user` (each reporter's own token) |
| `GH_BOT_TOKEN` | — | Bot token used to author issues |
| `GH_APP_ID` | — | GitHub App ID (App-based authoring) |
| `GH_INSTALLATION_ID` | — | GitHub App installation ID |
| `GH_APP_SLUG` | — | GitHub App URL slug; used to build the "grant access" install URL for out-of-scope repos |
| `GH_APP_PRIVATE_KEY` | — | GitHub App private key PEM, inline |
| `GH_APP_PRIVATE_KEY_PATH` | — | Path to the GitHub App private key PEM (preferred over inline) |

**Integrations** (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_API_KEY` | — | Enables the `/mcp` endpoint; agents authenticate with `Authorization: Bearer <key>` |
| `FEEDBACK_LLM_BASE_URL` | — | OpenAI-compatible base URL; enables LLM issue auto-title |
| `FEEDBACK_LLM_API_KEY` | — | API key for LLM auto-title |
| `FEEDBACK_LLM_MODEL` | `gpt-4o-mini` | Model used for auto-title |
| `FEEDBACK_NOTIFY_WEBHOOK` | — | URL to POST lifecycle events (resolved/verified) to |

> In `bot` mode with no GitHub App or `GH_BOT_TOKEN` configured, the server warns and
> falls back to authoring issues with each reporter's own GitHub token.

### Troubleshooting

#### Export returns 403 / app_access_required

`POST /issue/export` now probes the caller's access to the target repo directly
(instead of list membership). When the caller's token is valid but the GitHub App
installation does not cover the repo — e.g. the App is installed on "Only select
repositories" and this private repo was not selected — the endpoint returns a
structured `403`:

```json
{"error":"app_access_required","message":"The feedback app does not have access to owner/repo. Grant access in GitHub, then try again.","repo":"owner/repo","authorize_url":"https://github.com/settings/installations/1"}
```

To resolve it, grant the feedback GitHub App access to the repo:

1. Open **GitHub → Settings → GitHub Apps** (or the organization's **Installed GitHub Apps**), find the feedback app, and click **Configure**.
2. Under **Repository access**, select the repo (or choose **All repositories**).
3. Confirm the app's **Issues** repository permission is **Read & write**.
4. Retry the export.

If no `authorize_url` is returned, set `GH_APP_SLUG` (the app's URL slug) so the
server can build the install URL for the client to surface.

When exporting, the server resolves the GitHub App installation that covers the
target repo (via `GET /repos/{owner}/{repo}/installation`) rather than using a
single configured installation, and a create-time 404 is surfaced as the same
actionable `app_access_required` 403 above.

#### GitHub App setup redirects

When using GitHub App authoring (`ISSUE_AUTHOR_MODE=bot` + `GH_APP_ID`), set the
GitHub App **Setup URL** to `https://<host>/auth/setup`. The **OAuth callback
stays `/auth/callback`** — that is still where the user sign-in code is
exchanged. After an install or config change, GitHub redirects the browser to the
Setup URL with `installation_id` and `setup_action` parameters; the page that
renders there is informational only ("App access updated — close this tab, return
to the app, and click Retry") and never issues a session token.

#### Expired or invalid sign-in link

Sign-in state tokens now expire after 30 minutes. When a link has expired (or is
otherwise invalid), the callback renders a friendly error page with a **Retry
sign-in** button instead of a raw JSON 400 — and, when the state was
signature-valid, the page notifies the opener so the overlay can retry without
losing the user's draft.

---

## opencode AI skill

This repo includes an [opencode](https://opencode.ai) AI skill for AI-assisted installation, configuration, and self-hosting:

```
.opencode/skills/emergent-feedback/SKILL.md
```

opencode auto-discovers project skills. No manual setup needed.

---

## Versioning

This project uses [Semantic Versioning](https://semver.org). The current version is stored in the `VERSION` file at the repo root and is embedded into the Docker image at build time. The `/health` endpoint reports the running version and commit SHA:

```json
{"ok": true, "version": "0.3.1", "commit": "ff46ac7"}
```

Releases are tagged in Git (`v0.2.0`) and published as GitHub Releases with a corresponding Docker image tag on GHCR (`ghcr.io/emergent-company/emergent-feedback:v0.2.0`).
