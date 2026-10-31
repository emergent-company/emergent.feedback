// config.ts — reads configuration from the <script> tag's data-* attributes.

export interface OverlayConfig {
  /** Base URL of the emergent.feedback API server. */
  apiBase: string;
  /** GitHub repo in "owner/repo" format. */
  repo: string;
  /** GitHub issue label to apply. Defaults to "feedback". */
  label: string;
  /**
   * Hotkey combination to activate the overlay.
   * Supported values: "alt+shift" (default), "ctrl+shift", "meta+shift".
   * Set via data-hotkey on the <script> tag.
   */
  hotkey: "alt+shift" | "ctrl+shift" | "meta+shift";
  /** Git branch being tested. Set via data-branch on the <script> tag. */
  branch?: string;
  /** App version being tested. Set via data-version on the <script> tag. */
  version?: string;
  /** Environment name (e.g. staging, production). Set via data-environment. */
  environment?: string;
  /** Static app session/trace ID injected server-side via data-session-id. */
  sessionId?: string;
  /** CSS selector to read a trace ID from the DOM via data-session-id-selector. */
  sessionIdSelector?: string;
  /**
   * Opt-in buffered session replay. Set via data-replay on the <script> tag.
   * Defaults to false (no recording).
   */
  replay: boolean;
  /** Replay buffer window in ms. Set via data-replay-buffer-ms (default 60000). */
  replayBufferMs?: number;
  /** Explicit URL for the lazy replay bundle. Set via data-replay-src. */
  replaySrc?: string;
  /**
   * Page-identity mode for badges and feedback. `"exact"` (default) keys
   * items by the full URL, including the fragment. `"path"` drops the
   * fragment so `/#how` and `/` share the same badges. Set via
   * data-badge-url-mode.
   */
  badgeUrlMode?: "exact" | "path";
  /**
   * Link target for the top-bar "Dashboard" action. Set via
   * data-dashboard-url. Defaults to `${apiBase}/panel`.
   */
  dashboardUrl?: string;
  /**
   * Opt-in full text masking for replay. When set (data-replay-mask-text), all
   * page text is masked (not just inputs + `[data-fo-redact]` + `.fo-block`).
   * Defaults to false — by default page text IS captured so replays stay useful.
   */
  replayMaskText: boolean;
  /**
   * Theme for the injected overlay UI. Set via data-theme on the <script> tag.
   * `"auto"` (default) detects the host page theme, then the OS preference.
   */
  theme?: "light" | "dark" | "auto";
  /**
   * Optional project-hosted theme-token endpoint (`data-theme-url`). Supplies
   * the live style editor's token groups. When absent/unreachable the client
   * falls back to daisyUI CSS variables read from the host document.
   */
  themeUrl?: string;
  /**
   * Opt-in AI chat tab (`data-chat`). The chat is a report composer: it turns a
   * conversation plus the captured element context into feedback fields. It
   * never edits the page or the repository. Off by default.
   */
  chat: boolean;
  /** Optional Memory agent name/id hint sent with each chat turn. */
  chatAgent?: string;
}

function getScriptTag(): HTMLScriptElement | null {
  // currentScript works when the script is first evaluated.
  if (document.currentScript instanceof HTMLScriptElement) {
    return document.currentScript;
  }
  // Fallback: find by src containing "emergent-feedback".
  return document.querySelector<HTMLScriptElement>(
    'script[src*="emergent-feedback"]'
  );
}

export function readConfig(): OverlayConfig {
  const tag = getScriptTag();
  const apiBase =
    tag?.dataset.api?.replace(/\/$/, "") ?? "https://feedback.emergent-company.ai";
  const repo = tag?.dataset.repo ?? "";
  const label = tag?.dataset.label ?? "feedback";
  const rawHotkey = tag?.dataset.hotkey?.toLowerCase() ?? "";
  const VALID_HOTKEYS = ["alt+shift", "ctrl+shift", "meta+shift"] as const;
  const hotkey: OverlayConfig["hotkey"] =
    (VALID_HOTKEYS as readonly string[]).includes(rawHotkey)
      ? (rawHotkey as OverlayConfig["hotkey"])
      : "alt+shift";

  if (!repo) {
    console.warn("[emergent.feedback] data-repo is not set on the <script> tag.");
  }

  const branch = tag?.dataset.branch?.trim() || undefined;
  const version = tag?.dataset.version?.trim() || undefined;
  const environment = tag?.dataset.environment?.trim() || undefined;
  const sessionId = tag?.dataset.sessionId?.trim() || undefined;
  const sessionIdSelector = tag?.dataset.sessionIdSelector?.trim() || undefined;

  // Opt-in replay: presence of data-replay enables it; data-replay="false" disables.
  const replay = tag?.dataset.replay !== undefined && tag?.dataset.replay !== "false";
  const rawReplayBufferMs = tag?.dataset.replayBufferMs?.trim();
  const parsedReplayBufferMs = rawReplayBufferMs ? parseInt(rawReplayBufferMs, 10) : NaN;
  const replayBufferMs =
    Number.isFinite(parsedReplayBufferMs) && parsedReplayBufferMs > 0
      ? parsedReplayBufferMs
      : undefined;
  const replaySrc = tag?.dataset.replaySrc?.trim() || undefined;
  const replayMaskText =
    tag?.dataset.replayMaskText !== undefined && tag?.dataset.replayMaskText !== "false";

  const rawTheme = tag?.dataset.theme?.toLowerCase() ?? "";
  const theme: OverlayConfig["theme"] =
    rawTheme === "light" || rawTheme === "dark" ? rawTheme : "auto";

  const themeUrl = tag?.dataset.themeUrl?.trim() || undefined;

  // Opt-in chat tab: presence of data-chat enables it; data-chat="false" disables.
  const chat = tag?.dataset.chat !== undefined && tag?.dataset.chat !== "false";
  const chatAgent = tag?.dataset.chatAgent?.trim() || undefined;

  const badgeUrlMode: NonNullable<OverlayConfig["badgeUrlMode"]> =
    tag?.dataset.badgeUrlMode?.trim().toLowerCase() === "path" ? "path" : "exact";
  const dashboardUrl = tag?.dataset.dashboardUrl?.trim() || `${apiBase}/panel`;

  return {
    apiBase,
    repo,
    label,
    hotkey,
    branch,
    version,
    environment,
    sessionId,
    sessionIdSelector,
    replay,
    ...(replayBufferMs !== undefined ? { replayBufferMs } : {}),
    ...(replaySrc !== undefined ? { replaySrc } : {}),
    replayMaskText,
    theme,
    ...(themeUrl !== undefined ? { themeUrl } : {}),
    chat,
    ...(chatAgent !== undefined ? { chatAgent } : {}),
    badgeUrlMode,
    dashboardUrl,
  };
}
