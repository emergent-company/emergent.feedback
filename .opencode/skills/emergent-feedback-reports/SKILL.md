---
name: emergent-feedback-reports
description: Access emergent.feedback bug reports exported to GitHub Issues. Use when triaging an emergent.feedback issue, resolving an issue number to feedback items, or pulling the full page snapshot / element screenshot / context for a report via the emergent.feedback MCP server.
---

# emergent.feedback — accessing reports

emergent.feedback is a drop-in feedback widget. Users click an element, leave a
comment, and the overlay exports it to a GitHub Issue with full CSS context.
The full-page snapshot, screenshot, and structured context are stored
server-side and fetched on demand through an MCP server — they are **not**
inlined in the issue.

## What's already in the GitHub issue body

comment, URL, branch/version, viewport, CSS selector, position, CSS framework,
computed styles, element `outerHTML`, full context JSON, session history.

## MCP server

- URL: `https://feedback.emergent-company.ai/mcp` (streamable HTTP)
- Auth: `Authorization: Bearer <api-key>` — a **repo-scoped** key. The key
  covers one or more repos; tools only return data for repos the key covers.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `feedback_list_for_issue` | `issue_number` | feedback items (id, selector, url, comment, has_screenshot, has_snapshot) |
| `feedback_get_snapshot` | `feedback_id` | redacted full-page DOM (HTML) |
| `feedback_get_screenshot` | `feedback_id` | element screenshot (base64 PNG) |
| `feedback_get_context` | `feedback_id` | captured context JSON |

## Workflow

1. Get the GitHub issue number (from the issue URL/title).
2. `feedback_list_for_issue(issue_number)` → feedback ids + which have a
   snapshot/screenshot.
3. For each id, call `feedback_get_context` / `feedback_get_screenshot` /
   `feedback_get_snapshot` to pull the full data.

## Configuring the MCP client

opencode (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "emergent-feedback": {
      "type": "remote",
      "url": "https://feedback.emergent-company.ai/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

The api-key is a `fo_`-prefixed token (e.g. from `FEEDBACK_OVERLAY_API_KEY` in
the consuming app's `.env`). Generate/revoke keys in the panel at
`https://feedback.emergent-company.ai/panel`.

## Notes

- Snapshot is **redacted** — `<script>`/`<style>`/`<iframe>` removed, typed
  input/textarea/contenteditable values cleared, token-like attributes and URL
  query params stripped. It is gzipped in storage and served decompressed.
- Screenshot is best-effort (`html2canvas`); cross-origin images may render blank.
- No secret is ever embedded in the issue body — always fetch via MCP.
