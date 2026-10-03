// replay.ts — thin lazy loader for the rrweb replay bundle.
//
// The main bundle imports this loader instead of rrweb directly. When replay
// is enabled, `startReplay` injects a <script> tag for the SECOND bundle
// (`emergent-feedback-replay.js`), awaits its load, then delegates to
// `window.__EF_REPLAY__`. rrweb is therefore only fetched/executed when replay
// is enabled, keeping it out of the main overlay bundle entirely.

type ReplayAPI = {
  start: (bufferMs?: number, maskText?: boolean) => void;
  stop: () => void;
  getPayloadAsync: () => Promise<string | undefined>;
};

/** Main bundle URL captured at module init (currentScript is still valid here). */
const MAIN_SRC = (() => {
  try {
    const cs = document.currentScript as HTMLScriptElement | null;
    return cs?.src || "";
  } catch {
    return "";
  }
})();

let loaded = false;
let loading: Promise<boolean> | null = null;
let warned = false;

/** Swap `emergent-feedback.js` → `emergent-feedback-replay.js`, preserving query/hash. */
function deriveReplaySrc(mainSrc: string): string {
  if (!mainSrc) return "";
  const next = mainSrc.replace(
    /emergent-feedback\.js([?#].*)?$/,
    "emergent-feedback-replay.js$1"
  );
  return next === mainSrc ? "" : next;
}

function api(): ReplayAPI | undefined {
  return (window as unknown as { __EF_REPLAY__?: ReplayAPI }).__EF_REPLAY__;
}

/** Ensure the replay bundle is loaded; resolves true on success, false on failure. */
async function ensureLoaded(replaySrc?: string): Promise<boolean> {
  if (loaded || api()) {
    loaded = true;
    return true;
  }
  if (loading) return loading;

  loading = (async (): Promise<boolean> => {
    try {
      const src = (replaySrc && replaySrc.trim()) || deriveReplaySrc(MAIN_SRC);
      if (!src) throw new Error("cannot resolve replay bundle URL");
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("replay bundle failed to load"));
        (document.head || document.documentElement).appendChild(s);
      });
      if (!api()) throw new Error("replay API not exposed by bundle");
      loaded = true;
      return true;
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn("[emergent.feedback] session replay unavailable:", e);
      }
      return false;
    }
  })();

  return loading;
}

/**
 * Start buffering. Loads the replay bundle on demand (idempotent) and delegates
 * to it. Never throws; replay is simply unavailable if the bundle fails.
 */
export async function startReplay(bufferMs?: number, replaySrc?: string, maskText?: boolean): Promise<void> {
  const ok = await ensureLoaded(replaySrc);
  if (!ok) return;
  try {
    api()?.start(bufferMs, maskText);
  } catch {
    // no-op
  }
}

/** Stop recording. No-op if the replay bundle is not loaded. */
export function stopReplay(): void {
  try {
    api()?.stop();
  } catch {
    // no-op
  }
}

/**
 * Upload payload. Delegates to the loaded bundle; returns undefined when the
 * bundle is not (yet) loaded, matching the "replay unavailable" case.
 */
export async function getReplayPayloadAsync(): Promise<string | undefined> {
  const a = api();
  if (!a) return undefined;
  try {
    return await a.getPayloadAsync();
  } catch {
    return undefined;
  }
}
