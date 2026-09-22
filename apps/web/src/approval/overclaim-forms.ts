/**
 * The claim families the approval surface must never assert (issue #131).
 *
 * Shared by approval-presentation.test.ts and ActionRequiredBanner.test.tsx so
 * the two guards cannot drift: a term added for one surface protects both.
 *
 * WHY FORMS, NOT PHRASES. Two drafts of this guard enumerated concrete
 * sentences, and independent review defeated each with ordinary grammar —
 * first "are executed" / "schedules the actions", then "execute after
 * approval" / "Execution follows approval" / "A notification is sent".
 * Enumerating phrasings is unbounded; enumerating a word family's inflected
 * forms is finite and closes the class.
 *
 * MATCH ON WORD BOUNDARIES. "dispatcher", "scheduler" and "executive" each
 * contain a listed token and are legitimate words. A guard that misfires on
 * innocent text creates pressure to weaken the guard — the failure mode that
 * cost four review rounds on #126 (docs/reviews/50 §1.3b).
 */
export const OVERCLAIM_FORMS = [
  "execute", "executes", "executed", "executing", "execution", "executions",
  "schedule", "schedules", "scheduled", "scheduling",
  "dispatch", "dispatches", "dispatched", "dispatching",
  "simulate", "simulates", "simulated", "simulating", "simulation", "simulations",
  "notify", "notifies", "notified", "notifying", "notification", "notifications",
  "escalate", "escalates", "escalated", "escalating", "escalation", "escalations",
] as const;
