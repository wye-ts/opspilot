import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  // OpsPilot #61 Phase 4 default cutover: EVALUATION_SCORER unset/empty now
  // resolves to SERVICE, not LOCAL. It still goes through the exact same
  // required-EVALUATION_SERVICE_URL check as an explicit
  // EVALUATION_SCORER=service (see the "fails closed" test below) — the
  // default never silently falls back to local just because the URL is
  // absent.
  it("defaults to the service scorer when EVALUATION_SCORER is unset or empty", () => {
    const withUrl = { EVALUATION_SERVICE_URL: "http://127.0.0.1:8001" };
    const expected = {
      scorerMode: "SERVICE",
      serviceUrl: "http://127.0.0.1:8001",
      timeoutMs: DEFAULT_EVALUATION_SERVICE_TIMEOUT_MS,
    };
    expect(resolveScorerSelectionFromEnv(env(withUrl))).toEqual(expected);
    expect(resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "", ...withUrl }))).toEqual(expected);
    expect(resolveScorerSelectionFromEnv(env({ EVALUATION_SCORER: "   ", ...withUrl }))).toEqual(expected);
  });

  // The default/service mode is still subject to the exact same fail-closed
  // required-URL rule as an explicit EVALUATION_SCORER=service — it must
  // never silently resolve to local just because EVALUATION_SERVICE_URL is
  // missing.
  it("fails closed with the existing sanitized config error when EVALUATION_SCORER is omitted and EVALUATION_SERVICE_URL is missing", () => {
    expect(() => resolveScorerSelectionFromEnv(env())).toThrow(EvaluationScorerConfigError);
    expect(() => resolveScorerSelectionFromEnv(env())).toThrowError(
      "EVALUATION_SERVICE_URL is required when EVALUATION_SCORER=service.",
    );
  });

  it("accepts an explicit local scorer (the frozen v1 parity/regression oracle) — works without any service configuration", () => {
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

  // Structural proof, not just a behavioral one: this module resolves the
  // scorer selection purely from the three EVALUATION_SCORER*/EVALUATION_SERVICE_*
  // env values it is handed — it contains no network/HTTP call surface at all,
  // so there is no code path here (or anywhere reachable from it) that could
  // probe the service's reachability and dynamically switch modes based on
  // the result.
  it("contains no network/HTTP call surface — selection can never depend on service reachability", () => {
    const configSourcePath = join(dirname(fileURLToPath(import.meta.url)), "evaluation-scorer-config.ts");
    const source = readFileSync(configSourcePath, "utf8");

    for (const forbidden of ["fetch(", "http.request", "https.request", "XMLHttpRequest", "node-fetch", "axios"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
