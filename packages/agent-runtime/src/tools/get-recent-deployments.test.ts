import { describe, expect, it } from "vitest";

import { getRecentDeploymentsTool } from "./get-recent-deployments";

describe("get_recent_deployments", () => {
  it("names itself with the stable tool name the catalog and eval cases reference", () => {
    expect(getRecentDeploymentsTool.name).toBe("get_recent_deployments");
  });

  describe("input schema", () => {
    it("accepts a well-formed serviceSlug", () => {
      expect(
        getRecentDeploymentsTool.inputSchema.safeParse({ serviceSlug: "notification-service" }).success,
      ).toBe(true);
    });

    it("rejects a missing, empty, or oversized serviceSlug", () => {
      expect(getRecentDeploymentsTool.inputSchema.safeParse({}).success).toBe(false);
      expect(getRecentDeploymentsTool.inputSchema.safeParse({ serviceSlug: "" }).success).toBe(false);
      expect(
        getRecentDeploymentsTool.inputSchema.safeParse({ serviceSlug: "x".repeat(101) }).success,
      ).toBe(false);
    });

    it("rejects an unknown extra key rather than silently ignoring it", () => {
      // .strict(): a model that invents a `timeRange` argument must get a
      // TOOL_INPUT_INVALID failure, not a silently-dropped parameter that
      // makes the answer look scoped when it was not.
      expect(
        getRecentDeploymentsTool.inputSchema.safeParse({
          serviceSlug: "auth-service",
          timeRange: "24h",
        }).success,
      ).toBe(false);
    });
  });

  describe("output schema", () => {
    const validRow = {
      deploymentId: "deploy-1",
      version: "1.0.0",
      outcome: "SUCCEEDED" as const,
      deployedAt: "2026-09-01T12:00:00.000Z",
    };

    it("accepts a well-formed result", () => {
      expect(
        getRecentDeploymentsTool.outputSchema.safeParse({
          serviceSlug: "auth-service",
          knownService: true,
          deployments: [validRow],
        }).success,
      ).toBe(true);
    });

    it("rejects a deployedAt that is not a canonical ISO-8601 UTC datetime", () => {
      // The whole point of validating this field: a hand-edited fixture must
      // not be able to smuggle a non-date past the tool boundary and have the
      // model reason from it, or silently break most-recent-first ordering.
      for (const deployedAt of [
        "yesterday",
        "2026-13-99",
        "2026-02-30T00:00:00Z",
        "2026-09-01",
        "",
      ]) {
        expect(
          getRecentDeploymentsTool.outputSchema.safeParse({
            serviceSlug: "auth-service",
            knownService: true,
            deployments: [{ ...validRow, deployedAt }],
          }).success,
        ).toBe(false);
      }
    });

    it("rejects an outcome outside the closed vocabulary", () => {
      expect(
        getRecentDeploymentsTool.outputSchema.safeParse({
          serviceSlug: "auth-service",
          knownService: true,
          deployments: [{ ...validRow, outcome: "IN_PROGRESS" }],
        }).success,
      ).toBe(false);
    });

    it("bounds the number of returned deployments", () => {
      expect(
        getRecentDeploymentsTool.outputSchema.safeParse({
          serviceSlug: "auth-service",
          knownService: true,
          deployments: Array.from({ length: 6 }, (_, index) => ({
            ...validRow,
            deploymentId: `deploy-${index}`,
          })),
        }).success,
      ).toBe(false);
    });

    it("requires knownService — an omitted flag must not default to a claim", () => {
      expect(
        getRecentDeploymentsTool.outputSchema.safeParse({
          serviceSlug: "auth-service",
          deployments: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("execution", () => {
    it("distinguishes an unknown service from a known one with no deployments", async () => {
      // THE load-bearing distinction of this tool. A bare empty array would let
      // a model ground "no recent deploys, so deployment is ruled out" on the
      // mere absence of a fixture entry — an unearned negative claim. Same
      // reasoning as get_service_status returning UNKNOWN rather than
      // defaulting to OPERATIONAL.
      const unknown = await getRecentDeploymentsTool.execute({ serviceSlug: "not-a-real-service" });
      expect(unknown).toEqual({
        serviceSlug: "not-a-real-service",
        knownService: false,
        deployments: [],
      });

      const knownButQuiet = await getRecentDeploymentsTool.execute({ serviceSlug: "billing-service" });
      expect(knownButQuiet).toEqual({
        serviceSlug: "billing-service",
        knownService: true,
        deployments: [],
      });
    });

    it("treats an inherited Object key as an unknown service, not a seeded one", async () => {
      // A model can emit any schema-valid string. `constructor`, `toString`,
      // and friends are inherited from Object.prototype, so a plain
      // `table[slug]` lookup returns a function instead of undefined — which
      // then fails as a deployment list and takes the whole investigation down
      // with TOOL_EXECUTION_FAILED. These names are ordinary unknown services
      // and must answer like one.
      for (const serviceSlug of [
        "constructor",
        "__proto__",
        "toString",
        "hasOwnProperty",
        "valueOf",
      ]) {
        await expect(getRecentDeploymentsTool.execute({ serviceSlug })).resolves.toEqual({
          serviceSlug,
          knownService: false,
          deployments: [],
        });
      }
    });

    it("returns a service's deployments most-recent-first", async () => {
      const result = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: ReadonlyArray<{ deployedAt: string }> };

      const timestamps = result.deployments.map((entry) => Date.parse(entry.deployedAt));
      expect(timestamps.length).toBeGreaterThan(1);
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    });

    it("produces output conforming to its own outputSchema for every seeded service", async () => {
      for (const serviceSlug of [
        "notification-service",
        "billing-service",
        "auth-service",
        "not-a-real-service",
      ]) {
        const result = await getRecentDeploymentsTool.execute({ serviceSlug });
        expect(getRecentDeploymentsTool.outputSchema.safeParse(result).success).toBe(true);
      }
    });

    it("is deterministic: repeated execution yields identical output", async () => {
      const first = await getRecentDeploymentsTool.execute({ serviceSlug: "notification-service" });
      const second = await getRecentDeploymentsTool.execute({ serviceSlug: "notification-service" });

      // Byte-identical, not merely deep-equal-by-chance: the tool reads no
      // clock, no network, and no filesystem, so two calls in the same process
      // (or across a CI re-run) must serialize the same.
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it("does not expose the seeded fixture's own deployment RECORDS for mutation", async () => {
      // Distinct from the array-level case below: copying only the array still
      // shares every record object, so one mutated field would corrupt the
      // fixture for the rest of the process — and a later call could then fail
      // its own outputSchema, taking a whole investigation down with
      // TOOL_OUTPUT_INVALID.
      const first = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: Array<{ outcome: string; deployedAt: string }> };

      const originalOutcome = first.deployments[0]!.outcome;
      first.deployments[0]!.outcome = "TAMPERED";
      first.deployments[0]!.deployedAt = "yesterday";

      const second = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: Array<{ outcome: string }> };

      expect(second.deployments[0]!.outcome).toBe(originalOutcome);
      expect(second.deployments[0]).not.toBe(first.deployments[0]);
      expect(getRecentDeploymentsTool.outputSchema.safeParse(second).success).toBe(true);
    });

    it("does not expose the seeded fixture's own arrays for mutation", async () => {
      const result = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: unknown[] };
      const originalLength = result.deployments.length;

      result.deployments.push({ tampered: true });

      const second = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: unknown[] };
      expect(second.deployments).toHaveLength(originalLength);
    });
  });

  describe("the fixture's evidential shapes", () => {
    // These are asserted here, in the tool's own tests, because Issue #94's
    // evaluation cases depend on each shape existing. A fixture edit that
    // quietly removed one would otherwise only surface as a confusing eval
    // failure in another package.
    it("offers a problem-state service whose deployments are empty (deployment ruled OUT)", async () => {
      const result = (await getRecentDeploymentsTool.execute({ serviceSlug: "billing-service" })) as {
        knownService: boolean;
        deployments: unknown[];
      };
      expect(result.knownService).toBe(true);
      expect(result.deployments).toEqual([]);
    });

    it("offers a service whose most recent deployment was rolled back (unresolved LEAD)", async () => {
      const result = (await getRecentDeploymentsTool.execute({
        serviceSlug: "notification-service",
      })) as { deployments: ReadonlyArray<{ outcome: string }> };
      expect(result.deployments[0]?.outcome).toBe("ROLLED_BACK");
    });

    it("offers a service with an older failed deployment (ambiguous, supports nothing)", async () => {
      const result = (await getRecentDeploymentsTool.execute({ serviceSlug: "auth-service" })) as {
        deployments: ReadonlyArray<{ outcome: string }>;
      };
      expect(result.deployments.map((entry) => entry.outcome)).toContain("FAILED");
      expect(result.deployments[0]?.outcome).not.toBe("FAILED");
    });
  });
});
