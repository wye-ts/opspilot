// Disposable stub `codex` binary for Harness Foundation tests. The real
// codex-cli is never invoked in tests — this script mimics just enough of
// `codex exec`'s interface (responds to `--version`, accepts
// `--output-last-message <path>`, reads a prompt from stdin) for the
// harness's own contract to be exercised, with behavior switched by env var
// so one script covers every scenario the tests need: success, nonzero
// exit, hang (for timeout tests), missing output, malformed output,
// TOCTOU-simulating mutation of fixture state (working tree file,
// review.json, review.diff, or a task declaration), or toggling a tracked
// file's executable bit alone (content untouched), as a side effect of the
// stub's own execution before it returns, an ABA swap-and-restore that also
// captures the invocation-scoped evidence snapshot sitting alongside
// `--output-last-message` (proving what the "reviewer" actually saw survives
// a coordinated swap/restore of the mutable original), large stdout output
// (for the maxBuffer regression), and swapping an ancestor directory of a
// write destination to a symlink mid-execution (for the output-destination
// revalidation-before-persistence regression).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail

if [ "\${1:-}" = "--version" ]; then
  if [ -n "\${CODEX_STUB_HANG_VERSION:-}" ]; then
    sleep "\${CODEX_STUB_VERSION_SLEEP_SECONDS:-30}"
  fi
  echo "codex-cli-stub 0.0.0-test"
  exit 0
fi

output_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    output_path="$arg"
  fi
  prev="$arg"
done

cat >/dev/null

mode="\${CODEX_STUB_MODE:-success}"

default_payload='{"verdict":"READY_FOR_OWNER_REVIEW","findings":[]}'
payload="\${CODEX_STUB_PAYLOAD:-$default_payload}"

case "$mode" in
  success)
    printf '%s' "$payload" > "$output_path"
    exit 0
    ;;
  nonzero)
    echo "stub: simulated failure" >&2
    exit "\${CODEX_STUB_EXIT_CODE:-3}"
    ;;
  hang)
    sleep "\${CODEX_STUB_SLEEP_SECONDS:-5}"
    exit 0
    ;;
  missing-output)
    exit 0
    ;;
  mutate-then-succeed)
    if [ -n "\${CODEX_STUB_MUTATE_FILE:-}" ]; then
      printf '%s' "\${CODEX_STUB_MUTATE_CONTENT:-mutated}" > "\${CODEX_STUB_MUTATE_FILE}"
    fi
    if [ -n "\${CODEX_STUB_DELETE_FILE:-}" ]; then
      rm -f "\${CODEX_STUB_DELETE_FILE}"
    fi
    if [ -n "\${CODEX_STUB_CHMOD_FILE:-}" ]; then
      chmod "\${CODEX_STUB_CHMOD_MODE:-755}" "\${CODEX_STUB_CHMOD_FILE}"
    fi
    printf '%s' "$payload" > "$output_path"
    exit 0
    ;;
  aba-swap-and-restore)
    snapshot_dir=$(dirname "$output_path")
    if [ -n "\${CODEX_STUB_ABA_CAPTURE_PATH:-}" ] && [ -n "\${CODEX_STUB_ABA_CAPTURE_SOURCE:-}" ]; then
      cp "\${snapshot_dir}/\${CODEX_STUB_ABA_CAPTURE_SOURCE}" "\${CODEX_STUB_ABA_CAPTURE_PATH}"
    fi
    if [ -n "\${CODEX_STUB_MUTATE_FILE:-}" ]; then
      printf '%s' "\${CODEX_STUB_MUTATE_CONTENT:-mutated}" > "\${CODEX_STUB_MUTATE_FILE}"
    fi
    if [ -n "\${CODEX_STUB_RESTORE_FILE:-}" ]; then
      printf '%s' "\${CODEX_STUB_RESTORE_CONTENT:-}" > "\${CODEX_STUB_RESTORE_FILE}"
    fi
    printf '%s' "$payload" > "$output_path"
    exit 0
    ;;
  large-output)
    bytes="\${CODEX_STUB_LARGE_OUTPUT_BYTES:-2097152}"
    head -c "$bytes" /dev/zero | tr '\\0' 'A'
    printf '%s' "$payload" > "$output_path"
    exit 0
    ;;
  swap-ancestor-to-symlink)
    if [ -n "\${CODEX_STUB_SWAP_PATH:-}" ] && [ -n "\${CODEX_STUB_SWAP_LINK_TARGET:-}" ]; then
      rm -rf "\${CODEX_STUB_SWAP_PATH}"
      ln -s "\${CODEX_STUB_SWAP_LINK_TARGET}" "\${CODEX_STUB_SWAP_PATH}"
    fi
    printf '%s' "$payload" > "$output_path"
    exit 0
    ;;
  bad-json)
    printf 'not json at all' > "$output_path"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

export interface CodexStub {
  /** Absolute path to the executable, named exactly "codex". */
  binPath: string;
  /** The directory containing it — prepend this to PATH for e2e (spawned-CLI) tests. */
  dir: string;
  cleanup(): void;
}

export function createCodexStub(): CodexStub {
  const dir = mkdtempSync(join(tmpdir(), "harness-codex-stub-"));
  const binPath = join(dir, "codex");
  writeFileSync(binPath, STUB_SCRIPT);
  chmodSync(binPath, 0o755);
  return {
    binPath,
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
