// index.ts — emergent.feedback entry point.

import { readConfig } from "./config";
import { APIClient } from "./api";
import { AuthManager } from "./auth";
import { startActivationListener, onModeChange, forceMode, getMode } from "./activation";
import { highlight, clearHighlight } from "./highlighter";
import { renderBadges, clearBadges } from "./badge";
import { showSubmitDialog, showLoginDialog, closeDialog, showToast, type FeedbackType } from "./dialog";
import type { IssueBadge } from "./api";
import { buildSelector } from "./selector";
import { showIndicator, hideIndicator } from "./indicator";
import { startRecording, getHistory } from "./history";
import { getSessionId } from "./session";
import { captureElement } from "./screenshot";
import { captureSnapshot } from "./snapshot";
import { resolveSource, buildFingerprint } from "./source";
import {
  scoreExplanation,
  stampProvenance,
  TRUST_ORDER,
  type FeedbackIntent,
  type Verification,
  type ElementFingerprint,
} from "./envelope";
import { redactText, redactAttributes } from "./redact";
import { startConsoleCapture, getConsoleErrors } from "./console";
import { startVerifyLoop, stopVerifyLoop } from "./verify";
import { startReplay, getReplayPayloadAsync } from "./replay";
import { startReporterNotify, stopReporterNotify } from "./notify";

