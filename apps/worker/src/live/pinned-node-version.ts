import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Refuses to start a PAID live script when the running Node major version does
 * not match the repository's pinned one.
 *
 * WHY THIS EXISTS (issue #125, docs/reviews/49):
 *
 * Whether the process speaks HTTP/1.1 or HTTP/2 to Anthropic is decided by the
 * undici bundled with Node — not by the Anthropic SDK, which calls
 * `globalThis.fetch` and inherits the process's global dispatcher. Probed
 * against the real endpoint:
 *
 *   node 22.21.0 (.nvmrc, Dockerfile, CI)  -> ALPN http/1.1
 *   node 24.18.0                           -> ALPN http/1.1
 *   node 26.7.0                            -> ALPN h2
 *
 * Under h2 every request shares one session, so a single TLS record fault
 * ("bad record mac") destroys the session and every subsequent request fails in
 * under a millisecond without leaving the machine — for the life of the
 * process. Rebuilding the SDK client does not recover it. That cost a real
 * measurement 35 of 49 billed invocations across seven rounds; the 14 that
 * survived arrived in contiguous healthy windows, so they are not 14
 * independent samples.
 *
 * The deployed API is not exposed to this: Dockerfile and CI both pin Node 22,
 * which negotiates http/1.1, where a TLS fault kills one socket and the next
 * request opens another. The gap is exactly here — apps/worker's paid scripts
 * are invoked with a bare `node`, which takes whatever the shell's default is.
 *
 * This is the SECOND time this mismatch has produced a wrong conclusion about
 * repository state. docs/reviews/37 §4.1 (commit 4e7f9ae) was the first: four
 * apps/web localStorage failures read as a repository defect, actually Node 26
 * vs .nvmrc's 22. That one cost a misattributed milestone prerequisite. This
 * one cost money and the only evidence channel that can observe real model
 * behaviour at all — the evaluation harness scripts every provider turn from a
 * fixture, so a LIVE run is the only thing that can produce that evidence.
 *
 * WHAT THIS DOES NOT CLAIM: that Node 22 prevents TLS faults. It prevents one
 * failure chain that requires an h2 session. A TLS fault on HTTP/1.1 is still
 * possible and costs one socket.
 */

export class NodeVersionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeVersionGateError";
  }
}

export interface NodeVersionGateResult {
  readonly expectedMajor: number;
  readonly expectedVersion: string;
  readonly runningVersion: string;
}

/**
 * The repository root, from this file's own location. Resolved from
 * `import.meta.dirname` rather than `process.cwd()`: these scripts are run
 * through pnpm filters from varying working directories, and a cwd-relative
 * path would resolve differently depending on where the command was typed.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * Parses the contents of a .nvmrc into a major version number.
 *
 * Accepts the forms nvm itself writes — a bare version, a `v` prefix, and
 * surrounding whitespace/newline. Anything else throws rather than guessing: a
 * gate that silently accepts an unparseable pin is worse than no gate, because
 * it reports safety it never checked.
 */
export function parseNvmrcMajor(contents: string): { major: number; version: string } {
  const version = contents.trim().replace(/^v/i, "");

  // Deliberately not a full semver parse. The file is a version pin written by
  // nvm; a shape it never produces means something is wrong and the caller
  // should hear about it, not have it normalized away.
  const match = /^(\d+)(?:\.\d+)*$/.exec(version);
  if (match === null) {
    throw new NodeVersionGateError(
      `Could not read a Node version from .nvmrc (found: ${JSON.stringify(contents.trim())}). ` +
        "This gate cannot confirm the runtime is safe for a paid live run, so it refuses to start.",
    );
  }

  return { major: Number(match[1]), version };
}

/** The running major version, from `process.versions.node` (e.g. "22.21.0" -> 22). */
export function parseRunningMajor(nodeVersion: string): number {
  const major = Number(nodeVersion.split(".")[0]);
  if (!Number.isInteger(major)) {
    throw new NodeVersionGateError(
      `Could not read the running Node version (found: ${JSON.stringify(nodeVersion)}).`,
    );
  }
  return major;
}

export interface AssertPinnedNodeOptions {
  /** Overridden only by tests; production callers use the real values. */
  readonly readNvmrc?: () => string;
  readonly runningVersion?: string;
}

/**
 * Throws unless the running Node's MAJOR version matches .nvmrc's.
 *
 * Major only, deliberately. A patch-level difference does not change the
 * bundled undici and therefore cannot change the transport this gate exists to
 * protect; failing on one would make the gate fire for reasons it cannot
 * justify, and a gate that cries wolf gets bypassed.
 */
export function assertPinnedNodeVersion(
  scriptName: string,
  options: AssertPinnedNodeOptions = {},
): NodeVersionGateResult {
  const readNvmrc =
    options.readNvmrc ?? (() => readFileSync(resolve(REPO_ROOT, ".nvmrc"), "utf8"));

  let contents: string;
  try {
    contents = readNvmrc();
  } catch (cause) {
    // Fails CLOSED, and distinguishably from a version mismatch. The cause is
    // deliberately not printed: it carries a filesystem path, and the remedy
    // does not depend on it.
    throw new NodeVersionGateError(
      `[${scriptName}] Could not read .nvmrc, so the runtime cannot be confirmed safe for a paid ` +
        "live run. Refusing to start rather than risk spending on an unverified runtime.",
    );
  }

  const { major: expectedMajor, version: expectedVersion } = parseNvmrcMajor(contents);
  const runningVersion = options.runningVersion ?? process.versions.node;
  const runningMajor = parseRunningMajor(runningVersion);

  if (runningMajor !== expectedMajor) {
    throw new NodeVersionGateError(
      `[${scriptName}] REFUSING TO START: this script spends real money, and the running Node ` +
        `version is not the one this repository pins.\n` +
        `  expected: v${expectedVersion} (major ${expectedMajor}, from .nvmrc)\n` +
        `  running:  v${runningVersion} (major ${runningMajor})\n` +
        `\n` +
        `Node 26+ negotiates HTTP/2 to the Anthropic API, where one TLS fault destroys the ` +
        `shared session and every later request fails in under a millisecond for the life of ` +
        `the process. That cost a previous measurement 35 of 49 billed invocations ` +
        `(issue #125, docs/reviews/49).\n` +
        `\n` +
        `Fix:  nvm use            # reads .nvmrc\n` +
        `  or:  export PATH="$HOME/.nvm/versions/node/v${expectedVersion}/bin:$PATH"\n` +
        `Then re-run. Verify with: node --version`,
    );
  }

  return { expectedMajor, expectedVersion, runningVersion };
}
