export type PersistenceErrorCode =
  | "PERSISTENCE_UNAVAILABLE"
  | "PERSISTENCE_CONFLICT"
  | "PERSISTENCE_VALIDATION_FAILED"
  | "PERSISTENCE_NOT_FOUND"
  // A candidate canonical event stream failed reducer validation
  // (InvestigationEventContractError) inside its own write transaction, or a
  // stored canonical stream was found corrupt on read (e.g. a terminal
  // status with no matching terminal event, or vice versa). This is an
  // emitter/repository contract defect or stored-data corruption — never an
  // AgentOrchestratorErrorCode, never a client-input error, and never a
  // public API code (that mapping is Phase B's job). See
  // docs/reviews/21-issue-37-incremental-event-persistence-plan.md §4.
  | "PERSISTENCE_EVENT_STREAM_INVALID";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistenceError";
    this.code = code;
  }
}

function extractDriverCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const withCode = error as { code?: unknown; meta?: { code?: unknown } };
  if (typeof withCode.code === "string") return withCode.code;
  if (typeof withCode.meta?.code === "string") return withCode.meta.code;
  return undefined;
}

const UNIQUE_VIOLATION_CODES = new Set(["P2002", "23505"]);
const CHECK_VIOLATION_CODES = new Set(["23514"]);
const NOT_FOUND_CODES = new Set(["P2025"]);
const CONNECTION_CODES = new Set(["P1001", "P1002", "P1017", "ECONNREFUSED", "ETIMEDOUT"]);

// Normalizes any Prisma/driver failure into one of the four stable
// PersistenceErrorCode categories, with a fixed, sanitized message — never
// the raw Prisma message, connection string, or SQL text (see
// docs/11-agent-run-persistence.md).
export function normalizeDatabaseError(error: unknown, context: string): PersistenceError {
  if (error instanceof PersistenceError) return error;

  const driverCode = extractDriverCode(error);

  if (driverCode && UNIQUE_VIOLATION_CODES.has(driverCode)) {
    return new PersistenceError(
      "PERSISTENCE_CONFLICT",
      `${context}: a conflicting row already exists.`,
      { cause: error },
    );
  }
  if (driverCode && CHECK_VIOLATION_CODES.has(driverCode)) {
    return new PersistenceError(
      "PERSISTENCE_CONFLICT",
      `${context}: the write violated a database invariant.`,
      { cause: error },
    );
  }
  if (driverCode && NOT_FOUND_CODES.has(driverCode)) {
    return new PersistenceError(
      "PERSISTENCE_NOT_FOUND",
      `${context}: the referenced row was not found.`,
      { cause: error },
    );
  }
  if (driverCode && CONNECTION_CODES.has(driverCode)) {
    return new PersistenceError(
      "PERSISTENCE_UNAVAILABLE",
      `${context}: the database is unavailable.`,
      { cause: error },
    );
  }
  return new PersistenceError(
    "PERSISTENCE_UNAVAILABLE",
    `${context}: an unexpected database error occurred.`,
    { cause: error },
  );
}
