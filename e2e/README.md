# emergent.feedback — E2E (Playwright)

End-to-end suite covering **our own pages** (landing, panel, overlay, API) and
**other pages** that embed the overlay (a local fixture host, plus env-gated
remote host apps).

```bash
cd e2e
npm install
npx playwright install chromium
npx playwright test            # own + host (deterministic, no external creds)
npx playwright test --project=own
npx playwright test --project=host
npx playwright test --project=remote   # only when E2E_HOST_URL is set
```

The suite starts two servers itself:

| Server | Port | Purpose |
| --- | --- | --- |
| Go API (`go run ./server`) | `18095` | landing, panel, overlay bundle, API, MCP |
| Fixture static server | `18096` | the "other page" that embeds the overlay |

Both reuse an already-running instance locally (`reuseExistingServer`); in CI
they are started fresh. Ports and secrets are overridable via `e2e/.env`
(copy `e2e/.env.example`).

## How credentials are provided

The panel and the embedded overlay share one credential: an **HS256 JWT signed
with the server's `JWT_SECRET`**. The client stores it in
`localStorage.__ef_token__` (plus a `__ef_user__` profile and an
`ef_panel_token` cookie fallback for the panel). The suite mints that token
offline — no GitHub OAuth popup, fully deterministic and CI-safe.

| Target | Credential | How the suite supplies it |
| --- | --- | --- |
| **Own pages** (landing / panel / overlay) | Session JWT | `support/jwt.ts` mints a token from `E2E_JWT_SECRET`; `support/auth.ts` injects it into `localStorage` + cookie via `context.addInitScript`. The secret matches the `JWT_SECRET` the test server is launched with. |
| **Own API tests** | Session JWT | Same minted token sent as `Authorization: Bearer <jwt>` on Playwright `request` calls. |
| **MCP endpoint** | `ef_...` / bootstrap key | `E2E_MCP_API_KEY`, matched to the server's `MCP_API_KEY`. |
| **Local host fixture** | Session JWT | Same injection; the fixture's `data-api` points at the test API. |
| **Remote host app** | Host-app login | Playwright `storageState` (`E2E_STORAGE_STATE`, default `e2e/.auth/host.json`). Capture once with `npx playwright codegen --save-storage=...`, or let the `remote-auth` setup project log in from `E2E_HOST_USER` / `E2E_HOST_PASS`. |
| **Remote overlay auth** | Real GitHub session | For a third-party feedback server you do not control, automate it by capturing that session into the same storageState (never drive the GitHub OAuth popup in automation). For a server you do control, mint a JWT with its `JWT_SECRET` as above. |

### Why not drive the GitHub OAuth popup?

The login flow opens `/auth/github` in a popup and completes via `postMessage`
after GitHub redirects back. GitHub's login (device prompts, 2FA, captcha) makes
that brittle in CI. Minting the JWT directly exercises every code path *after*
login, which is what the suite is meant to cover. The one real-GitHub edge —
issue export — is stubbed/mocked; the panel's `api/repos` call is left to the
server and its GitHub App installation.

## Layout

```
playwright.config.ts      # servers, projects (own | host | remote-auth | remote)
support/env.ts            # .env loader + typed config
support/jwt.ts            # offline HS256 session-token minting
support/auth.ts           # inject token/profile into a browser context
support/start-api.mjs     # clean-DB Go server launcher
support/serve-fixtures.mjs# static host-page server (rewrites __API_URL__)
fixtures/host.html        # "other page" embedding the overlay
fixtures/theme.json       # style-editor token manifest
tests/own/*.spec.ts       # landing, panel, overlay, API
tests/host/embed.spec.ts  # embedded overlay on the fixture host
tests/remote/*            # env-gated remote host specs + optional auth setup
.env.example              # all knobs, committed
```

## Environment

Everything has a safe default; see `e2e/.env.example`. Key knobs:
`E2E_JWT_SECRET`, `E2E_MCP_API_KEY`, `E2E_USER`, `E2E_REPO`,
`E2E_HOST_URL`, `E2E_STORAGE_STATE`, `E2E_HOST_USER`, `E2E_HOST_PASS`,
`E2E_ALLOW_WRITES`.
