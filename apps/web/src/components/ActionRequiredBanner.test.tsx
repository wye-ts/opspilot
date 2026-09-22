import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActionRequiredBanner } from "./ActionRequiredBanner";

/**
 * Issue #131 — the banner must not promise an execution.
 *
 * It used to read "N proposed actions require review before execution."
 * Nothing executes: three documents say the mechanism records a decision only
 * (docs/13-approval-workflow.md §1, docs/12-agent-run-api.md §30, README's
 * capability matrix), and schema.prisma has no entity for a SuggestedAction to
 * act on. The phrase manufactured an expectation the terminal card then left
 * unanswered.
 *
 * Plan: docs/reviews/51-issue-131-approval-copy-execution-overclaim-plan.md
 */
describe("ActionRequiredBanner", () => {
  it("asks for a decision, singular, without promising an execution", () => {
    render(<ActionRequiredBanner suggestedActionCount={1} />);
    expect(screen.getByText("1 proposed action requires a human decision.")).toBeInTheDocument();
  });

  it("asks for a decision, plural, without promising an execution", () => {
    render(<ActionRequiredBanner suggestedActionCount={3} />);
    expect(screen.getByText("3 proposed actions require a human decision.")).toBeInTheDocument();
  });

  it("never claims execution, scheduling, dispatch, simulation, notification or escalation", () => {
    // Same claim-family guard as approval-presentation.test.ts, applied to the
    // other surface that carried the overclaim. Guards inflected forms rather
    // than phrasings: enumerating sentences is unbounded, and two earlier
    // drafts of this guard were defeated by ordinary grammar. Word boundaries
    // keep "dispatcher"/"scheduler"/"executive" green.
    const FORBIDDEN = [
      "execute", "executes", "executed", "executing", "execution", "executions",
      "schedule", "schedules", "scheduled", "scheduling",
      "dispatch", "dispatches", "dispatched", "dispatching",
      "simulate", "simulates", "simulated", "simulating", "simulation",
      "notify", "notifies", "notified", "notifying", "notification", "notifications",
      "escalate", "escalates", "escalated", "escalating", "escalation",
    ];
    const pattern = new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "i");

    // Read the rendered output, not a copy of the source literals.
    const { container } = render(<ActionRequiredBanner suggestedActionCount={2} />);
    const rendered = container.textContent ?? "";
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered, `banner claims an action OpsPilot never performs: "${rendered}"`).not.toMatch(pattern);

    // The guard fires on the claim this banner actually shipped.
    expect("2 proposed actions require review before execution.").toMatch(pattern);
  });
});
