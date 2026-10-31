// url.ts — page-identity helpers shared by the overlay and the API client.

export type UrlMode = "exact" | "path";

/**
 * Normalise a page URL for badge lookup and feedback storage.
 *
 * `exact` keeps the URL untouched. `path` drops the fragment so anchor
 * navigation (`/#how`) does not split a page into separate badge buckets.
 * Query strings are preserved: they often select real app state.
 */
export function normalizeUrl(raw: string, mode: UrlMode): string {
  if (mode !== "path") return raw;

  try {
    const base =
      typeof window !== "undefined" && window.location?.href
        ? window.location.href
        : undefined;
    const u = base ? new URL(raw, base) : new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    // Very old browsers / non-absolute input without a location: fall back to
    // the simple string operation, which is still correct for fragments.
    const i = raw.indexOf("#");
    return i >= 0 ? raw.slice(0, i) : raw;
  }
}

/** The current page URL under the configured matching mode. */
export function pageUrl(mode: UrlMode): string {
  if (typeof window === "undefined") return "";
  return normalizeUrl(window.location.href, mode);
}
