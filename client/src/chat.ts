// chat.ts — the Chat tab.
//
// Scope, by design: the chat is a REPORT COMPOSER. It talks to the Memory agent
// through the feedback server's proxy and turns the conversation into the
// feedback fields that already exist (title, type, action, expected, actual,
// scope, comment). It never edits the page, never applies a style token, and
// never writes to the repository — the overlay's own edit primitives are not
// reachable from here.
//
// The agent reply is plain text plus one fenced ```json report block. That
// block is untrusted input: it is parsed, validated against closed enums and
// length-capped before it can touch a form field.

import type { APIClient, ChatMessage } from "./api";
import { sanitizeURL } from "./redact";

/** Local escaper so this module stays free of a cycle with dialog.ts. */
function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The report fields the agent may propose. */
export interface ReportSuggestion {
  title?: string;
  type: "bug" | "enhancement";
  action: "change" | "add" | "remove" | "move" | "fix" | "refactor" | "investigate";
  expected?: string;
  actual?: string;
  scope?: { breadth: "element" | "region" | "multi" };
  comment?: string;
  /** What the agent still needs to know; rendered, never auto-filled. */
  missing?: string[];
}

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  text: string;
  /** Parsed + validated report proposal attached to an assistant turn. */
  report?: ReportSuggestion;
  /** The turn failed; text carries the message. */
  error?: boolean;
}

const REPORT_TYPES = ["bug", "enhancement"] as const;
const REPORT_ACTIONS = [
  "change",
  "add",
  "remove",
  "move",
  "fix",
  "refactor",
  "investigate",
] as const;
const REPORT_BREADTHS = ["element", "region", "multi"] as const;

const MAX_TITLE = 140;
const MAX_FIELD = 600;
const MAX_COMMENT = 4000;
const MAX_TURNS = 24;
const MAX_MISSING = 5;

const CHAT_KEY = "__ef_chat__";

function clip(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Validate a report block from the agent.
 *
 * Anything outside the closed enums is dropped rather than coerced: a bad
 * `type` must not silently become "enhancement". `type` and `action` are the
 * only required members, so a partially usable proposal still fills what it
 * can.
 */
export function validateReport(raw: unknown): ReportSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const type = oneOf(r.type, REPORT_TYPES);
  const action = oneOf(r.action, REPORT_ACTIONS);
  if (!type || !action) return null;

  const out: ReportSuggestion = { type, action };

  const title = clip(r.title, MAX_TITLE);
  if (title) out.title = title;
  const expected = clip(r.expected, MAX_FIELD);
  if (expected) out.expected = expected;
  const actual = clip(r.actual, MAX_FIELD);
  if (actual) out.actual = actual;
  const comment = clip(r.comment, MAX_COMMENT);
  if (comment) out.comment = comment;

  if (r.scope && typeof r.scope === "object" && !Array.isArray(r.scope)) {
    const breadth = oneOf((r.scope as Record<string, unknown>).breadth, REPORT_BREADTHS);
    if (breadth) out.scope = { breadth };
  }

  if (Array.isArray(r.missing)) {
    const missing = r.missing
      .map((m) => clip(m, 200))
      .filter((m): m is string => !!m)
      .slice(0, MAX_MISSING);
    if (missing.length > 0) out.missing = missing;
  }

  return out;
}

/** Strip fenced code blocks from the prose so the JSON is not shown twice. */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, "").trim();
}

/**
 * Pull the last fenced ```json block out of an agent reply and validate it.
 * The agent may also emit the object bare; both shapes are accepted, but only
 * a well-formed object survives validation.
 */
export function extractReport(reply: string): { prose: string; report: ReportSuggestion | null } {
  const text = reply ?? "";
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) blocks.push(m[1]);

  let report: ReportSuggestion | null = null;
  for (let i = blocks.length - 1; i >= 0 && !report; i--) {
    try {
      const parsed = JSON.parse(blocks[i].trim()) as Record<string, unknown>;
      const candidate = parsed && typeof parsed === "object" ? parsed.report ?? parsed : null;
      report = validateReport(candidate);
    } catch {
      // Not JSON — ignore and keep looking at earlier blocks.
    }
  }

  // Fallback: an unfenced object at the end of the reply.
  if (!report) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        report = validateReport(parsed.report ?? parsed);
      } catch {
        // Not JSON either: prose only.
      }
    }
  }

  return { prose: blocks.length > 0 ? stripFences(text) : text.trim(), report };
}

