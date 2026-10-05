# Competitive Analysis — Visual Feedback & Element Annotation Tools

Date: 2026-10-01
Scope: full landscape of tools that let a user point at UI, leave feedback, and route it to engineering — with a focus on drop-in script-tag overlays that export to GitHub Issues with DOM/CSS context.

Our product: **emergent.feedback** — one `<script>` tag, element-level commenting, GitHub Issues export with selector + computed styles + framework detection + viewport + HTML. Self-hostable, open source.

---

## 1. Market map

Five distinct categories compete for adjacent budgets. Only two are true head-on competitors.

| Category | What it is | Representative tools | Threat to us |
|---|---|---|---|
| **A. Visual bug-reporting SaaS** | Widget/extension → issue tracker | Marker.io, BugHerd, Userback, Usersnap, Feedbucket, Saber, PageProofer | Direct (commercial) |
| **B. AI-agent annotation** | Click element → prompt for a coding agent | gettack.dev (Tack), Mamtack, Agentation, agent-ui-annotation, React Grab | **Direct (fastest-moving)** |
| **C. Dev observability** | Session replay + logs + errors | Jam.dev, Sentry, LogRocket, OpenReplay, Highlight, PostHog, Datadog RUM, Zipy | Adjacent (context overlap) |
| **D. Feedback boards / roadmaps** | Votes, roadmap, changelog | Canny, Frill, Featurebase, Nolt, UserJot, Sleekplan | Adjacent (engagement) |
| **E. Client proofing / approval** | Annotate designs & live sites | Markup.io, Filestage, PageProofer, Pastel, Ruttl, PageProof | Adjacent (agency budget) |

Our lane: **the intersection of A + B + C-density that nobody currently owns** — a self-hostable, MIT-style script tag that produces a GitHub-issue-grade technical payload *and* feeds AI agents via MCP.

---

## 2. Head-on competitors — deep profiles

### 2.1 Mamtack (mamtack.com) — closest commercial competitor
- **Positioning:** "Visual feedback for AI prototypes and live websites — humans in the loop." Per-site pricing, unlimited reviewers.
- **Capture:** single script tag (`@mamtack/widget` IIFE, ~110 KB gz), attrs `data-project`/`data-key`/`data-storage=local`. `data-show-param="review"` gives production-stealth mode (zero DOM/network until `?review`). WordPress plugin.
- **Context:** CSS selector (prefers `data-testid`/`name`/`aria-label`); **4-tier re-anchor fingerprint** (selector → fingerprint → proximity → visibility) with 21 tested DOM-mutation scenarios; browser/OS/viewport/DPR/language; last 20 console errors (secret-scrubbed). **No source mapping, no screenshots, no replay.**
- **Handoff:** threaded comments, @mentions, resolve/reopen, assign, Flag-for-Fix; CSV/JSON; Jira/Linear/GitHub issue routing; webhooks; hosted MCP (`mcp.mamtack.com`) with `list_flagged_threads`, `get_fix_context`, `mark_fix_applied`.
- **Stack:** hosted SaaS on Supabase. **Not OSS, not self-hostable.**
- **Pricing:** Free (1 site, 15 threads, 7-day retention) → Pro $34/mo → Team $79/mo → Enterprise.
- **Strongest patterns:** pin re-anchoring across DOM mutation; production-safe stealth activation; human-in-the-loop → MCP → `mark_fix_applied` loop; per-site unlimited reviewers.
- **Weaknesses:** closed, hosted-only, no framework/source mapping, no screenshots/replay, thin free tier.

### 2.2 Tack (gettack.dev) — OSS indie, AI-handoff focus
- **Positioning:** "Click. Comment. Feed to AI." MIT, single maintainer, v0.6.0, ~57 weekly npm downloads (early).
- **Capture:** one script tag; **dormant until `#tack`** in URL hash (production-safe, one idle key listener).
- **Context:** selector path, text + section anchors (ranked), source hints from non-standard DOM stamps (Astro, react-dev-inspector, vite-plugin-vue-inspector, TanStack, Lovable), reviewer-adjusted computed styles only. **No screenshots, replay, console/network, HTML snapshot.**
- **Handoff:** Markdown export with self-describing anchor trust order, untrusted-input framing for prompts, URL-fragment share (no server), `window.__tack` API + `tack:*` events, bookmarklet.
- **Notable UX:** copy-clears-notes + undo + restore; applied-verification pass after an AI edit; in-place text/style rewrite with live preview (paused Web Animation).
- **Weaknesses → our openings:** no issue-tracker integration (dead-ends at clipboard), no full CSS/HTML/viewport payload, no screenshots/replay/logs, tiny adoption.

