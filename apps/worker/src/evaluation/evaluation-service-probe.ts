// Fail-closed reachability probe for the cross-service parity suite (OpsPilot
// #61 Phase 3, final targeted fixes). The authoritative parity tests may only
// run against a proven-healthy evaluation service; when the suite is REQUIRED
// (EVALUATION_SERVICE_REQUIRED=1, which CI and `test:eval:cross-service` set),
// any inability to prove health must FAIL the suite — refused connection,
// timeout, a non-2xx /health, or a malformed health body all throw, so the
// parity suite can never silently skip in the required path. When the suite is
// optional (a local developer run without the flag), an absent/unhealthy
// service just reports "unreachable" so the caller may skip, which is the
// intended local workflow.
//
// This module is deliberately small and free of the scorer/error-taxonomy
// imports so it can be unit-tested against a real loopback HTTP server without
// dragging in the evaluation service client.

// Bounded time to wait for the /health probe. Deliberately separate from the
// scoring request timeout (EVALUATION_SERVICE_TIMEOUT_MS): the probe is a
// setup concern for the parity suite, not a scoring call.
export const CROSS_SERVICE_PROBE_TIMEOUT_MS = 5_000;

export class EvaluationServiceProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationServiceProbeError";
  }
}

export interface EvaluationServiceProbeOptions {
  readonly serviceUrl: string;
  readonly required: boolean;
  readonly timeoutMs: number;
}

// Probes `<serviceUrl>/health`. Returns true only when the health response is
// a 2xx with a JSON-object body. Returns false (unreachable — caller may skip)
// when `required` is false; throws EvaluationServiceProbeError for the same
// failure modes when `required` is true, so a required parity run fails closed.
export async function probeEvaluationServiceHealth(
  options: EvaluationServiceProbeOptions,
): Promise<boolean> {
  const { serviceUrl, required, timeoutMs } = options;
  const normalizedUrl = serviceUrl.replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${normalizedUrl}/health`, { signal: controller.signal });
  } catch {
    // Refused connection, DNS, TLS, or our own timeout abort.
    if (required) {
      throw new EvaluationServiceProbeError(
        "evaluation service not reachable while EVALUATION_SERVICE_REQUIRED=1.",
      );
    }
    return false;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (required) {
      throw new EvaluationServiceProbeError(
        `evaluation service /health returned HTTP ${response.status} while EVALUATION_SERVICE_REQUIRED=1.`,
      );
    }
    return false;
  }

  // A 2xx alone is not proof of health if the body is garbage — require a
  // JSON-object body so "reachable but not the evaluation service" also fails
  // closed in required mode.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (required) {
      throw new EvaluationServiceProbeError(
        "evaluation service /health returned a non-JSON body while EVALUATION_SERVICE_REQUIRED=1.",
      );
    }
    return false;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    if (required) {
      throw new EvaluationServiceProbeError(
        "evaluation service /health returned an unexpected body while EVALUATION_SERVICE_REQUIRED=1.",
      );
    }
    return false;
  }

  return true;
}