/** Fields the Chat tab may receive from the dialog. */
export interface ChatContextInput {
  selector: string;
  url: string;
  tagName?: string;
  dataComponent?: string;
  source?: { file?: string; line?: number; component?: string; confidence?: string };
  computedStyles?: Record<string, string>;
  changes?: { group: string; before?: string; after: string }[];
  targetCount?: number;
}

const CONTEXT_STYLES = [
  "display",
  "position",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "padding",
  "margin",
  "borderRadius",
] as const;

/**
 * Build the context object sent with a chat turn.
 *
 * This is the redaction boundary. It deliberately excludes `outerHTML`,
 * snapshots, replay, session history and the user agent: the agent composes a
 * report, so it needs the element identity and the shape of the problem, not a
 * DOM dump.
 */
export function buildChatContext(input: ChatContextInput): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    selector: input.selector,
    url: sanitizeURL(input.url),
  };
  if (input.tagName) ctx.tagName = input.tagName.toLowerCase();
  if (input.dataComponent) ctx.component = input.dataComponent;
  if (input.source?.file) {
    ctx.source = {
      file: input.source.file,
      ...(typeof input.source.line === "number" ? { line: input.source.line } : {}),
      ...(input.source.component ? { component: input.source.component } : {}),
      ...(input.source.confidence ? { confidence: input.source.confidence } : {}),
    };
  }
  if (input.computedStyles) {
    const styles: Record<string, string> = {};
    for (const key of CONTEXT_STYLES) {
      const v = input.computedStyles[key];
      if (typeof v === "string" && v) styles[key] = v;
    }
    if (Object.keys(styles).length > 0) ctx.computedStyles = styles;
  }
  if (input.changes && input.changes.length > 0) {
    ctx.changes = input.changes.slice(0, 20).map((c) => ({
      group: clip(c.group, 40) ?? "style",
      before: clip(c.before, 160) ?? "",
      after: clip(c.after, 160) ?? "",
    }));
  }
  if (input.targetCount && input.targetCount > 1) ctx.targetCount = input.targetCount;
  return ctx;
}

// ── Transcript persistence (same selector-scoped pattern as drafts) ──────────
// Only the conversation is stored: never the context object. The key uses the
// sanitised URL so a token in the query string never reaches storage.

function storageKey(selector: string): string {
  const url = typeof window !== "undefined" ? sanitizeURL(window.location.href) : "";
  return `${CHAT_KEY}:${url}|${selector}`;
}