### 2.3 Agentation (agentation.com) — 4.8k★, source-available
- **Capture:** `npm i -D agentation` + `<Agentation/>` React component (dev-only). Separate local MCP server.
- **Context (rich):** CSS selectors, **React component tree + source file:line** (Vite/Next/Webpack/Turbopack), computed styles, text/multi/area select, shadow DOM, same-origin iframes, animation pause. **No screenshots by design.**
- **Output:** markdown in 4 detail levels (Compact→Forensic), AFS 1.1 schema.
- **Agent loop:** MCP watch/acknowledge/resolve/dismiss/reply; **critique mode** (agent annotates its own UI); **self-driving mode** (agent annotates + fixes + verifies); layout/wireframe mode.
- **License:** PolyForm Shield 1.0.0 — **non-OSI, explicit non-compete**; commercial license needed to ship in a sold product.
- **Weakness:** React/dev-only, no issue export, no collab layer, restrictive license.

### 2.4 agent-ui-annotation — MIT, closest OSS feature-parity
- npm + `<agent-ui-annotation>` web component; React/Vue 3/Svelte 5/Angular/vanilla adapters; ~5.6k weekly downloads.
- Context: smart element names, CSS selector path, **framework component paths (file:line in React 18)**, multi-select, freeze, custom-context hook, i18n.
- Output: markdown 4 levels incl. **forensic** (full DOM path, computed styles, a11y, viewport, timestamps).
- **Clipboard only — no MCP, no issue export, no server.** MIT, fully self-hostable, no backend.

### 2.5 React Grab — MIT, 7.6k★ / 1.5M wk
- npm / snippet / `npx grab init` CLI. Hover + ⌘C copies element HTML, React component name, **source file:line:col**. Zero-friction, no MCP, no issue export.

### 2.6 Commercial visual bug reporters (category A)
| Tool | Capture | Replay | Console/Net | Trackers | Free | Self-host |
|---|---|---|---|---|---|---|
| Marker.io | widget + ext | paid Team | paid Team | 20+ (GH/Jira/Linear) | no | no |
| BugHerd | snippet + ext | no | no | 21, GH/Linear on Premium | no | no |
| Userback | widget+ext+SDK | paid Business | paid Business | 20+ | yes (7-day retention) | no |
| Usersnap | snippet + ext | not marketed | console all plans | 100+ | no | no |
| Feedbucket | snippet only (anti-extension) | no | paid Business | 16+, 2-way sync | no | no |
| Saber (ex-BugMuncher) | snippet | no | JS errors | GH/GitLab/Jira | no | no |
| Pastel | proxy/overlay only | no | no | light | yes (1 canvas) | no |

**Universal gaps here:** none is self-hostable; reporter seats are free but internal seats are $30–150/mo; console/network/replay are the premium gate; **raw CSS-selector/computed-style payload in the issue body is under-marketed** — nobody advertises it.

### 2.7 Dev observability (category C)
Jam.dev is the developer mindshare leader: extension-first, **console+network logs free**, capture-everything-by-default, AI summaries, MCP + CLI. Weakness: extension onboarding friction for external reporters, no script tag, no self-host. Sentry/HyperDX/OpenReplay own OSS replay with strong redaction patterns.

### 2.8 OSS closest precedents
- **bugdrop** (MIT) — in-app feedback → GitHub Issues with screenshots/annotations. Nearest direct precedent.
- **SitePing** (MIT) — Shadow-DOM-isolated element pin overlay, framework-agnostic.
- **crikket** (AGPL), **bugpin** (AGPL) — jam.dev/marker.io self-hosted clones.
- **ppl-ai / open-feedback** etc. — boards, not overlays.

---

## 3. Best patterns to adopt (ranked by leverage)

