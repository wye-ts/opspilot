import { describe, expect, it } from "vitest";

import { OVERCLAIM_FORMS } from "./overclaim-forms";

/**
 * Issue #131 — the shared term list must actually be complete.
 *
 * Three review rounds broke earlier guards with ordinary grammar, and the fix
 * each time was "add the missing form" — which leaves completeness resting on
 * whoever edits the list next noticing. These tests make the rule structural:
 * a family that gains a stem but loses a form fails here, not in review.
 */
describe("OVERCLAIM_FORMS", () => {
  const STEMS = ["execut", "schedul", "dispatch", "simulat", "notif", "escalat"] as const;

  function familyOf(stem: string): string[] {
    return OVERCLAIM_FORMS.filter((form) => form.startsWith(stem));
  }

  it("covers every claim family the approval surface must not assert", () => {
    for (const stem of STEMS) {
      expect(familyOf(stem).length, `no forms for family "${stem}"`).toBeGreaterThan(0);
    }
    // Every listed term belongs to a known family — catches a stray addition
    // that no family test would otherwise cover.
    for (const form of OVERCLAIM_FORMS) {
      expect(
        STEMS.some((stem) => form.startsWith(stem)),
        `"${form}" belongs to no declared claim family`,
      ).toBe(true);
    }
  });

  it("pluralizes every noun form", () => {
    // The gap independent review found twice: "simulation" and "escalation"
    // were listed while "simulations" and "escalations" were not, so
    // "OpsPilot runs simulations after approval" passed a guard whose own
    // comment promises the complete inflected form of each family.
    for (const form of OVERCLAIM_FORMS) {
      if (form.endsWith("ion")) {
        expect(
          OVERCLAIM_FORMS.includes(`${form}s` as (typeof OVERCLAIM_FORMS)[number]),
          `noun "${form}" is listed but its plural "${form}s" is not`,
        ).toBe(true);
      }
    }
  });

  it("carries the verb inflections that ordinary copy would use", () => {
    // Base/3rd-person/past/gerund. A family listing only its noun would let
    // "Approved actions execute after approval" through — the exact sentence
    // that defeated the second draft of this guard.
    const VERBS: Readonly<Record<string, readonly string[]>> = {
      execut: ["execute", "executes", "executed", "executing"],
      schedul: ["schedule", "schedules", "scheduled", "scheduling"],
      dispatch: ["dispatch", "dispatches", "dispatched", "dispatching"],
      simulat: ["simulate", "simulates", "simulated", "simulating"],
      notif: ["notify", "notifies", "notified", "notifying"],
      escalat: ["escalate", "escalates", "escalated", "escalating"],
    };
    for (const [stem, forms] of Object.entries(VERBS)) {
      for (const form of forms) {
        expect(
          OVERCLAIM_FORMS.includes(form as (typeof OVERCLAIM_FORMS)[number]),
          `family "${stem}" is missing the form "${form}"`,
        ).toBe(true);
      }
    }
  });

  it("matches the plural claims that defeated the previous draft", () => {
    const pattern = new RegExp(`\\b(${OVERCLAIM_FORMS.join("|")})\\b`, "i");
    for (const claim of [
      "OpsPilot runs simulations after approval",
      "OpsPilot creates escalations after approval",
      "Notifications are sent on approval",
      "Executions begin once approved",
    ]) {
      expect(claim, `guard missed a forbidden claim: "${claim}"`).toMatch(pattern);
    }
  });

  it("stays silent on innocent words that contain a listed token", () => {
    // Word boundaries are load-bearing. A guard that misfires on ordinary
    // prose creates pressure to weaken it — the failure mode that cost four
    // review rounds on #126 (docs/reviews/50 §1.3b).
    const pattern = new RegExp(`\\b(${OVERCLAIM_FORMS.join("|")})\\b`, "i");
    for (const innocent of [
      "dispatcher queue",
      "scheduler thread",
      "executive summary",
      "no execution path exists",
    ]) {
      // The last one is deliberate: it SHOULD match, because it contains the
      // bare word "execution". It is listed here to document that the guard is
      // applied to user-visible product copy only, never to source comments.
      const expectedToMatch = innocent === "no execution path exists";
      expect(pattern.test(innocent), `"${innocent}"`).toBe(expectedToMatch);
    }
  });
});
