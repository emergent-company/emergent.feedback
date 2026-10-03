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
 * - style_assertion: explicit operators (`changed`, `equals`, `not_equals`,
 *   `present`) with constrained semantics. `changed` alone cannot verify the
 *   direction/correctness of a change, so it returns amber (human confirm) on
 *   a change and red when unchanged; unknown operators return amber, never a
 *   false green.
 * - anchor_stable:   element found (anchored) → amber (mere presence/tag-match
 *                    cannot confirm the fix was applied); missing → red.
 *                    Never green: it is not machine-checkable that a fix is
 *                    correct, only that the anchor still resolves.
 * - human:           always amber ("needs human confirmation").
 */
export function evaluateContract(contract: VerificationContract): ContractEvaluation {
  try {
    switch (contract.kind) {
      case "style_assertion": {
        const check = contract.check ?? {};
        const selector = check["selector"];
        const prop = check["prop"];
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

        // Operators are constrained and explicit. An UNKNOWN operator must
        // never be treated as "changed" — return amber, not a false green.
        switch (operator) {
          case "changed": {
            const before = check["before"];
            if (before === undefined || before === "") {
              return { result: "amber", detail: `${prop} has no recorded "before" value to compare against (current "${current}")` };
            }
            if (current !== before) {
              // "changed" alone cannot verify the direction/correctness of the
              // change — a value that changed but in the wrong direction must
              // not claim success. At most amber (human confirmation).
              return { result: "amber", detail: `${prop} changed from "${before}" to "${current}" — needs human confirmation of correctness` };
            }
            return { result: "red", detail: `${prop} still "${current}" (expected change from "${before}")` };
          }

          case "equals": {
            const expected = check["value"] ?? check["expected"];
            if (expected === undefined || expected === "") {
              return { result: "amber", detail: `style_assertion "equals" missing target value` };
            }
            if (current === expected) {
              return { result: "green", detail: `${prop} equals "${expected}"` };
            }
            return { result: "red", detail: `${prop} is "${current}" (expected "${expected}")` };
          }

          case "not_equals": {
            const forbidden = check["value"] ?? check["expected"];
            if (forbidden === undefined || forbidden === "") {
              return { result: "amber", detail: `style_assertion "not_equals" missing target value` };
            }
            if (current !== forbidden) {
              return { result: "green", detail: `${prop} is "${current}" (no longer "${forbidden}")` };
            }
            return { result: "red", detail: `${prop} still "${current}" (must not equal "${forbidden}")` };
          }

          case "present": {
            if (current !== "") {
              return { result: "green", detail: `${prop} is present ("${current}")` };
            }
            return { result: "red", detail: `${prop} is not present` };
          }

          default:
            return { result: "amber", detail: `unknown style_assertion operator "${operator}"` };
        }
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
        // `anchor_stable` is NOT machine-checkable: finding the element (even
        // with a matching fingerprint tag) only proves the anchor still
        // resolves — it does not prove the fix was applied or is correct.
        // It must never return `green`; the best it can do is `amber`
        // ("anchored, awaiting human/agent confirmation"). Missing → `red`.
        const expectedTag = path ? lastTagOfPath(path) : undefined;
        const actualTag = el.tagName.toLowerCase();
        if (expectedTag && actualTag !== expectedTag) {
          return {
            result: "amber",
            detail: `Element ${selector} found but tag changed: expected <${expectedTag}>, got <${actualTag}>`,
          };
        }
        return {
          result: "amber",
          detail: `Element ${selector} found (${actualTag}) — anchored, needs human/agent confirmation`,
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
          // Post only conclusive results. `amber` = "cannot auto-verify /
          // needs human or agent confirmation" — posting it would neither
          // verify nor fail the item, so skip it to avoid churn and any risk
          // of an amber→verified flip. `green` is only ever produced by a
          // genuine machine-checkable assertion (style_assertion
          // equals/not_equals/present); `anchor_stable`/`human`/`test_exists`
          // and `changed` can only yield `amber`/`red`, never a false green.
          if (evaluation.result === "amber") continue;
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
