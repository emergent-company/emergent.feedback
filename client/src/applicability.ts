// applicability.ts — per-element capability filtering for the live style editor.
//
// Many token groups only make sense for certain kinds of element: `gap` needs a
// flex/grid container with children, `width`/`height` need a box (not inline
// text), `btn-*` needs a `.btn`. This module computes an element's layout
// "capabilities" from its computed style and decides whether each requirement is
// met. It is pure and Node-safe: no DOM is touched at module scope, so it can be
// unit-tested without jsdom.

import type { TokenGroup } from "./tokens";

export type Requirement =
  | "container"
  | "flex-grid-container"
  | "flex-container"
  | "container-item"
  | "box"
  | "text"
  | "children"
  | "replaced"
  | "positioned"
  | `has-class:${string}`;

export interface ElementCapabilities {
  display: string;
  parentDisplay: string;
  hasChildren: boolean;
  hasText: boolean;
  isReplaced: boolean;
  isPositioned: boolean;
  classes: string[];
  /** Parsed `column-count` (1 when absent/invalid). */
  columnCount: number;
}

export type StyleGetter = (el: Element) => { getPropertyValue(p: string): string } | null;

const KNOWN_REQUIREMENTS = new Set<string>([
  "container",
  "flex-grid-container",
  "flex-container",
  "container-item",
  "box",
  "text",
  "children",
  "replaced",
  "positioned",
]);

/** A CSS class name (no whitespace, punctuation or escapes). */
const CLASS_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const FLEX_DISPLAYS = new Set(["flex", "inline-flex"]);
const CONTAINER_DISPLAYS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

const NON_TEXT_INPUT_TYPES = new Set([
  "hidden", "checkbox", "radio", "range", "color", "file", "image",
]);

const REPLACED_TAGS = new Set(["img", "video", "canvas", "iframe", "embed", "object"]);

const REQUIREMENT_DESCRIPTIONS: Record<string, string> = {
  container: "needs a flex/grid/multi-column container",
  "flex-grid-container": "needs a flex/grid container",
  "flex-container": "needs a flex container",
  "container-item": "needs a flex/grid parent",
  box: "needs a box element",
  text: "needs text content",
  children: "needs child elements",
  replaced: "needs a replaced element",
  positioned: "needs a positioned element",
};

/** True when `req` is a known requirement or a well-formed `has-class:<class>`. */
export function isValidRequirement(req: string): boolean {
  if (KNOWN_REQUIREMENTS.has(req)) return true;
  if (req.startsWith("has-class:")) {
    const cls = req.slice("has-class:".length);
    return cls.length > 0 && CLASS_TOKEN_RE.test(cls);
  }
  return false;
}

function readProp(
  cs: { getPropertyValue(p: string): string } | null,
  prop: string
): string {
  if (!cs) return "";
  try {
    const v = cs.getPropertyValue(prop);
    return (v == null ? "" : v).trim().toLowerCase();
  } catch {
    return "";
  }
}

function classListOf(el: Element): string[] {
  try {
    return Array.from(el.classList ?? []);
  } catch {
    return [];
  }
}

function defaultStyleGetter(el: Element): { getPropertyValue(p: string): string } | null {
  if (typeof window === "undefined") return null;
  try {
    return window.getComputedStyle(el);
  } catch {
    return null;
  }
}

