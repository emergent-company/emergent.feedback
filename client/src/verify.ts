// verify.ts — verification-contract evaluation + live verify loop.
//
// The verification contract is the machine-checkable "done when" for a fix.
// `evaluateContract` runs a contract against the live page; `startVerifyLoop`
// polls the server for contracts awaiting re-check and posts results back.

import { getMode } from "./activation";
import type { APIClient } from "./api";
import type { VerificationContract } from "./envelope";

export type VerifyResult = "green" | "amber" | "red";

export interface ContractEvaluation {
  result: VerifyResult;
  detail: string;
}

/** Last tag of a fingerprint path ("main > section > button" → "button"). */
function lastTagOfPath(path: string): string | undefined {
  const parts = path.split(">").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1];
}

/** camelCase → kebab-case for getComputedStyle().getPropertyValue(). */
function kebab(prop: string): string {
  return prop.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Evaluate a verification contract against the live DOM.
 *
 * - style_assertion: computed value changed from `before` → green, else red.
 * - anchor_stable:    element at selector with matching fingerprint tag →
 *                     green; present but different tag → amber; missing → red.
 * - human:            always amber ("needs human confirmation").
 */
export function evaluateContract(contract: VerificationContract): ContractEvaluation {
  try {
    switch (contract.kind) {
      case "style_assertion": {
        const check = contract.check ?? {};
        const selector = check["selector"];
        const prop = check["prop"];
        const before = check["before"];
        const operator = check["operator"] ?? "changed";

        if (!selector || !prop) {
          return { result: "amber", detail: "style_assertion contract missing selector or prop" };
        }
        let el: Element | null = null;
        try { el = document.querySelector(selector); } catch { el = null; }
        if (!el) {
          return { result: "amber", detail: `Element ${selector} not found` };
        }

        const current = window.getComputedStyle(el).getPropertyValue(kebab(prop)).trim();
        if (operator === "changed") {
          if (before !== undefined && before !== "" && current !== before) {
            return { result: "green", detail: `${prop} changed from "${before}" to "${current}"` };
          }
          if (before === undefined || before === "") {
            return { result: "amber", detail: `${prop} has no recorded "before" value to compare against (current "${current}")` };
          }
          return { result: "red", detail: `${prop} still "${current}" (expected change from "${before}")` };
        }
        // Generic compare: non-before value treated as changed.
        if (before !== undefined && current !== before) {
          return { result: "green", detail: `${prop} changed from "${before}" to "${current}"` };
        }
        return { result: "red", detail: `${prop} still "${current}"` };
      }

      case "anchor_stable": {
        const check = contract.check ?? {};
        const selector = check["selector"];
        const path = check["path"];
        if (!selector) {
          return { result: "amber", detail: "anchor_stable contract missing selector" };
        }
        let el: Element | null = null;
        try { el = document.querySelector(selector); } catch { el = null; }
        if (!el) {
          return { result: "red", detail: `Element ${selector} not found` };
        }
        const expectedTag = path ? lastTagOfPath(path) : undefined;
        if (!expectedTag) {
          return { result: "green", detail: `Element ${selector} found` };
        }
        const actualTag = el.tagName.toLowerCase();
        if (actualTag === expectedTag) {
          return { result: "green", detail: `Element ${selector} found (${actualTag})` };
        }
        return {
          result: "amber",
          detail: `Element ${selector} found but tag changed: expected <${expectedTag}>, got <${actualTag}>`,
        };
      }

      case "human":
      case "test_exists":
      default:
        return { result: "amber", detail: "needs human confirmation" };
    }
  } catch (e) {
    return { result: "amber", detail: `evaluation failed: ${String(e)}` };
  }
}

let loopTimer: number | null = null;

/** Stop the verify loop if running. Safe to call when not running. */
export function stopVerifyLoop(): void {
  if (loopTimer !== null) {
    window.clearInterval(loopTimer);
    loopTimer = null;
  }
}

/**
 * Poll `GET /feedback/verify-pending` while the overlay is active and the user
 * is authenticated, evaluate each returned contract against the live page, and
 * post the result back. Non-blocking and failure-tolerant: any poll/item error
 * is swallowed. Returns `stopVerifyLoop` for manual teardown.
 */
export function startVerifyLoop(api: APIClient, intervalMs = 15000): () => void {
  if (loopTimer !== null) return stopVerifyLoop;

  const tick = async () => {
    if (getMode() !== "active" || !api.isAuthenticated()) return;
    try {
      const pending = await api.getVerifyPending(window.location.href);
      for (const item of pending) {
        try {
          const evaluation = evaluateContract(item.contract);
          await api.postVerifyResult(item.id, evaluation.result, evaluation.detail);
        } catch {
          // per-item failure tolerated
        }
      }
    } catch {
      // poll failure tolerated
    }
  };

  loopTimer = window.setInterval(tick, intervalMs);
  return stopVerifyLoop;
}
