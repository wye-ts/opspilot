import type { PrismaClientHandle } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import { HealthController } from "./health.controller";

function buildHandle(queryRaw: ReturnType<typeof vi.fn>): PrismaClientHandle {
  return { prisma: { $queryRaw: queryRaw } } as unknown as PrismaClientHandle;
}

describe("HealthController", () => {
  describe("live", () => {
    it("returns ok without touching the database", () => {
      const queryRaw = vi.fn();
      const controller = new HealthController(buildHandle(queryRaw));

      const result = controller.live();

      expect(result).toEqual({ data: { status: "ok" } });
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("ready", () => {
    it("returns ready when the database query succeeds", async () => {
      const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
      const controller = new HealthController(buildHandle(queryRaw));

      const result = await controller.ready();

      expect(result).toEqual({ data: { status: "ready" } });
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("throws PERSISTENCE_UNAVAILABLE (503) when the database query fails, without leaking the raw error", async () => {
      const sentinelSecret = "postgres://user:sk-super-secret@host/db";
      const queryRaw = vi.fn().mockRejectedValue(new Error(`connection failed: ${sentinelSecret}`));
      const controller = new HealthController(buildHandle(queryRaw));

      await expect(controller.ready()).rejects.toMatchObject({
        code: "PERSISTENCE_UNAVAILABLE",
        status: 503,
      });

      try {
        await controller.ready();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).not.toContain(sentinelSecret);
      }
    });
  });
});