export function loadChat(selector: string): ChatTurn[] {
  try {
    const raw = localStorage.getItem(storageKey(selector));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is ChatTurn =>
        !!t && typeof t === "object" &&
        ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant") &&
        typeof (t as ChatTurn).text === "string"
      )
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

export function saveChat(selector: string, turns: ChatTurn[]): void {
  try {
    if (turns.length === 0) localStorage.removeItem(storageKey(selector));
    else localStorage.setItem(storageKey(selector), JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    // Storage is best-effort; a full quota must not break the dialog.
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

export interface ChatPanelOptions {
  api: APIClient;
  repo: string;
  agent?: string;
  /** Capture context, reduced by buildChatContext. Re-read per turn. */
  getContext: () => Record<string, unknown>;
  /** Compact human summary for the context strip, re-read per render. */
  getSummary: () => { selector: string; pendingChanges: number };
  getTurns: () => ChatTurn[];
  setTurns: (turns: ChatTurn[]) => void;
  /** Fill the Feedback tab from a validated proposal. */
  onUseReport: (report: ReportSuggestion) => void;
}

export interface ChatPanel {
  render: () => void;
  destroy: () => void;
  isBusy: () => boolean;
}

const SUGGESTIONS = [
  "This button doesn't stand out enough",
  "The text is wrong",
  "Explain what changed here",
];

/** Mount the Chat tab into `host`. Returns controls the dialog can drive. */
export function mountChat(host: HTMLElement, opts: ChatPanelOptions): ChatPanel {
  let busy = false;
  let controller: AbortController | null = null;

  const render = (): void => {
    const turns = opts.getTurns();
    const summary = opts.getSummary();
    const logHTML = turns.length === 0
      ? `<div class="ef-chat-empty">
           <p class="ef-chat-empty-title">Describe the change you want.</p>
           <p class="ef-chat-empty-sub">I'll write the report — title, type, what you expected and what is wrong. I don't edit the page.</p>
           <div class="ef-chat-suggest">
             ${SUGGESTIONS.map((s) => `<button type="button" class="ef-chip" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
           </div>
         </div>`
      : turns.map((t, i) => turnHTML(t, i)).join("");

    host.innerHTML = `
      <div class="ef-chat-ctx">
        <span class="ef-chat-ctx-label">Context</span>
        <span class="ef-chat-ctx-sel" title="${escapeHtml(summary.selector)}">${escapeHtml(summary.selector)}</span>
        <span class="ef-chat-ctx-meta">${summary.pendingChanges > 0
          ? `${summary.pendingChanges} pending change${summary.pendingChanges === 1 ? "" : "s"}`
          : "no pending changes"} · redacted</span>
      </div>
      <div class="ef-chat-log" id="__ef_chat_log__" role="log" aria-live="polite" aria-label="Chat transcript">${logHTML}</div>
      <div class="ef-chat-compose">
        <label class="ef-sr-only" for="__ef_chat_input__">Message the report agent</label>
        <textarea id="__ef_chat_input__" rows="2" placeholder="Ask the agent to write the report…"></textarea>
        <div class="ef-chat-actions">
          <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_chat_clear__"${turns.length === 0 ? " disabled" : ""}>Clear</button>
          <button type="button" class="ef-btn-secondary ef-btn-sm" id="__ef_chat_stop__"${busy ? "" : " hidden"}>Stop</button>
          <button type="button" class="ef-btn-primary ef-btn-sm" id="__ef_chat_send__"${busy ? " disabled" : ""}>Send</button>
        </div>
      </div>
      <p class="ef-chat-note">Chat writes the report. It does not change the page or the repository.</p>`;

    wire();
    const log = host.querySelector<HTMLElement>("#__ef_chat_log__");
    if (log) log.scrollTop = log.scrollHeight;
  };

  const turnHTML = (t: ChatTurn, idx: number): string => {
    if (t.role === "user") {
      return `<div class="ef-chat-turn ef-chat-user"><div class="ef-chat-bubble">${escapeHtml(t.text)}</div></div>`;
    }
    const r = t.report;
    const report = r
      ? `<div class="ef-report-card">
           <div class="ef-report-card-head">Suggested report</div>
           <dl class="ef-report-fields">
             ${r.title ? `<dt>Title</dt><dd>${escapeHtml(r.title)}</dd>` : ""}
             <dt>Type</dt><dd>${escapeHtml(r.type)}</dd>
             <dt>Action</dt><dd>${escapeHtml(r.action)}</dd>
             ${r.expected ? `<dt>Expected</dt><dd>${escapeHtml(r.expected)}</dd>` : ""}
             ${r.actual ? `<dt>Actual</dt><dd>${escapeHtml(r.actual)}</dd>` : ""}
             ${r.scope ? `<dt>Scope</dt><dd>${escapeHtml(r.scope.breadth)}</dd>` : ""}
           </dl>
           ${r.missing && r.missing.length > 0
             ? `<p class="ef-report-missing">Still needed: ${r.missing.map((m) => escapeHtml(m)).join("; ")}</p>`
             : ""}
           <button type="button" class="ef-btn-primary ef-btn-sm" data-use-report="${idx}">Use as report</button>
         </div>`
      : "";
    return `<div class="ef-chat-turn ef-chat-assistant${t.error ? " ef-chat-error" : ""}">
        <div class="ef-chat-bubble">${escapeHtml(t.text).replace(/\n/g, "<br>")}</div>
        ${report}
      </div>`;
  };

  const wire = (): void => {
    const input = host.querySelector<HTMLTextAreaElement>("#__ef_chat_input__");
    const send = host.querySelector<HTMLButtonElement>("#__ef_chat_send__");
    const stop = host.querySelector<HTMLButtonElement>("#__ef_chat_stop__");
    const clear = host.querySelector<HTMLButtonElement>("#__ef_chat_clear__");

    const submit = (text: string): void => {
      const value = text.trim();
      if (!value || busy) return;
      void sendTurn(value);
    };

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit(input.value);
      }
    });
    send?.addEventListener("click", () => submit(input?.value ?? ""));
    stop?.addEventListener("click", () => {
      controller?.abort();
    });
    clear?.addEventListener("click", () => {
      if (busy) return;
      opts.setTurns([]);
      render();
    });
    host.querySelectorAll<HTMLButtonElement>("[data-suggest]").forEach((btn) => {
      btn.addEventListener("click", () => submit(btn.dataset.suggest ?? ""));
    });
    host.querySelectorAll<HTMLButtonElement>("[data-use-report]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.useReport ?? "-1", 10);
        const turn = opts.getTurns()[idx];
        if (turn?.report) opts.onUseReport(turn.report);
      });
    });
    input?.focus();
  };

  const sendTurn = async (text: string): Promise<void> => {
    const turns = [...opts.getTurns(), { role: "user" as const, text }];
    opts.setTurns(turns);
    busy = true;
    render();

    const assistant: ChatTurn = { role: "assistant", text: "" };
    opts.setTurns([...turns, assistant]);
    render();

    controller = new AbortController();
    let failed = false;
    let aborted = false;
    try {
      const messages: ChatMessage[] = opts
        .getTurns()
        .filter((t) => !t.error && t.text)
        .map((t) => ({ role: t.role, content: t.text }));
      await opts.api.streamChat(
        {
          repo: opts.repo,
          messages,
          context: opts.getContext(),
          ...(opts.agent ? { agent: opts.agent } : {}),
        },
        (ev) => {
          if (ev.type === "token") {
            assistant.text += ev.text;
          } else if (ev.type === "error") {
            failed = true;
            assistant.error = true;
            assistant.text = ev.message;
          }
          // Only re-render the live bubble, not the whole panel: re-rendering
          // would blur the composer mid-stream.
          paintStreaming(assistant.text, failed);
        },
        controller.signal
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        aborted = true;
      } else {
        failed = true;
        assistant.error = true;
        assistant.text = err instanceof Error ? err.message : "The agent stopped.";
      }
    } finally {
      busy = false;
      controller = null;
      if (!assistant.text) {
        // Stopping early is not a failure; say so instead of "no reply".
        assistant.error = !aborted;
        assistant.text = aborted ? "Stopped." : "No reply. Try again.";
      }
      const { prose, report } = extractReport(assistant.text);
      assistant.text = prose || (report ? "Here is a draft report." : assistant.text);
      if (report) assistant.report = report;
      opts.setTurns([...turns, assistant]);
      render();
    }
  };

  /** Cheap incremental paint of the in-flight assistant bubble. */
  const paintStreaming = (text: string, isError: boolean): void => {
    const log = host.querySelector<HTMLElement>("#__ef_chat_log__");
    if (!log) return;
    const last = log.lastElementChild as HTMLElement | null;
    if (!last || !last.classList.contains("ef-chat-assistant")) return;
    last.classList.toggle("ef-chat-error", isError);
    const bubble = last.querySelector<HTMLElement>(".ef-chat-bubble");
    if (bubble) bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    log.scrollTop = log.scrollHeight;
  };

  render();

  return {
    render,
    destroy: () => {
      controller?.abort();
      controller = null;
      busy = false;
    },
    isBusy: () => busy,
  };
}
