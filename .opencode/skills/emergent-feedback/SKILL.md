---
name: emergent-feedback
description: Drop-in feedback tool for any web app. Users click elements, leave comments, export to GitHub Issues with CSS context. Use when user asks about installing, configuring, self-hosting, or using emergent.feedback. Covers script tag setup, data attributes, data-component, hotkey config, OAuth, Docker deployment.
---

# emergent.feedback

Zero-config feedback overlay. One `<script>` tag adds element-level commenting + GitHub Issues export with full CSS context.

## Quick Install

```html
<script
  src="https://feedback.emergent-company.ai/emergent-feedback.js"
  data-repo="your-org/your-repo"
  async
></script>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `data-repo` | Yes | GitHub repo `owner/repo` |
| `data-api` | No | API base URL (default: `https://feedback.emergent-company.ai`) |
| `data-label` | No | Base label (default: `feedback`) |
| `data-hotkey` | No | `alt+shift` (default), `ctrl+shift`, `meta+shift` |
| `data-branch` | No | Git branch being tested — shown in dialog + issue body |
| `data-version` | No | App version being tested — shown in dialog + issue body |

## Usage

| Action | Result |
|--------|--------|
| Hold hotkey | Enter selection mode (crosshair + highlights) |
| Hover element | Tooltip shows tag or `data-component` name |
| Click element | Opens feedback dialog |
| Release hotkey | Exit selection mode |

### Feedback dialog

- Existing comments shown at top
- Type comment, pick Bug/Enhancement
- **Save** — saves locally without GitHub issue
- **Send to GitHub** — creates issue with full CSS context (selector, computed styles, framework detection, viewport, HTML)

## `data-component` attribute

Add `data-component="Name"` to make hover tooltips show a friendly name instead of raw CSS selector. The overlay walks up the DOM from clicked element to find nearest ancestor with this attr.

```html
<div data-component="PricingCard">
  <div data-component="PlanSelector">...</div>
</div>
```

Used in: tooltip, issue title, CSS selector generation (as stable anchor).

## Self-hosting

### 1. GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App

| Field | Value |
|-------|-------|
| Callback URL | `https://your-domain.com/auth/callback` |

### 2. docker-compose.yml

```yaml
services:
  emergent-feedback:
    image: ghcr.io/emergent-company/emergent-feedback:latest
    ports:
      - "8080:8080"
    volumes:
      - feedback_data:/data
    environment:
      PORT: "8080"
      DB_PATH: /data/feedback-overlay.db
      GH_APP_CLIENT_ID: ${GH_APP_CLIENT_ID}
      GH_APP_CLIENT_SECRET: ${GH_APP_CLIENT_SECRET}
      GH_REDIRECT_URI: https://your-domain.com/auth/callback
      JWT_SECRET: ${JWT_SECRET}

volumes:
  feedback_data:
```

### 3. .env

```env
GH_APP_CLIENT_ID=<id>
GH_APP_CLIENT_SECRET=<secret>
JWT_SECRET=<openssl rand -hex 32>
```

### 4. Start

```bash
docker compose up -d
```

### 5. Point script at your instance

```html
<script
  src="https://your-domain.com/emergent-feedback.js"
  data-api="https://your-domain.com"
  data-repo="your-org/your-repo"
  async
></script>
```

## Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./feedback-overlay.db` | SQLite path |
| `GH_APP_CLIENT_ID` | — | OAuth client ID |
| `GH_APP_CLIENT_SECRET` | — | OAuth client secret |
| `GH_REDIRECT_URI` | — | Must match OAuth callback |
| `JWT_SECRET` | — | Session JWT signing key |
| `ISSUE_AUTHOR_MODE` | `bot` | Issue author: `bot` (GitHub App or `GH_BOT_TOKEN`) or `user` (reporter's own token) |
| `GH_BOT_TOKEN` | — | Optional fine-grained PAT to author issues when no GitHub App is configured |

## GitHub labels

Repo needs `bug`, `enhancement`, `feedback` labels:

```bash
gh label create bug --color d73a4a --repo your-org/your-repo
gh label create enhancement --color a2eeef --repo your-org/your-repo
gh label create feedback --color ededed --repo your-org/your-repo
```

## Dev

```bash
# deps
npm install

# JS bundle + Go server with hot reload
task dev

# Build
npm run build --prefix client
go build ./server/...
docker build -t emergent-feedback .
```

Server listens on `http://localhost:8080` by default.
