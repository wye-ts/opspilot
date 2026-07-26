const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const PORT_PATTERN = /^\d+$/;
const MIN_PORT = 1;
const MAX_PORT = 65535;

// Local dev binds 127.0.0.1 unless overridden; the container sets
// HOST=0.0.0.0 itself (Dockerfile ENV / render.yaml), so this default keeps
// local behaviour byte-identical.
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export class InvalidPortError extends Error {
  constructor(rawValue: string) {
    super(`Invalid PORT value: "${rawValue}". PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    this.name = "InvalidPortError";
  }
}

// A bad PORT must fail startup loudly rather than silently falling back to
// 3000 (see docs/08-cicd-deployment.md) — Number("abc") previously produced
// NaN and let app.listen() do something undefined.
export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? DEFAULT_HOST,
    port: resolvePort(env.PORT),
  };
}

function resolvePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort === "") return DEFAULT_PORT;
  if (!PORT_PATTERN.test(rawPort)) throw new InvalidPortError(rawPort);

  const port = Number(rawPort);
  if (port < MIN_PORT || port > MAX_PORT) throw new InvalidPortError(rawPort);
  return port;
}