(function bootstrap() {
  if ((window as any).__feedbackOverlayLoaded) return;
  (window as any).__feedbackOverlayLoaded = true;

  startRecording();
  startConsoleCapture();

  const config = readConfig();
  const api = new APIClient(config);
  const auth = new AuthManager(config, api);

  api.setOnUnauthorized(() => auth.logout());

  // Opt-in session replay: start buffering immediately (pre-bug window) and
  // keep it running across mode transitions — never stopped on idle.
  if (config.replay) startReplay(config.replayBufferMs);

  startActivationListener(config);

  // ── Mode transitions ────────────────────────────────────────────────────────
  onModeChange(async (mode) => {
    if (mode === "active") {
      showIndicator(config.hotkey);
      activateOverlay();
      startVerifyLoop(api);
      startReporterNotify(api);
    } else if (mode === "idle") {
      hideIndicator();
      deactivateOverlay();
      stopVerifyLoop();
      stopReporterNotify();
    } else if (mode === "capturing" || mode === "commenting") {
      hideIndicator();
    }
  });

  // ── Overlay activation ──────────────────────────────────────────────────────
  function activateOverlay(): void {
    document.body.style.cursor = "crosshair";
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("click", onElementClick, true);
    refreshBadges();
  }

  async function refreshBadges(): Promise<void> {
    const url = window.location.href;
    const [summaries, issues] = await Promise.all([
      api.listBadges(url).catch((): never[] => []),
      api.listIssueBadges(url).catch((): IssueBadge[] => []),
    ]);
    renderBadges(summaries, onBadgeClick, issues);
  }

  function deactivateOverlay(): void {
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("click", onElementClick, true);
    clearHighlight();
    clearBadges();
    closeDialog();
  }

  // ── Mouse tracking ──────────────────────────────────────────────────────────
  function onMouseOver(e: MouseEvent): void {
    const target = e.target as Element;
    if (!target || target === document.body || target === document.documentElement) return;
    if (isOwnElement(target)) return;
    highlight(target);
  }

  function isOwnElement(el: Element): boolean {
    return el.id.startsWith("__ef_");
  }

  // ── Shared: open feedback dialog for an element ─────────────────────────────
  async function openFeedbackDialog(target: Element): Promise<void> {
    const selector = buildSelector(target);
    const context = gatherContext(target);
    const rawHierarchy = gatherComponentHierarchy(target);
    // Innermost ancestor = current target; it's at ancestors.length-1 (last ancestor before children).
    const ancestorCount = rawHierarchy.findIndex(
      (h) => !target.closest("[data-component]") || h.element === target.closest("[data-component]")
    );
    const selectedComponentIdx = ancestorCount >= 0 ? ancestorCount : 0;

    forceMode("capturing");
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("click", onElementClick, true);
    clearHighlight();

    // Ensure authenticated.
    if (!auth.isAuthenticated()) {
      await new Promise<void>((resolve, reject) => {
        showLoginDialog({
          onLogin: async () => { await auth.login(); resolve(); },
          onCancel: () => { forceMode("idle"); reject(new Error("cancelled")); },
        });
      }).catch(() => {});
    }
    if (!auth.isAuthenticated()) return;

    const user = auth.getUser()!;

    // Fetch existing comments for this element.
    const allComments = await api.listComments(window.location.href).catch(() => []);
    const existingComments = allComments.filter((c) => c.selector === selector);

    forceMode("commenting");

    // Build the default issue title. Prefer data-component over the CSS selector.
    const dataComponent = context["dataComponent"] as string | undefined;
    const elementLabel = dataComponent ?? (selector.split(">").pop()?.trim() ?? selector);
    const defaultIssueTopic = existingComments.length > 0
      ? `Feedback: ${existingComments.length + 1} comments on ${elementLabel}`
      : `Feedback on ${elementLabel}`;

    showSubmitDialog({
      selector,
      existingComments,
      context,
      user,
      defaultIssueTopic,
      repo: config.repo,
      branch: config.branch,
      appVersion: config.version,
      componentHierarchy: rawHierarchy.map((h, i) => ({
        name: h.name,
        isChild: i > selectedComponentIdx,
      })),
      selectedComponentIdx,
      onComponentChange: (idx) => {
        closeDialog();
        openFeedbackDialog(rawHierarchy[idx].element);
      },
      onSubmit: async (comment, type: FeedbackType, intent: FeedbackIntent) => {
        const screenshot = await captureElement(target);
        const snapshot = captureSnapshot();
        const replay = config.replay ? await getReplayPayloadAsync() : undefined;
        // intent/explanation are only known at submit time — merge them into
        // the capture-time context before shipping.
        const contextWithIntent = {
          ...context,
          intent,
          explanation: scoreExplanation(comment, intent),
          verification: buildVerification(
            selector,
            context["fingerprint"] as ElementFingerprint | undefined,
            intent,
            context["computedStyles"] as Record<string, string> | undefined
          ),
        };
        const result = await api.createFeedback({
          url: window.location.href,
          selector,
          comment,
          context: contextWithIntent,
          repo: config.repo,
          label: config.label,
          feedbackType: type,
          screenshot,
          snapshot,
          ...(replay ? { replay } : {}),
        });
        // Refresh badges, return to active mode.
        await refreshBadges();
        forceMode("active");
        return result.id;
      },
      onExport: async (ids, type: FeedbackType, issueTopic: string) => {
        const result = await api.exportIssue({
          ids,
          repo: config.repo,
          labels: [config.label, type],
          title: issueTopic,
        });
        showToast("Issue created successfully!");
        // Refresh badges after export.
        await refreshBadges();
        forceMode("active");
      },
      onCancel: () => {
        forceMode("active");
        // Re-attach listeners since mode was already "active".
        document.body.style.cursor = "crosshair";
        document.addEventListener("mouseover", onMouseOver, true);
        document.addEventListener("click", onElementClick, true);
      },
    });
  }

  // ── Element click ────────────────────────────────────────────────────────────
  async function onElementClick(e: MouseEvent): Promise<void> {
    const target = e.target as Element;
    if (!target || isOwnElement(target)) return;

    e.preventDefault();
    e.stopPropagation();

    if (getMode() !== "active") return;

    await openFeedbackDialog(target);
  }

  // ── Badge click — open the dialog for that element ──────────────────────────
  function onBadgeClick(_ids: number[], selector: string): void {
    // Find the element on the page matching the selector.
    let el: Element | null = null;
    try { el = document.querySelector(selector); } catch {}
    if (el) {
      openFeedbackDialog(el);
    }
  }

  // ── Component hierarchy ─────────────────────────────────────────────────────
  // Returns ancestors (outermost→innermost) then direct data-component children.
  function gatherComponentHierarchy(target: Element): { name: string; element: Element }[] {
    const ancestors: { name: string; element: Element }[] = [];
    let node: Element | null = target;
    while (node && node !== document.documentElement) {
      const val = node.getAttribute("data-component");
      if (val) ancestors.push({ name: val, element: node });
      node = node.parentElement;
    }
    ancestors.reverse(); // outermost first

    const innermostEl = ancestors.length > 0 ? ancestors[ancestors.length - 1].element : null;
    const children: { name: string; element: Element }[] = [];
    if (innermostEl) {
      innermostEl.querySelectorAll("[data-component]").forEach((child) => {
        // Only direct component children (nearest data-component ancestor is innermostEl).
        const nearestParent = child.parentElement?.closest("[data-component]");
        if (nearestParent === innermostEl) {
          children.push({ name: child.getAttribute("data-component")!, element: child });
        }
      });
    }

    return [...ancestors, ...children];
  }

  // ── Context collection ──────────────────────────────────────────────────────
  function resolveTraceId(): string | undefined {
    if (config.sessionId) return config.sessionId;
    if (config.sessionIdSelector) {
      try {
        const el = document.querySelector(config.sessionIdSelector);
        const text = el?.textContent?.trim();
        if (text) return text;
      } catch {
        // invalid selector — ignore
      }
    }
    const g = (window as any).__feedbackSessionId;
    if (typeof g === "string" && g) return g;
    if (typeof g === "function") {
      try {
        const v = g();
        if (typeof v === "string" && v) return v;
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  // ── Verification contract ────────────────────────────────────────────────────
  // Maps the intent micro-form's "actual" labels (dialog.ts) to CSS props.
  const STYLE_PROP_LABELS: [string, string][] = [
    ["text color", "color"],
    ["background", "backgroundColor"],
    ["font size", "fontSize"],
    ["weight", "fontWeight"],
  ];

  // Detect which style prop `intent.actual` was captured from, if any.
  function detectStyleProp(
    actual: string,
    computedStyles: Record<string, string> | undefined
  ): string | undefined {
    const lower = actual.toLowerCase();
    for (const [label, prop] of STYLE_PROP_LABELS) {
      if (lower.startsWith(label + ":")) return prop;
    }
    // Fallback: exact match against a captured computed style value.
    if (computedStyles) {
      for (const prop of ["color", "backgroundColor", "fontSize", "fontWeight"]) {
        if (computedStyles[prop] && computedStyles[prop] === actual) return prop;
      }
    }
    return undefined;
  }

  // Extract the value after a "<label>: " prefix (defensive fallback for `before`).
  function extractBefore(actual: string): string | undefined {
    const idx = actual.indexOf(":");
    if (idx >= 0) return actual.slice(idx + 1).trim();
    return undefined;
  }

  function buildVerification(
    selector: string,
    fingerprint: ElementFingerprint | undefined,
    intent: FeedbackIntent,
    computedStyles: Record<string, string> | undefined
  ): Verification {
    const expected = intent.expected?.trim();
    const actual = intent.actual?.trim();

    // 1. style_assertion when `actual` was captured from a style prop.
    if (actual) {
      const prop = detectStyleProp(actual, computedStyles);
      if (prop) {
        const before = computedStyles?.[prop] ?? extractBefore(actual) ?? "";
        return {
          contract: {
            kind: "style_assertion",
            check: { selector, prop, before, operator: "changed" },
          },
          criteria: expected || `Change ${prop} of the selected element`,
        };
      }
    }

    // 2. anchor_stable when a fingerprint path exists.
    if (fingerprint?.path) {
      return {
        contract: {
          kind: "anchor_stable",
          check: { selector, path: fingerprint.path },
        },
        criteria: expected || "Element stays findable via its selector and fingerprint",
      };
    }

    // 3. human fallback.
    return {
      contract: { kind: "human" },
      criteria: expected || "Human confirmation that the change is correct",
    };
  }

  function gatherContext(el: Element): Record<string, unknown> {
    const rect = el.getBoundingClientRect();
    const source = resolveSource(el);
    const outerHTML = redactText(el.outerHTML ?? "").slice(0, 4000);
    const innerText = redactText((el as HTMLElement).innerText ?? "").slice(0, 200);
    return {
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      tagName: el.tagName.toLowerCase(),
      dataComponent: buildComponentPath(el) ?? undefined,
      outerHTML,
      innerText,
      attributes: gatherAttributes(el),
      source,
      fingerprint: buildFingerprint(el),
      provenance: stampProvenance(source),
      trust_order: TRUST_ORDER,
      cssFramework: detectCSSFramework(el),
      computedStyles: gatherComputedStyles(el),
      boundingRect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      sessionId: getSessionId(),
      traceId: resolveTraceId(),
      ...(config.branch  ? { branch: config.branch }   : {}),
      ...(config.version ? { appVersion: config.version } : {}),
      sessionHistory: getHistory(),
      repro: {
        steps: [],
        console: getConsoleErrors(),
        network: [],
      },
    };
  }

  // Walk up the DOM tree to find the nearest ancestor (or self) with data-component.
  // If the element itself IS the component root, returns just the component name.
  // If it is a descendant, returns "ComponentName > tag > tag > tag" showing
  // the relative path from the component boundary down to the clicked element.
  function buildComponentPath(el: Element): string | null {
    let node: Element | null = el;
    // innermost-first accumulator; does NOT include the component root node itself.
    const inner: string[] = [];

    while (node && node !== document.documentElement) {
      const val = node.getAttribute("data-component");
      if (val) {
        // inner is currently [el.tag, parent.tag, ...] — reverse to get top-down order.
        const parts = [val, ...inner.reverse()];
        return parts.join(" > ");
      }
      inner.push(node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return null;
  }

  function gatherAttributes(el: Element): Record<string, string> {
    const out: Record<string, string> = {};
    const kept = redactAttributes(
      Array.from(el.attributes).map((a) => ({ name: a.name, value: a.value }))
    );
    for (const { name, value } of kept) {
      if (value.length < 200) out[name] = value;
    }
    return out;
  }

  // Key computed style properties worth reporting.
  const COMPUTED_STYLE_PROPS = [
    "display", "position", "flexDirection", "flexWrap", "alignItems", "justifyContent",
    "gridTemplateColumns", "gridTemplateRows",
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "margin", "padding",
    "color", "backgroundColor", "opacity",
    "fontSize", "fontFamily", "fontWeight", "lineHeight", "textAlign",
    "border", "borderRadius", "boxShadow",
    "overflow", "overflowX", "overflowY",
    "zIndex", "visibility", "cursor",
  ] as const;

  function gatherComputedStyles(el: Element): Record<string, string> {
    const cs = window.getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const prop of COMPUTED_STYLE_PROPS) {
      const val = cs.getPropertyValue(
        // Convert camelCase to kebab-case for getPropertyValue.
        prop.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)
      ).trim();
      // Skip browser defaults that add noise.
      if (val && val !== "none" && val !== "normal" && val !== "auto" && val !== "0px") {
        out[prop] = val;
      }
    }
    return out;
  }

  // Detect CSS framework from class names and other signals.
  function detectCSSFramework(el: Element): string[] {
    const classes = Array.from(el.classList).join(" ");
    // Gather classes from all ancestors too for broader signal.
    let node: Element | null = el;
    const allClasses: string[] = [];
    for (let i = 0; i < 6 && node; i++) {
      allClasses.push(...Array.from(node.classList));
      node = node.parentElement;
    }
    const joined = allClasses.join(" ");

    const detected: string[] = [];

    // Tailwind: utility class patterns.
    if (/\b(bg-|text-|flex|grid|p-|m-|w-|h-|rounded|border|shadow|gap-|items-|justify-|font-|leading-|tracking-)/.test(joined))
      detected.push("Tailwind CSS");

    // DaisyUI: component class names.
    if (/\b(btn|badge|card|modal|navbar|drawer|dropdown|alert|toast|menu|tab|hero|footer|input|select|checkbox|toggle|range|avatar|indicator)\b/.test(classes))
      detected.push("DaisyUI");

    // Bootstrap.
    if (/\b(container|row|col-|btn-|navbar-|card-|modal-|form-control|d-flex|align-items-|justify-content-)/.test(joined))
      detected.push("Bootstrap");

    // Material UI.
    if (/\bMui[A-Z]/.test(joined))
      detected.push("Material UI");

    // Chakra UI.
    if (/\bchakra-/.test(joined))
      detected.push("Chakra UI");

    // Radix UI.
    if (el.hasAttribute("data-radix-collection-item") || /\bradix-/.test(joined))
      detected.push("Radix UI");

    // Shadcn (Tailwind + Radix combo signal via cn() pattern classes).
    if (detected.includes("Tailwind CSS") && detected.includes("Radix UI"))
      detected.push("shadcn/ui");

    return detected;
  }
})();
