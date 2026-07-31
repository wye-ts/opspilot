import { z } from "zod";

/**
 * The header carrying a LIVE run's CLIENT REQUEST KEY.
 *
 * WHY THIS EXISTS. A `POST /v1/agent-jobs/:jobId/runs` exception does not prove
 * that no run was created. Two ambiguous shapes are unavoidable:
 *
 *   1. Finalization persistence fails AFTER the provider executed and after the
 *      budget was reconciled. The API answers PERSISTENCE_UNAVAILABLE — the same
 *      code it also uses for a pre-run database outage.
 *   2. The network loses a successful response after the server committed,
 *      executed, and finalized. The browser sees a transport failure that is
 *      indistinguishable from a pre-execution refusal.
 *
 * In both cases the honest recovery is "ask again for the same thing", and the
 * server must be able to recognize that it is the SAME thing. Allowlisting
 * frontend error codes cannot do it: a transport failure has no code at all, and
 * PERSISTENCE_UNAVAILABLE is raised at both the pre-run and post-execution
 * stages. Only a durable key carried by the client can distinguish a repeat from
 * a new request.
 *
 * NOT A CREDENTIAL. The key authorizes nothing — it names a request. It is
 * ordinary React state on the browser side, it may appear in a response
 * `Location` header's target row, and it is deliberately NOT stored alongside
 * the live access token. It is equally deliberately not written to logs: it is
 * not secret, but it is not useful there either, and log lines about paid runs
 * are the wrong place to accumulate client-supplied identifiers.
 */
export const LIVE_RUN_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/**
 * A UUID, exactly — not an opaque client string.
 *
 * The column it lands in is PostgreSQL `uuid`, so the format is enforced by the
 * database as well as here, and the two cannot drift into disagreement. A UUID
 * also bounds the value's length by construction, which is what makes the
 * "oversized key" case a plain validation failure rather than a storage concern.
 *
 * Case is NOT normalized here: PostgreSQL's `uuid` type stores a canonical
 * lowercase form, so `A1B2…` and `a1b2…` are already the same key once cast.
 * Whitespace is not trimmed either — HTTP strips optional surrounding whitespace
 * from a field value before this ever sees it, and accepting a value that only
 * becomes valid after rewriting it would make the wire contract fuzzier than the
 * column.
 */
export const LiveRunIdempotencyKeySchema = z.string().uuid();
