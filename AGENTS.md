# emergent.feedback — project agent instructions

Repo-scoped rules. These complement the global `~/.config/opencode/AGENTS.md`.

## Landing pages & marketing UI: reuse Scalo first

A purchased daisyUI 5 + Tailwind 4 startup template lives locally at `/root/scalo-html`.
Before writing **any** landing / marketing / auth / settings UI, inspect it and reuse as
much as possible. Do not hand-roll sections the template already provides.

Reuse sources:

- Section partials: `/root/scalo-html/src/partials/{home,developer,automation}/*.html`
  — hero, features, benefits, process, integrations, pricing, testimonials, FAQ, CTA,
  topbar, footer, wave paths.
- Full pages: `/root/scalo-html/src/*.html` — pricing (4 variants), developer, automation,
  testimonials, FAQ, contact, motion-effects, auth (login/register/forgot/reset/2fa),
  settings (profile/account/plan/notification).
- Styles: `/root/scalo-html/src/styles/**` — daisyUI theme, typography, custom
  components/animations/plugins.
- Assets: `/root/scalo-html/public/images/**`.
- Motion scripts: `/root/scalo-html/html/js/pages/*.js`.

Porting rules:

- Translate markup to **Go + templ**; prefer `go-daisy` (`components/ui`) components where
  they match; keep daisyUI class names intact.
- Prefer re-implementing markup into `.templ` over copying raw template files.
- The landing theme is built into `server/app/static/css/scalo.css` (Tailwind 4 +
  daisyUI 5, theme name `scalo`). Use `data-theme="scalo"` on pages that consume it.
  Do not override go-daisy's `/static/css/app.css`; layer `scalo.css` after it.

Design workflow skills (vendored in `.opencode/skills/`): `frontend-design`,
`ui-ux-pro-max`, `web-design-guidelines`, `emil-design-eng`, `impeccable`. Load the
relevant one before design-heavy landing work.

## License (important)

Scalo is a paid, single-project license (`/root/scalo-html/LICENSE`). Private and
commercial use are allowed; **redistribution and sharing the template files are not**.

- Never commit `/root/scalo-html` source or its images into this repo (especially if the
  GitHub remote is public). Keep the template local.
- Only commit the adapted output you generate: `.templ` markup and the built
  `landing/styles` CSS (which is derived styling, not the original template bundle).
- Keep `/root/scalo-html` out of git; do not add it to the repo.

## Landing page / UI verification

- CSS build: `cd landing && npm run build` (or `task build:css`) → `server/app/static/css/scalo.css`.
- templ: `/root/go/bin/templ generate` after any `.templ` change.
- Build: `task build` (or `go build ./...`). Lint: `task lint`. Tests: `task test`.
- For UI changes, verify in a browser at desktop + mobile widths using the Chrome DevTools
  MCP or Playwright MCP. `server/e2e_test.go` asserts `/static/css/app.css` returns 200.
