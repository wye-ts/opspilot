/**
 * Parameterised ticket generation for the completion-rate measurement.
 *
 * WHY TEMPLATES RATHER THAN A HAND-WRITTEN LIST
 *
 * The first version of the measurement cycled five hand-written tickets with
 * `TICKETS[i % 5]`, so a 15-run round was the same five tickets three times
 * over — not fifteen samples. Widening it to fifteen hand-written tickets
 * would only move the ceiling; the measurement would still be reporting "how
 * this particular wording behaves".
 *
 * AndroidWorld's approach (docs: evaluation ch.7) is parameterised templates
 * with per-run generated parameters. Its stated purpose there is leakage
 * resistance, but the same mechanism fixes the sampling problem: each run gets
 * a distinct service/symptom/context combination drawn from the seeded world,
 * so variation between runs reflects the agent rather than one fixed prompt.
 *
 * DETERMINISM: generation is seeded. The same seed reproduces the same ticket
 * set, so a recorded round can be re-run exactly — which the run ledger in
 * docs/reviews/48-... needs, and which a Math.random() generator would destroy.
 */

/** The three services the seeded diagnostic tools actually know about. */
const SEEDED_SERVICES = [
  { slug: "notification-service", noun: "outbound notification emails", team: "Messaging" },
  { slug: "billing-service", noun: "billing API calls", team: "Billing" },
  { slug: "auth-service", noun: "customer sign-ins", team: "Identity" },
] as const;

/**
 * Symptom phrasings. Each stays an ordinary operator report — none is
 * adversarial, and none hints at which tool to call, because the measurement
 * is about report construction rather than tool selection.
 */
const SYMPTOMS = [
  "arriving late or failing intermittently for one tenant",
  "returning elevated 5xx rates since this morning",
  "timing out for a subset of customers in one region",
  "succeeding but with several minutes of unexplained delay",
  "failing with errors that customers are reporting directly",
] as const;

/**
 * Context clauses. These vary what the agent can lean on — deliberately
 * including both "no release announced" (which does NOT rule a deploy out) and
 * an explicit deployment mention, so the set is not uniformly biased toward
 * one investigation shape.
 */
const CONTEXTS = [
  "The worker pool looks healthy and no release has been announced.",
  "On-call wants to know whether a recent deployment is involved before paging anyone.",
  "The upstream provider status page shows no incident.",
  "This started shortly after a routine configuration change was rolled out.",
  "Nothing has been deployed for several days and no alerts have fired.",
] as const;

export interface GeneratedTicket {
  readonly id: string;
  readonly summary: string;
  /** Recorded so a failure can be traced back to the exact parameters. */
  readonly parameters: {
    readonly serviceSlug: string;
    readonly symptomIndex: number;
    readonly contextIndex: number;
  };
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Chosen over Math.random precisely
 * because a recorded measurement must be reproducible from its seed.
 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates `count` distinct tickets. Combinations are drawn without
 * replacement from the 3x5x5 = 75-cell space until it is exhausted, so a
 * 15-run round cannot silently repeat a ticket the way `i % 5` did.
 */
export function generateTickets(count: number, seed: number): GeneratedTicket[] {
  const combinations: Array<[number, number, number]> = [];
  for (let s = 0; s < SEEDED_SERVICES.length; s += 1) {
    for (let y = 0; y < SYMPTOMS.length; y += 1) {
      for (let c = 0; c < CONTEXTS.length; c += 1) combinations.push([s, y, c]);
    }
  }
  if (count > combinations.length) {
    throw new Error(`count ${count} exceeds the ${combinations.length} distinct combinations`);
  }

  // Fisher-Yates with the seeded RNG: an unbiased shuffle, unlike sorting by a
  // random comparator.
  const rng = createRng(seed);
  for (let i = combinations.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = combinations[i] as [number, number, number];
    const b = combinations[j] as [number, number, number];
    combinations[i] = b;
    combinations[j] = a;
  }

  return combinations.slice(0, count).map(([s, y, c], index) => {
    const service = SEEDED_SERVICES[s] as (typeof SEEDED_SERVICES)[number];
    const symptom = SYMPTOMS[y] as (typeof SYMPTOMS)[number];
    const context = CONTEXTS[c] as (typeof CONTEXTS)[number];
    return {
      id: `TICKET-5${String(index + 1).padStart(3, "0")}`,
      summary: `Customers report ${service.noun} ${symptom}. ${context}`,
      parameters: { serviceSlug: service.slug, symptomIndex: y, contextIndex: c },
    };
  });
}

export const TICKET_COMBINATION_COUNT =
  SEEDED_SERVICES.length * SYMPTOMS.length * CONTEXTS.length;