### Capture & context
1. **DOM re-anchoring resilience** (Mamtack 4-tier fingerprint) — pins surviving re-render is the single biggest robustness moat. Steal this.
2. **rrweb / rrweb-snapshot** (MIT, 3.4M wk) — DOM serialization + incremental mutations for optional replay and structured element context; standard building block.
3. **Framework/source mapping** — component path + file:line across bundlers (Agentation/agent-ui-annotation/react-grab). Without it agents grep blind. Near-table-stakes in 2026.
4. **Computed styles + a11y + viewport "forensic" output level** — our existing differentiator; formalize as a detail-level setting.
5. **Screenshot capture with `modern-screenshot` / `html2canvas-pro`** (MIT, active) — prefer over stale html2canvas/dom-to-image; annotation overlay on the captured image.
6. **Console + network capture** attached to the report (last N errors, secret-scrubbed). Jam gives it free; most paid tools gate it.
7. **Source-map upload + stack unmapping** for JS errors (OpenReplay/Highlight pattern).

### Privacy & trust
8. **Mask-by-default**: `maskAllText`, `maskAllInputs`, `blockAllMedia` (Sentry defaults).
9. **Declarative redaction markers**: `.rr-block/.rr-ignore/.rr-mask` conventions + `data-fo-redact`.
10. **Capture-time client-side sanitization** so PII never leaves the browser (`domSanitizer` pattern, OpenReplay/Sentry).
11. **Secret scrubbing** in console/payload capture (Mamtack) — API keys, JWTs, AWS creds.
12. **Production-stealth activation** — dormant until hotkey/hash param (Tack `#tack`, Mamtack `?review`).

### Issue lifecycle (GitHub-first)
13. **One-click Create Issue** with repo/labels/assignee pre-filled (we have this — keep it front and centre).
14. **Two-way status sync** — issue closed → reporter notified / thread resolved.
15. **Close-the-loop notifications** to the reporter when shipped (Frill/Canny/Featurebase pattern).
16. **AI dedupe/merge** of duplicate reports (Upvoty/Nolt/Sleekplan).
17. **AI auto-title/triage/tag** — now table stakes in the SaaS cohort.

### Agent integration (the 2026 race)
18. **MCP server** so Claude Code / Cursor / Codex read feedback directly, with tools like `list_open_reports`, `get_report_context`, `mark_resolved` (Mamtack pattern; every major board now ships MCP).
19. **Self-describing export format** with anchor trust order + untrusted-input framing (Tack) — teaches the agent how to use context safely.
20. **Applied-verification pass** — re-check the element after an AI edit (green/amber/missing) (Tack).

### Engagement (optional board half)
21. **Upvote + comments/threads + follow**; internal private comments; @mentions.
22. **Public roadmap + changelog** with status-driven notifications.
23. **Weighted prioritization** (segment/MRR/vote velocity).
24. **Public REST API + webhooks** for integrations.

---

## 4. Whitespace — what nobody delivers

Combining all sweeps, these combinations are **unclaimed**:

1. **OSS + self-hostable + script tag on any live site + DOM re-anchoring + framework/source mapping + computed styles/HTML + one-click GitHub Issues + MCP.** No tool ships all of these. Mamtack has the workflow but is closed and lacks source mapping/screenshots; Agentation/agent-ui-annotation have rich context but clipboard-only and no issue export; React Grab/inspectors are IDE-nav only.
2. **Self-hosted/air-gapped visual bug reporting with ticketing.** ReplayBird offers self-hosted replay; nothing in the annotation+ticketing space does. Real gap for gov/defense/health.
3. **Open, portable feedback export format.** No standard bundle (screenshot + DOM + console + network) moves between vendors. Lock-in is total.
4. **Accessibility-first bug capture** — WCAG violations reported as a first-class bug type, capturing the a11y tree.
5. **Performance-linked feedback** — reporter attaches "this page was slow + here's the trace" in one ticket at SMB price.
6. **Client/screenshot annotation + GitHub-native ticket** at low friction — proofing tools stop at approval; bug tools stop at tickets.
7. **Reviewer-operable consent/redaction** — a non-technical reviewer redacting PII before it leaves the browser.
8. **Neutral feedback schema for agents** — every MCP server invents its own; no shared grammar.

---

## 5. Recommended feature set — "best feature-full solution"

Ordered so each tier is independently shippable.

### Tier 0 — already have (keep, don't regress)
Script tag install; element click → comment; GitHub Issues export; selector + computed styles + framework detection + viewport + HTML; `data-component` friendly names; hotkey selection mode; self-host Docker + GitHub OAuth.

