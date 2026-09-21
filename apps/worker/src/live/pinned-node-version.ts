import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Refuses to start a PAID live script when the running Node version does not
 * match the one this repository pins.
 *
 * WHY THIS EXISTS (issue #125, docs/reviews/49):
 *
 * Whether the process speaks HTTP/1.1 or HTTP/2 to Anthropic is decided by the
 * undici bundled with Node — not by the Anthropic SDK, which calls
 * `globalThis.fetch` and inherits the process's global dispatcher. Probed
 * against the real endpoint:
 *
 *   node 22.21.0 (.nvmrc, Dockerfile, CI)  -> undici 6.22.0 -> ALPN http/1.1
 *   node 24.18.0                           -> undici 7.28.0 -> ALPN http/1.1
 *   node 26.7.0                            -> undici 8.9.0  -> ALPN h2
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
 * WHAT THIS DOES NOT CLAIM: that the pinned version prevents TLS faults. It
 * prevents one failure chain that requires an h2 session. A TLS fault on
 * HTTP/1.1 is still possible and costs one socket.
 */

export class NodeVersionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeVersionGateError";
  }
}

export interface NodeVersionGateResult {
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

export interface PinnedVersion {
  /** The components .nvmrc actually declares, e.g. [22, 21, 0]. */
  readonly components: readonly number[];
  /** The normalized version string, e.g. "22.21.0". */
  readonly version: string;
}

/**
 * Parses the contents of a .nvmrc into its version components.
 *
 * Accepts the forms nvm itself writes — a bare version, a `v` prefix, and
 * surrounding whitespace/newline. Anything else throws rather than guessing: a
 * gate that silently accepts an unparseable pin is worse than no gate, because
 * it reports safety it never checked. An alias (`lts/*`, `node`) is precisely
 * such a case — it is a legitimate .nvmrc value that this gate cannot resolve.
 */
export function parseNvmrcVersion(contents: string): PinnedVersion {
  const version = contents.trim().replace(/^v/i, "");

  // Deliberately not a full semver parse. The file is a version pin written by
  // nvm; a shape it never produces means something is wrong and the caller
  // should hear about it, not have it normalized away.
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    throw new NodeVersionGateError(
      `Could not read a Node version from .nvmrc (found: ${JSON.stringify(contents.trim())}). ` +
        "This gate cannot confirm the runtime is safe for a paid live run, so it refuses to start.",
    );
  }

  return { components: version.split(".").map(Number), version };
}

/** The running version's components, from `process.versions.node`. */
export function parseRunningVersion(nodeVersion: string): readonly number[] {
  const normalized = nodeVersion.trim().replace(/^v/i, "");
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) {
    throw new NodeVersionGateError(
      `Could not read the running Node version (found: ${JSON.stringify(nodeVersion)}).`,
    );
  }
  return normalized.split(".").map(Number);
}

export interface AssertPinnedNodeOptions {
  /** Overridden only by tests; production callers use the real values. */
  readonly readNvmrc?: () => string;
  readonly runningVersion?: string;
}

/**
 * Throws unless the running Node matches every version component `.nvmrc`
 * declares.
 *
 * EXACT, not major-only. An earlier draft of this guard compared the major
 * version alone, reasoning that "a patch difference cannot change the bundled
 * undici". Independent review refuted it, and the release history confirms the
 * refutation: Node 22.21.0 bundles undici 6.22.0, while later 22.x releases
 * ship 6.24.1, 6.27.0 and 6.28.0. The undici version — the thing that actually
 * decides the transport this guard exists to protect — moves across MINOR
 * releases, so a major-only comparison admits an unverified network stack while
 * reporting that the runtime matched the pin.
 *
 * Exact matching costs nothing in practice: `.nvmrc` pins one version, the
 * Dockerfile pins the same one, and `nvm use` reads `.nvmrc` and selects
 * exactly it. Comparing only the components `.nvmrc` declares keeps a
 * coarser pin (a bare `22`) meaningful rather than unsatisfiable.
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
  } catch {
    // Fails CLOSED, and distinguishably from a version mismatch. The cause is
    // deliberately not printed: it carries a filesystem path, and the remedy
    // does not depend on it.
    throw new NodeVersionGateError(
      `[${scriptName}] Could not read .nvmrc, so the runtime cannot be confirmed safe for a paid ` +
        "live run. Refusing to start rather than risk spending on an unverified runtime.",
    );
  }

  const { components: expected, version: expectedVersion } = parseNvmrcVersion(contents);
  const runningVersion = options.runningVersion ?? process.versions.node;
  const running = parseRunningVersion(runningVersion);

  const matches = expected.every((component, index) => running[index] === component);

  if (!matches) {
    throw new NodeVersionGateError(
      `[${scriptName}] REFUSING TO START: this script spends real money, and the running Node ` +
        `version is not the one this repository pins.\n` +
        `  expected: v${expectedVersion} (from .nvmrc)\n` +
        `  running:  v${runningVersion}\n` +
        `\n` +
        `The Anthropic SDK uses globalThis.fetch, so the network transport is chosen by the undici ` +
        `bundled with Node, not by this repository. Node 26+ negotiates HTTP/2, where one TLS fault ` +
        `destroys the shared session and every later request fails in under a millisecond for the ` +
        `life of the process — that cost a previous measurement 35 of 49 billed invocations ` +
        `(issue #125, docs/reviews/49). The bundled undici also moves across Node MINOR releases, ` +
        `so only the pinned version has actually been verified.\n` +
        `\n` +
        `Fix:  nvm use            # reads .nvmrc\n` +
        `  or:  export PATH="$HOME/.nvm/versions/node/v${expectedVersion}/bin:$PATH"\n` +
        `Then re-run. Verify with: node --version`,
    );
  }

  return { expectedVersion, runningVersion };
}
