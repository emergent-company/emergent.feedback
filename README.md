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
| Click an element | Opens the feedback dialog |
| Release hotkey | Exits selection mode (dialog stays open if already clicked) |

### Feedback dialog

1. Existing comments for that element are shown at the top (scrollable)
2. Type a new comment in the textarea
3. Select **Bug** or **Enhancement**
4. **Save** — saves the comment without creating a GitHub issue
5. **Send to GitHub** — submits the comment (if any) and creates a GitHub issue with full context

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
