import type { PrismaClientHandle } from "@opspilot/database";

// Once-guarded — safe to call more than once (a successful lifecycle close
// followed by a direct call from the bootstrap failure path, for instance)
// without closing the underlying pool twice. Extracted from main.ts as a
// narrowly scoped, directly unit-testable helper — see safe-close.test.ts.
export function createSafeClose(handle: PrismaClientHandle): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    try {
      await handle.close();
    } catch {
      // Suppress close internals — never surfaced publicly.
    }
  };
}

export interface ClosableApp {
  close(): Promise<void>;
}

// The required bootstrap-failure close sequence (docs/12-agent-run-api.md):
// attempt app.close() if an app exists, suppress any close error, then
// always call the same guarded safeClose() — never skipped, even when
// app.close() itself throws. Extracted from main.ts's bootstrap() catch
// block as its own helper purely so it can be exercised directly by a unit
// test without standing up a real Nest application.
export async function closeOnBootstrapFailure(
  app: ClosableApp | undefined,
  safeClose: () => Promise<void>,
): Promise<void> {
  if (app) {
    try {
      await app.close();
    } catch {
      // Suppress shutdown internals.
    }
  }
  await safeClose();
}
