// envelope.ts — canonical AI-feedback payload types (Phase A).
//
// This is the SHARED CONTRACT between capture (client) and rendering (server).
// Field names here MUST match the Go envelope structs and the spec at
// docs/ai-feedback-strategy.md §2.2. Keep this file framework-agnostic and
// side-effect free (types + pure helpers only).

/** Where a value came from. Machine-readable honesty marker. */
export type Provenance = "captured" | "inferred" | "stated" | "absent";

/** How a DOM element was resolved to a source location. */
export type SourceResolution =
  | "build-stamp" // data-fo-src injected at compile time  → exact
  | "fiber" // React fiber _debugSource (dev)            → exact
  | "framework-meta" // Vue __file / Svelte metadata        → approximate
  | "dev-stamp" // react-dev-inspector / vue-inspector    → approximate
  | "none"; // no source info                           → none

export type SourceConfidence = "exact" | "approximate" | "none";

export interface SourceRef {
  component?: string;
  file?: string; // repo-relative where possible
  line?: number;
  column?: number;
  framework?: string;
  resolution: SourceResolution;
  confidence: SourceConfidence;
}

export interface ElementFingerprint {
  attrs: Record<string, string>;
  path: string; // "main > section > div > button"
  text?: string;
}

export interface ElementRef {
  tag: string;
  role?: string;
  label?: string;
  selector: string;
  data_component?: string;
  fingerprint: ElementFingerprint;
}

/** Action the human wants performed. */
export type IntentAction =
  | "change"
  | "add"
  | "remove"
  | "move"
  | "fix"
  | "refactor"
  | "investigate";

export type ScopeBreadth = "element" | "region" | "component" | "page" | "multi";

export interface IntentScope {
  breadth: ScopeBreadth;
  targets: string[];
}

/** Structured human intent — the part competitors never capture. */
export interface FeedbackIntent {
  kind: "bug" | "enhancement" | "question" | "task";
  action: IntentAction;
  expected?: string; // what the human wants
  actual?: string; // what is wrong now
  scope: IntentScope;
}

/** Machine-checkable "done when" contract. */
export type VerificationKind =
  | "style_assertion"
  | "anchor_stable"
  | "test_exists"
  | "human";

export interface VerificationContract {
  kind: VerificationKind;
  check?: Record<string, string>; // e.g. {selector, prop, before, operator}
}

export interface Verification {
  contract: VerificationContract;
  criteria?: string;
}

export interface ExplanationQuality {
  text: string;
  quality: "precise" | "vague" | "missing";
  quality_score: number; // 0..1
}

/**
 * Order in which an agent should trust evidence when fields conflict.
 * Source location beats selector; human intent beats both on WHAT to build
 * but loses on WHERE it is.
 */
export const TRUST_ORDER: string[] = [
  "target.source",
  "target.element.fingerprint",
  "intent.expected",
  "intent.actual",
  "target.element.selector",
  "visual.screenshot_ref",
  "target.element.computed_styles",
  "environment.css_framework",
  "summary",
];

/**
 * Build the default provenance map for a captured envelope. Keys mirror
 * `TRUST_ORDER` so every ranked field carries an honesty marker.
 *
 * `source` (when passed) lets us mark `target.source` as `absent` when
 * nothing was actually resolved rather than claiming a capture that never
 * happened — the honesty contract of §2.3.
 */
export function stampProvenance(source?: SourceRef): Record<string, Provenance> {
  const sourceState: Provenance =
    source && source.confidence !== "none" ? "captured" : "absent";
  return {
    "target.source": sourceState,
    "target.element.fingerprint": "captured",
    "intent.expected": "stated",
    "intent.actual": "stated",
    "target.element.selector": "captured",
    "visual.screenshot_ref": "captured",
    "target.element.computed_styles": "captured",
    "environment.css_framework": "inferred",
    "summary": "inferred",
  };
}

/**
 * Score an explanation for machine-readability. A vague report must
 * self-identify as vague so the agent asks before editing.
 */
export function scoreExplanation(
  text: string,
  intent: Pick<FeedbackIntent, "expected" | "actual">
): ExplanationQuality {
  const hasExpected = !!intent.expected?.trim();
  const hasActual = !!intent.actual?.trim();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  let score = 0;
  if (hasExpected) score += 0.35;
  if (hasActual) score += 0.35;
  if (words >= 4) score += 0.15;
  if (words >= 8) score += 0.15;

  let quality: ExplanationQuality["quality"];
  if (score >= 0.7) quality = "precise";
  else if (score > 0 || words > 0) quality = "vague";
  else quality = "missing";

  return { text, quality, quality_score: Math.round(score * 100) / 100 };
}
