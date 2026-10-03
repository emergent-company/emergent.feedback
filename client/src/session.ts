// session.ts — overlay-minted session ID for cross-feedback correlation.

const KEY = "__ef_session_id__";

let id: string | null = null;

function generateId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getSessionId(): string {
  if (id) return id;
  try {
    id = sessionStorage.getItem(KEY);
  } catch {
    // sessionStorage unavailable (privacy mode); fall through to ephemeral.
  }
  if (!id) {
    id = generateId();
    try {
      sessionStorage.setItem(KEY, id);
    } catch {
      // ignore — ephemeral session ID is fine.
    }
  }
  return id;
}
