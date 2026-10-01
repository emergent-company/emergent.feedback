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

  return {
    apiBase,
    repo,
    label,
    hotkey,
    branch,
    version,
    sessionId,
    sessionIdSelector,
    replay,
    ...(replayBufferMs !== undefined ? { replayBufferMs } : {}),
  };
}
