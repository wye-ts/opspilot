// A small, stable error taxonomy for remote (Python/FastAPI) evaluation
// scoring, introduced for OpsPilot #61 Phase 3. Every failure mode of the
// cross-service boundary is represented by exactly one category so the CLI
// and tests can distinguish "the service was unreachable" from "it returned
// garbage" without leaking anything unsafe.
//
// Deliberately NOT leaked by any of these messages: raw response bodies,
// raw Python/DB error text, URLs that could contain credentials, and full
// evaluation payloads.
export type EvaluationServiceErrorCategory =
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "MALFORMED_RESPONSE"
  | "UNSUPPORTED_VERSION";

export class EvaluationServiceError extends Error {
  constructor(
    public readonly category: EvaluationServiceErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "EvaluationServiceError";
  }
}

export class EvaluationServiceUnavailableError extends EvaluationServiceError {
  constructor(message = "The evaluation service is unreachable.") {
    super("SERVICE_UNAVAILABLE", message);
    this.name = "EvaluationServiceUnavailableError";
  }
}

export class EvaluationServiceTimeoutError extends EvaluationServiceError {
  constructor(message = "The evaluation service request timed out.") {
    super("TIMEOUT", message);
    this.name = "EvaluationServiceTimeoutError";
  }
}

export class EvaluationServiceHttpError extends EvaluationServiceError {
  constructor(public readonly statusCode: number) {
    super("HTTP_ERROR", `The evaluation service returned HTTP ${statusCode}.`);
    this.name = "EvaluationServiceHttpError";
  }
}

export class EvaluationServiceMalformedResponseError extends EvaluationServiceError {
  constructor(message = "The evaluation service returned a malformed response.") {
    super("MALFORMED_RESPONSE", message);
    this.name = "EvaluationServiceMalformedResponseError";
  }
}

export class EvaluationServiceUnsupportedVersionError extends EvaluationServiceError {
  constructor(message = "The evaluation service returned an unsupported contract version.") {
    super("UNSUPPORTED_VERSION", message);
    this.name = "EvaluationServiceUnsupportedVersionError";
  }
}
