import type { PrismaClientHandle } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { closeOnBootstrapFailure, createSafeClose } from "./safe-close";

function buildHandle(close: () => Promise<void>): PrismaClientHandle {
  return { prisma: {} as PrismaClientHandle["prisma"], close };
}

describe("createSafeClose", () => {
  it("repeated calls invoke handle.close exactly once", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const safeClose = createSafeClose(buildHandle(close));

    await safeClose();
    await safeClose();
    await safeClose();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a close error never escapes the returned closure", async () => {
    const close = vi.fn().mockRejectedValue(new Error("raw pg pool failure, never surfaced"));
    const safeClose = createSafeClose(buildHandle(close));

    await expect(safeClose()).resolves.toBeUndefined();
    // The once-guard still applies even though the first call's close()
    // rejected — a second call must not attempt to close again.
    await safeClose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("two independent createSafeClose calls guard independently", async () => {
    const closeA = vi.fn().mockResolvedValue(undefined);
    const closeB = vi.fn().mockResolvedValue(undefined);
    const safeCloseA = createSafeClose(buildHandle(closeA));
    const safeCloseB = createSafeClose(buildHandle(closeB));

    await safeCloseA();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();

    await safeCloseB();
    expect(closeB).toHaveBeenCalledTimes(1);
  });
});

describe("closeOnBootstrapFailure", () => {
  it("app.close() failure is followed by direct safeClose()", async () => {
    const app = { close: vi.fn().mockRejectedValue(new Error("raw Nest shutdown failure")) };
    const safeClose = vi.fn().mockResolvedValue(undefined);

    await expect(closeOnBootstrapFailure(app, safeClose)).resolves.toBeUndefined();

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(safeClose).toHaveBeenCalledTimes(1);
  });

  it("safeClose is still called when app.close() succeeds (unconditional, not just on failure)", async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const safeClose = vi.fn().mockResolvedValue(undefined);

    await closeOnBootstrapFailure(app, safeClose);

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(safeClose).toHaveBeenCalledTimes(1);
  });

  it("calls safeClose even when no app was ever created", async () => {
    const safeClose = vi.fn().mockResolvedValue(undefined);

    await closeOnBootstrapFailure(undefined, safeClose);

    expect(safeClose).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when both app.close() and safeClose() would otherwise reject", async () => {
    const app = { close: vi.fn().mockRejectedValue(new Error("close failure")) };
    // safeClose itself is documented as never rejecting (createSafeClose
    // swallows its own errors), but this proves closeOnBootstrapFailure
    // does not add its own unguarded await around app.close() either.
    const safeClose = vi.fn().mockResolvedValue(undefined);

    await expect(closeOnBootstrapFailure(app, safeClose)).resolves.toBeUndefined();
  });
});
