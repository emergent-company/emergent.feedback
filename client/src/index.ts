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

(function bootstrap() {
  if ((window as any).__feedbackOverlayLoaded) return;
  (window as any).__feedbackOverlayLoaded = true;

  startRecording();

  const config = readConfig();
  const api = new APIClient(config);
  const auth = new AuthManager(config, api);

  api.setOnUnauthorized(() => auth.logout());

  startActivationListener(config);

  // ── Mode transitions ────────────────────────────────────────────────────────
  onModeChange(async (mode) => {
    if (mode === "active") {
      showIndicator(config.hotkey);
      activateOverlay();
    } else if (mode === "idle") {
      hideIndicator();
      deactivateOverlay();
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
      onSubmit: async (comment, type: FeedbackType) => {
        const screenshot = await captureElement(target);
        const snapshot = captureSnapshot();
        const result = await api.createFeedback({
          url: window.location.href,
          selector,
          comment,
          context,
          repo: config.repo,
          label: config.label,
          feedbackType: type,
          screenshot,
          snapshot,
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

  function gatherContext(el: Element): Record<string, unknown> {
    const rect = el.getBoundingClientRect();
    return {
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      tagName: el.tagName.toLowerCase(),
      dataComponent: buildComponentPath(el) ?? undefined,
      outerHTML: el.outerHTML?.slice(0, 4000) ?? "",
      innerText: (el as HTMLElement).innerText?.slice(0, 200) ?? "",
      attributes: gatherAttributes(el),
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
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.length < 200) out[attr.name] = attr.value;
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
