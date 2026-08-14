import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CROSS_SERVICE_PROBE_TIMEOUT_MS,
  EvaluationServiceProbeError,
  probeEvaluationServiceHealth,
} from "./evaluation-service-probe";

// ---------------------------------------------------------------------------
// The cross-service parity reachability probe (OpsPilot #61 Phase 3, final
// targeted fixes): in REQUIRED mode any inability to prove the evaluation
// service is healthy must fail closed (throw) so the parity suite can never
// silently skip with zero assertions; in optional mode an absent service may
// still report unreachable so the caller can skip (the intended local
// workflow). Every probe here runs against a real 127.0.0.1 HTTP server —
// no fetch mocking.
// ---------------------------------------------------------------------------

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: RequestHandler): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const activeServers: Server[] = [];
afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(stopServer));
});

// Binds an ephemeral loopback port and closes it again, so nothing is
// listening at the returned URL — the deterministic "service unreachable"
// target.
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `http://127.0.0.1:${port}`;
}

function respondHealth(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

describe("probeEvaluationServiceHealth — required mode fails closed", () => {
  it("refused connection => throws, never reports reachable (required test 1)", async () => {
    const url = await closedPortUrl();
    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(EvaluationServiceProbeError);
  });

  it("a hanging /health (timeout) => throws, not a skip (required mode)", async () => {
    const { server, url } = await startServer((_req, _res) => {});
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(EvaluationServiceProbeError);
  });

  it("a non-2xx /health (500) => throws, not a skip (required test 2)", async () => {
    const { server, url } = await startServer((_req, res) => respondHealth(res, 500, { detail: "boom" }));
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(EvaluationServiceProbeError);
  });

  it("a 2xx /health with a non-JSON body => throws (malformed health fails closed)", async () => {
    const { server, url } = await startServer((_req, res) => respondHealth(res, 200, "ok not json"));
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(EvaluationServiceProbeError);
  });

  it("a 2xx /health with a JSON non-object body => throws", async () => {
    const { server, url } = await startServer((_req, res) => respondHealth(res, 200, [1, 2, 3]));
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(EvaluationServiceProbeError);
  });

  it("only a successful healthy response permits the parity tests to run (required mode returns true)", async () => {
    const { server, url } = await startServer((_req, res) =>
      respondHealth(res, 200, { status: "ok", service: "opspilot-evaluation" }),
    );
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: true, timeoutMs: 2_000 }),
    ).resolves.toBe(true);
  });
});

describe("probeEvaluationServiceHealth — optional mode may skip (required test 3)", () => {
  it("refused connection => resolves false so the caller can skip", async () => {
    const url = await closedPortUrl();
    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: false, timeoutMs: 2_000 }),
    ).resolves.toBe(false);
  });

  it("a non-2xx /health => resolves false, not true", async () => {
    const { server, url } = await startServer((_req, res) => respondHealth(res, 503, { detail: "down" }));
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: false, timeoutMs: 2_000 }),
    ).resolves.toBe(false);
  });

  it("a healthy /health => resolves true", async () => {
    const { server, url } = await startServer((_req, res) => respondHealth(res, 200, { status: "ok" }));
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: url, required: false, timeoutMs: 2_000 }),
    ).resolves.toBe(true);
  });
});

describe("probeEvaluationServiceHealth — trailing-slash and timeout bounds", () => {
  it("normalizes a trailing slash before building the /health URL", async () => {
    const { server, url } = await startServer((req, res) => {
      expect(req.url).toBe("/health");
      respondHealth(res, 200, { status: "ok" });
    });
    activeServers.push(server);

    await expect(
      probeEvaluationServiceHealth({ serviceUrl: `${url}/`, required: false, timeoutMs: 2_000 }),
    ).resolves.toBe(true);
  });

  it("exposes the bounded probe timeout constant used by the parity suite", () => {
    expect(CROSS_SERVICE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