export function elementCaps(el: Element, getStyle?: StyleGetter): ElementCapabilities {
  const style = getStyle ?? defaultStyleGetter;
  const safeGet = (target: Element): { getPropertyValue(p: string): string } | null => {
    try {
      return style(target);
    } catch {
      return null;
    }
  };

  const selfStyle = safeGet(el);
  const display = readProp(selfStyle, "display");

  // Nearest "real" parent: walk past `display: contents` ancestors.
  let parentDisplay = "";
  let p = el.parentElement ?? null;
  while (p) {
    const pd = readProp(safeGet(p), "display");
    if (pd === "contents") {
      p = p.parentElement ?? null;
      continue;
    }
    parentDisplay = pd;
    break;
  }

  const tag = (el.tagName ?? "").toLowerCase();
  const isInput = tag === "input";
  const inputType = isInput
    ? ((el as HTMLInputElement).type ?? "").trim().toLowerCase()
    : "";

  const isTextControl =
    (isInput && !NON_TEXT_INPUT_TYPES.has(inputType)) ||
    tag === "textarea" ||
    tag === "select";

  const textContent =
    typeof (el as { textContent?: unknown }).textContent === "string"
      ? ((el as { textContent?: string }).textContent ?? "")
      : "";
  const hasText = isTextControl || textContent.trim() !== "";

  const isReplaced = REPLACED_TAGS.has(tag) || (isInput && inputType === "image");

  const position = readProp(selfStyle, "position");
  const isPositioned = position !== "" && position !== "static";

  const rawColumn = readProp(selfStyle, "column-count");
  const parsedColumn = parseInt(rawColumn, 10);
  const columnCount = Number.isFinite(parsedColumn) && parsedColumn > 0 ? parsedColumn : 1;

  return {
    display,
    parentDisplay,
    hasChildren: (el.children ? el.children.length : 0) > 0,
    hasText,
    isReplaced,
    isPositioned,
    classes: classListOf(el),
    columnCount,
  };
}

export function requirementMet(req: Requirement, caps: ElementCapabilities): boolean {
  if (req.startsWith("has-class:")) {
    return caps.classes.includes(req.slice("has-class:".length));
  }
  switch (req) {
    case "container":
      return CONTAINER_DISPLAYS.has(caps.display) || caps.columnCount > 1;
    case "flex-grid-container":
      return CONTAINER_DISPLAYS.has(caps.display);
    case "flex-container":
      return FLEX_DISPLAYS.has(caps.display);
    case "container-item":
      return CONTAINER_DISPLAYS.has(caps.parentDisplay);
    case "box":
      return (
        (caps.display !== "inline" &&
          caps.display !== "contents" &&
          caps.display !== "none") ||
        caps.isReplaced
      );
    case "text":
      return caps.hasText;
    case "children":
      return caps.hasChildren;
    case "replaced":
      return caps.isReplaced;
    case "positioned":
      return caps.isPositioned;
    default:
      // Unknown requirement → permissive: treated as met.
      return true;
  }
}

export function meetsRequirements(
  requires: Requirement | Requirement[] | undefined,
  caps: ElementCapabilities
): boolean {
  if (requires === undefined) return true;
  const list = Array.isArray(requires) ? requires : [requires];
  return list.every((req) => requirementMet(req, caps));
}

export function describeRequirement(req: Requirement): string {
  if (req.startsWith("has-class:")) {
    return `needs class "${req.slice("has-class:".length)}"`;
  }
  return REQUIREMENT_DESCRIPTIONS[req] ?? req;
}

export interface ApplicabilityOptions {
  isApplied?: (g: TokenGroup) => boolean;
  getStyle?: StyleGetter;
}

export function isApplicable(
  group: TokenGroup,
  el: Element,
  options?: ApplicabilityOptions
): boolean {
  // A group with a currently applied token always stays visible (so it remains
  // revertable via Default).
  if (options?.isApplied?.(group)) return true;

  const requires = group.requires;
  if (requires === undefined) return true;

  // Detached elements: computed-style reads for them are unreliable, so show
  // every group rather than hiding settings by mistake (per the docs). An
  // undefined `isConnected` (unit-test fakes) must NOT bail.
  const connected = (el as { isConnected?: boolean }).isConnected;
  if (connected === false) return true;

  // Permissive on failure: if we can't resolve a computed style for this
  // element (no window, detached, or a throwing getter), show everything.
  const getStyle = options?.getStyle ?? defaultStyleGetter;
  let style: { getPropertyValue(p: string): string } | null = null;
  try {
    style = getStyle(el);
  } catch {
    style = null;
  }
  if (!style) return true;

  return meetsRequirements(requires, elementCaps(el, getStyle));
}

export function visibleGroups(
  groups: TokenGroup[],
  el: Element,
  options?: ApplicabilityOptions
): TokenGroup[] {
  return groups.filter((g) => isApplicable(g, el, options));
}
