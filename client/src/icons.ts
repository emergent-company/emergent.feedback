// icons.ts — inlined SVG glyphs for the style editor's "icons" render mode.
//
// The overlay bundle is self-contained (html2canvas + rrweb only), so these
// glyphs are inline SVG path data: no icon font, no network, no iconify.
// Figma's own icon assets are proprietary and are NOT used. Glyph metaphors
// after Lucide, ISC (https://lucide.dev); redrawn here as stroke-only paths
// (fill none, stroke currentColor) so they inherit the panel text color.

/** A validated glyph: a 24×24 viewBox and a list of `<path>` `d` strings. */
export interface GlyphIcon {
  viewBox: string;
  paths: string[];
}

const V = "0 0 24 24";

/**
 * All glyphs are stroke-drawn (fill none, stroke currentColor, round caps) at
 * ~1.6px. `paths` entries only ever contain SVG path commands, digits and
 * whitespace, so they are safe to interpolate into `d="…"` markup.
 */
export const ICONS: Record<string, GlyphIcon> = Object.freeze({
  // ── align-items (items on the cross axis) ──────────────────────────────────
  "align-start": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 7 H17", "M7 9.5 H17", "M7 12 H17"] },
  "align-center": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 10 H17", "M7 12.5 H17", "M7 15 H17"] },
  "align-end": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 13 H17", "M7 15.5 H17", "M7 18 H17"] },
  "align-stretch": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 6 V18", "M11 6 V18", "M15 6 V18"] },
  "align-baseline": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 9 V17", "M11 13 V17", "M15 6 V17", "M6 17 H18"] },

  // ── justify-content (items on the main axis) ───────────────────────────────
  "justify-start": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 7 V17", "M9.5 7 V17", "M12 7 V17"] },
  "justify-center": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M9.5 7 V17", "M12 7 V17", "M14.5 7 V17"] },
  "justify-end": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M13 7 V17", "M15.5 7 V17", "M18 7 V17"] },
  "justify-between": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M5.5 7 V17", "M12 7 V17", "M18.5 7 V17"] },
  "justify-around": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7.5 7 V17", "M12 7 V17", "M16.5 7 V17"] },
  "justify-evenly": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 7 V17", "M10.5 7 V17", "M14 7 V17", "M17.5 7 V17"] },

  // ── flex-direction ─────────────────────────────────────────────────────────
  "flex-row": { viewBox: V, paths: ["M5 12 H17", "M13 8 L17 12 L13 16"] },
  "flex-row-reverse": { viewBox: V, paths: ["M19 12 H7", "M11 8 L7 12 L11 16"] },
  "flex-col": { viewBox: V, paths: ["M12 5 V17", "M8 13 L12 17 L16 13"] },
  "flex-col-reverse": { viewBox: V, paths: ["M12 19 V7", "M8 11 L12 7 L16 11"] },

  // ── flex-wrap ──────────────────────────────────────────────────────────────
  "nowrap": { viewBox: V, paths: ["M4 12 H18", "M14 8 L18 12 L14 16"] },
  "wrap": { viewBox: V, paths: ["M4 7 H17", "M17 7 C17 11 15 13 12 13", "M12 13 H4"] },
  "wrap-reverse": { viewBox: V, paths: ["M4 17 H17", "M17 17 C17 13 15 11 12 11", "M12 11 H4"] },

  // ── display ────────────────────────────────────────────────────────────────
  "display-block": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M7 9 H17"] },
  "display-inline": { viewBox: V, paths: ["M3 12 H7", "M7 8 H17 V16 H7 Z", "M17 12 H21"] },
  "display-inline-block": { viewBox: V, paths: ["M3 12 H7", "M7 6 H17 V18 H7 Z", "M17 12 H21", "M10 10 H14", "M10 14 H14"] },
  "display-flex": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M7 9 V15", "M11 9 V15", "M15 9 V15"] },
  "display-inline-flex": { viewBox: V, paths: ["M3 12 H5", "M5 5 H19 V19 H5 Z", "M8 9 V15", "M12 9 V15", "M16 9 V15", "M19 12 H21"] },
  "display-grid": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M12 5 V19", "M4 12 H20"] },
  "display-hidden": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M4 19 L20 5"] },

  // ── text-align ─────────────────────────────────────────────────────────────
  "text-left": { viewBox: V, paths: ["M4 7 H18", "M4 12 H14", "M4 17 H16"] },
  "text-center": { viewBox: V, paths: ["M7 7 H17", "M9 12 H15", "M8 17 H16"] },
  "text-right": { viewBox: V, paths: ["M6 7 H20", "M10 12 H20", "M8 17 H20"] },
  "text-justify": { viewBox: V, paths: ["M4 7 H20", "M4 12 H20", "M4 17 H20"] },

  // ── align-self ─────────────────────────────────────────────────────────────
  "self-auto": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M8 12 H10", "M12 12 H14", "M16 12 H18"] },
  "self-start": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 7 H17"] },
  "self-center": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 12 H17"] },
  "self-end": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M7 17 H17"] },
  "self-stretch": { viewBox: V, paths: ["M4 4 H20 V20 H4 Z", "M11 6 V18"] },

  // ── position ───────────────────────────────────────────────────────────────
  "position-static": { viewBox: V, paths: ["M5 6 H19 V18 H5 Z"] },
  "position-relative": { viewBox: V, paths: ["M5 6 H19 V18 H5 Z", "M17 17 L20 20", "M17 20 L20 20 L20 17"] },
  "position-absolute": { viewBox: V, paths: ["M9 9 H19 V19 H9 Z", "M9 9 H5", "M9 9 V5"] },
  "position-fixed": { viewBox: V, paths: ["M7 7 H17 V17 H7 Z", "M4 9 V4 H9", "M15 4 H20 V9", "M20 15 V20 H15", "M9 20 H4 V15"] },
  "position-sticky": { viewBox: V, paths: ["M4 5 H20", "M6 9 H18 V19 H6 Z"] },

  // ── inset (pin) ────────────────────────────────────────────────────────────
  "pin-inset": { viewBox: V, paths: ["M3 5 H21 V19 H3 Z", "M7 9 H17 V15 H7 Z"] },
  "pin-top": { viewBox: V, paths: ["M3 5 H21 V19 H3 Z", "M5 6 H19 V8.5 H5 Z"] },
  "pin-right": { viewBox: V, paths: ["M3 5 H21 V19 H3 Z", "M15.5 6 H19 V18 H15.5 Z"] },
  "pin-bottom": { viewBox: V, paths: ["M3 5 H21 V19 H3 Z", "M5 15.5 H19 V18 H5 Z"] },
  "pin-left": { viewBox: V, paths: ["M3 5 H21 V19 H3 Z", "M5 6 H8.5 V18 H5 Z"] },

  // ── font-weight (letter T, bar thickness = weight) ─────────────────────────
  "weight-thin": { viewBox: V, paths: weightGlyph(1) },
  "weight-extralight": { viewBox: V, paths: weightGlyph(2) },
  "weight-light": { viewBox: V, paths: weightGlyph(3) },
  "weight-normal": { viewBox: V, paths: weightGlyph(4) },
  "weight-medium": { viewBox: V, paths: weightGlyph(5) },
  "weight-semibold": { viewBox: V, paths: weightGlyph(6) },
  "weight-bold": { viewBox: V, paths: weightGlyph(7) },
  "weight-extrabold": { viewBox: V, paths: weightGlyph(8) },
  "weight-black": { viewBox: V, paths: weightGlyph(9) },

  // ── border-radius (one rounded corner, increasing radius) ──────────────────
  "radius-none": { viewBox: V, paths: [cornerRadius(0)] },
  "radius-sm": { viewBox: V, paths: [cornerRadius(3)] },
  "radius-md": { viewBox: V, paths: [cornerRadius(5)] },
  "radius-lg": { viewBox: V, paths: [cornerRadius(7)] },
  "radius-xl": { viewBox: V, paths: [cornerRadius(9)] },
  "radius-2xl": { viewBox: V, paths: [cornerRadius(11)] },
  "radius-3xl": { viewBox: V, paths: [cornerRadius(13)] },
  "radius-full": { viewBox: V, paths: ["M12 5 a7 7 0 1 0 0 14 a7 7 0 1 0 0 -14"] },

  // ── border-width (nested square, thickness = inset of inner square) ────────
  "border-0": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M4 19 L20 5"] },
  "border-1": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M5 6 H19 V18 H5 Z"] },
  "border-2": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M7 8 H17 V16 H7 Z"] },
  "border-4": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M9 10 H15 V14 H9 Z"] },
  "border-8": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M11 11 H13 V13 H11 Z"] },

  // ── border-style (bottom edge solid / dashed / dotted) ─────────────────────
  "stroke-solid": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z"] },
  "stroke-dashed": {
    viewBox: V,
    paths: [
      "M4 5 H8", "M10 5 H14", "M16 5 H20",
      "M20 7 V11", "M20 13 V17",
      "M4 7 V11", "M4 13 V17",
      "M4 19 H8", "M10 19 H14", "M16 19 H20",
    ],
  },
  "stroke-dotted": {
    viewBox: V,
    paths: [
      "M5 5 h0.01", "M9 5 h0.01", "M13 5 h0.01", "M17 5 h0.01", "M20 5 h0.01",
      "M20 9 h0.01", "M20 13 h0.01", "M20 17 h0.01", "M20 19.5 h0.01",
      "M5 19 h0.01", "M9 19 h0.01", "M13 19 h0.01", "M17 19 h0.01",
      "M4 9 h0.01", "M4 13 h0.01", "M4 17 h0.01", "M4 19.5 h0.01",
    ],
  },

  // ── box-shadow (offset square behind the element) ──────────────────────────
  "shadow-none": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M4 17 L16 5"] },
  "shadow-sm": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M6 7 H18 V19 H6 Z"] },
  "shadow-md": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M7 8 H19 V20 H7 Z"] },
  "shadow-lg": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M8 9 H20 V21 H8 Z"] },
  "shadow-xl": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M9 10 H21 V22 H9 Z"] },
  "shadow-2xl": { viewBox: V, paths: ["M4 5 H16 V17 H4 Z", "M10 11 H22 V23 H10 Z"] },

  // ── object-fit ─────────────────────────────────────────────────────────────
  "object-cover": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18"] },
  "object-contain": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M12 6 a6 6 0 1 0 0 12 a6 6 0 1 0 0 -12"] },
  "object-fill": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M4 12 A8 7 0 0 1 20 12 A8 7 0 0 1 4 12"] },
  "object-none": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M12 9 a3 3 0 1 0 0 6 a3 3 0 1 0 0 -6"] },
  "object-scale-down": { viewBox: V, paths: ["M4 5 H20 V19 H4 Z", "M12 7 a5 5 0 1 0 0 10 a5 5 0 1 0 0 -10", "M12 9 V14", "M9 12 L12 14 L15 12"] },

  // ── Default / unset (circled slash) ────────────────────────────────────────
  "unset": { viewBox: V, paths: ["M12 4 a8 8 0 1 0 0 16 a8 8 0 1 0 0 -16", "M6 18 L18 6"] },

  // ── Disclosure chevrons (section headers, select triggers) ─────────────────
  "chevron-right": { viewBox: V, paths: ["M9.5 6 L15.5 12 L9.5 18"] },
  "chevron-down": { viewBox: V, paths: ["M6 9.5 L12 15.5 L18 9.5"] },
});

/** Look up a glyph by `<prefix>-<id>` (empty prefix → the id itself). */
export function iconID(prefix: string, id: string): GlyphIcon {
  return ICONS[prefix ? `${prefix}-${id}` : id];
}

/**
 * Letter "T" whose top bar is drawn as `n` stacked strokes — encodes font
 * weight as the thickness of the bar (thin → black).
 */
function weightGlyph(n: number): string[] {
  const paths = ["M12 6 V18"];
  for (let i = 0; i < n; i++) {
    paths.push(`M7 ${((65 + 14 * i) / 10).toFixed(1)} H17`);
  }
  return paths;
}

/** Square with a single rounded corner (bottom-right), radius `r`. */
function cornerRadius(r: number): string {
  if (r <= 0) return "M4 5 H20 V19 H4 Z";
  return `M4 5 H20 V${19 - r} A${r} ${r} 0 0 1 ${20 - r} 19 H4 Z`;
}
