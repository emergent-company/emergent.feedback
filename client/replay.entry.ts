// replay.entry.ts — entry point for the SECOND (lazy) replay bundle.
//
// Bundled as an IIFE with global name `EmergentFeedbackReplay`. It imports the
// rrweb-dependent core and exposes a tiny global API that the main bundle's
// loader (`src/replay.ts`) drives via `window.__EF_REPLAY__`.

import { startReplay, stopReplay, getReplayPayloadAsync } from "./src/replay-core";

interface ReplayAPI {
  start: (bufferMs?: number, maskText?: boolean) => void;
  stop: () => void;
  getPayloadAsync: () => Promise<string | undefined>;
}

(window as unknown as { __EF_REPLAY__?: ReplayAPI }).__EF_REPLAY__ = {
  start: startReplay,
  stop: stopReplay,
  getPayloadAsync: getReplayPayloadAsync,
};
