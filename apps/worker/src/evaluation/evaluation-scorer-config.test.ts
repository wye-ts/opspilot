import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVALUATION_SERVICE_TIMEOUT_MS,
  EvaluationScorerConfigError,
  resolveScorerSelectionFromEnv,
  type EnvRecord,
} from "./evaluation-scorer-config";

function env(overrides: Readonly<Record<string, string | undefined>> = {}): EnvRecord {
  return overrides;
}

describe("resolveScorerSelectionFromEnv — fail-closed scorer configuration", () => {
  it("defaults to the local scorer when EVALUATION_SCORER is unset or empty", () => {
    expect(resolveScorerSelectionFromEnv(env())).toEqual({ scorerMode: "LOCAL" });
    expect(resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "" }))).toEqual({ scorerMode: "LOCAL" });
    expect(resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "   " }))).toEqual({ scorerMode: "LOCAL" });
  });

  it("accepts an explicit local scorer", () => {
    expect(resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "local" }))).toEqual({ scorerMode: "LOCAL" });
  });

  it("accepts service mode with an absolute http(s) URL and the default bounded timeout", () => {
    expect(
      resolveScorerSelectionFromEnv(
        env({ EVALUATION_SCORER: "service", EVALUATION_SERVICE_URL: "http://127.0.0.1:8001" }),
      ),
    ).toEqual({
      scorerMode: "SERVICE",
      serviceUrl: "http://127.0.0.1:8001",
      timeoutMs: DEFAULT_EVALUATION_SERVICE_TIMEOUT_MS,
    });
  });

  it("accepts an explicit bounded timeout in service mode", () => {
    expect(
      resolveScorerSelectionFromEnv(
        env({
          EVALUATION_SCORER: "service",
          EVALUATION_SERVICE_URL: "https://evaluation.internal:8001",
          EVALUATION_SERVICE_TIMEOUT_MS: "20000",
        }),
      ),
    ).toEqual({ scorerMode: "SERVICE", serviceUrl: "https://evaluation.internal:8001", timeoutMs: 20000 });
  });

  it("rejects an unrecognized scorer mode rather than silently falling back to local", () => {
    expect(() => resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "REMOTE" }))).toThrow(
      EvaluationScorerConfigError,
    );
    expect(() => resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "python" }))).toThrow(
      EvaluationScorerConfigError,
    );
  });

  it("requires EVALUATION_SERVICE_URL when service mode is selected", () => {
    expect(() => resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "service" }))).toThrow(
      EvaluationScorerConfigError,
    );
    expect(() =>
      resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "service", EVALUATION_SERVICE_URL: "" })),
    ).toThrow(EvaluationScorerConfigError);
  });

  it("rejects a non-absolute or non-http(s) service URL", () => {
    for (const bad of ["127.0.0.1:8001", "ftp://evaluation", "evaluation:8001", "http://", "postgres://db"]) {
      expect(() =>
        resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "service", EVALUATION_SERVICE_URL: bad })),
      ).toThrow(EvaluationScorerConfigError);
    }
  });

  it("rejects an out-of-bounds or non-integer timeout", () => {
    for (const bad of ["500", "999999", "1.5", "abc", "-1"]) {
      expect(() =>
        resolveScorerSelectionFromEnv(
          env({
            EVALUATION_SCORER: "service",
            EVALUATION_SERVICE_URL: "http://127.0.0.1:8001",
            EVALUATION_SERVICE_TIMEOUT_MS: bad,
          }),
        ),
      ).toThrow(EvaluationScorerConfigError);
    }
  });

  it("error messages name the offending variable but never interpolate its value", () => {
    expect(() => resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "service" }))).toThrowError(
      "EVALUATION_SERVICE_URL is required when EVALUATION_SCORER=service.",
    );
    expect(() => resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "bogus" }))).toThrowError(
      "EVALUATION_SCORER must be exactly 'local' or 'service'.",
    );
  });
});