### Tier 1 — close the competitive gaps fast
- **DOM re-anchoring fingerprint** (4-tier) so pins survive re-render.
- **Source/component mapping** where detectable (file:line for React/Vue/Svelte via dev stamps + source maps) — never invented, always labelled "hint".
- **Secret-scrubbed console capture** (last N errors/warnings, max 8 KB).
- **Mask-by-default** + `data-fo-redact` declarative markers + capture-time sanitization.
- **MCP server** (self-hosted) exposing `list_reports`, `get_report_context`, `mark_resolved`.
- **Applied-verification pass** after an edit.
- **Two-way GitHub status sync** (issue closed ↔ report resolved).

### Tier 2 — match the SaaS premium tier
- **Screenshot with annotation** (`modern-screenshot`/`html2canvas-pro`), opt-in.
- **Network request capture** (fetch/XHR), opt-in, sanitized.
- **Detail levels** (Compact / Standard / Forensic) in the export.
- **rrweb-based replay**, buffered last ~60s, shipped only on submit — privacy- and cost-efficient.
- **Reporter follows / notification** on status change (email or webhook).
- **AI auto-title + dedupe/merge** (BYO key or local).

### Tier 3 — differentiation / expansion
- **Accessibility audit attached to report** (a11y tree + WCAG hits).
- **Performance snapshot** (Web Vitals + optional trace) attached to report.
- **Public roadmap + changelog** for the board half (optional module).
- **Open export schema** ("feedback spec") — document and version our JSON bundle; first mover on portability.
- **Mobile / React Native element feedback** (nobody does element-level native feedback).
- **Cross-vendor dedupe** across board + support inbox + GitHub.

### Avoid
- Restrictive licenses (Agentation PolyForm non-compete, marker.js Linkware) — do not copy code from these.
- Pageview-metered or AI-credit pricing models — our wedge is predictable self-host cost.
- Extension-first onboarding for external reporters — script tag is the moat.

---

## 6. Positioning conclusion

Our defensible position: **the open, self-hostable, GitHub-native visual feedback overlay with agent-grade context.**

Tagline candidate: *"One script tag. Click any element. A complete, redacted, agent-ready GitHub issue."*

Priority wedge, in order:
1. GitHub-first + CSS/source-rich payload (**nobody in category A advertises raw CSS context**).
2. Self-host / OSS (**nobody in category A or B offers it**).
3. MCP + agent loop (**Mamtack is the only one, and it's closed**).
4. Privacy-by-default redaction (**Sentry/OpenReplay own this in replay; nobody does it in feedback overlays**).

Risks to watch: Agentation (4.8k★) or agent-ui-annotation (MIT, high npm volume) adding issue-tracker export + a server; Mamtack adding source mapping or open-sourcing. Move on Tier 1 quickly.

---

## 7. Primary sources

- **Head-on:** gettack.dev · mamtack.com · agentation.com · github.com/benjitaylor/agentation · npmjs.com/package/agent-ui-annotation · react-grab.com · github.com/zthxxx/react-dev-inspector · github.com/webfansplz/vite-plugin-vue-inspector · stagewise.io
- **Category A:** marker.io · bugherd.com · userback.io · usersnap.com · feedbucket.app · saberfeedback.com · pageproofer.com
- **Category C:** jam.dev · birdeatsbug.com · sentry.io (Replay/User Feedback) · logrocket.com · openreplay.com · highlight.io · posthog.com · datadoghq.com (RUM) · zipy.ai · livesession.io · replaybird.com
- **Category D:** canny.io · frill.co · featurebase.app · upvoty.com · uservoice.com · nolt.io · userjot.com · sleekplan.com · featureos.com
- **Category E:** markupl.io · filestage.io · govisually.com · usepastel.com · ruttl.com · reviewstudio.com
- **OSS building blocks:** github.com/rrweb-io/rrweb · github.com/qq15725/modern-screenshot · github.com/yorickshan/html2canvas-pro · github.com/bugdrophq/bugdrop · github.com/NeosiaNexus/SitePing · github.com/redpangilinan/crikket · github.com/aranticlabs/bugpin · github.com/ChromeDevTools/chrome-devtools-mcp

Note: pricing and feature facts are as displayed on vendor sites at fetch time (2026-10-01). Tier structures change frequently — re-verify before citing in a spec.
