// labels.ts — human-readable element labels for report and issue titles.
// Prefer the component the element belongs to; fall back to the selector.

/** The captured-context fields used to name an element. */
export interface LabelContext {
  dataComponent?: unknown;
  source?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Best component name for a captured element:
 * framework component (React/Vue/Svelte, or the nearest `data-component`
 * via the source fallback) → nearest `dataComponent` segment → undefined.
 */
export function componentName(ctx: LabelContext): string | undefined {
  const src = ctx.source;
  if (src && typeof src === "object") {
    const name = str((src as { component?: unknown }).component);
    // Single-character names are almost always minified production React names.
    if (name.length > 1) return name;
  }
  const path = str(ctx.dataComponent);
  if (path) {
    // Overlay paths are "Component > tag > tag", so the component is the first
    // segment. Other senders may emit a component hierarchy; the first segment
    // is still the outermost component and never an HTML tag.
    const segment = path.split(">")[0]?.trim();
    if (segment) return segment;
  }
  return undefined;
}

/** Component when known, else the last segment of the CSS selector. */
export function elementLabel(ctx: LabelContext, selector: string): string {
  return componentName(ctx) ?? (selector.split(">").pop()?.trim() || selector);
}

/** Default "Report title" shown in the overlay. */
export function buildDefaultIssueTopic(
  ctx: LabelContext,
  selector: string,
  existingCount: number
): string {
  const label = elementLabel(ctx, selector);
  return existingCount > 0
    ? `Feedback: ${existingCount + 1} comments on ${label}`
    : `Feedback on ${label}`;
}
