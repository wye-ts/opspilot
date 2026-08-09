import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitFixture, type GitFixture } from "./testing/git-fixture";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./resolved-config";

describe("resolveField", () => {
  it("prefers cli over task-declaration over default", () => {
    expect(resolveField("default", "task", "cli")).toEqual({ value: "cli", source: "cli" });
    expect(resolveField("default", "task", undefined)).toEqual({ value: "task", source: "task-declaration" });
    expect(resolveField("default", undefined, undefined)).toEqual({ value: "default", source: "default" });
  });
});

describe("resolveBaseline", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("CLI --baseline wins over a task-declaration baseline", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const first = fixture.commit("first");
    fixture.writeFile("a.txt", "a2");
    fixture.add("a.txt");
    fixture.commit("second");

    const resolved = resolveBaseline(fixture.dir, first, "HEAD");
    expect(resolved).toEqual({ sha: first, source: "cli" });
  });

  it("falls back to the task-declaration baseline when no CLI value is given", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const first = fixture.commit("first");

    const resolved = resolveBaseline(fixture.dir, undefined, first);
    expect(resolved).toEqual({ sha: first, source: "task-declaration" });
  });

  it("throws when an explicit CLI baseline does not resolve", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    expect(() => resolveBaseline(fixture!.dir, "not-a-real-ref", undefined)).toThrow(BaselineResolutionError);
  });

  it("falls back to merge-base HEAD origin/main when neither CLI nor task-declaration baseline is given", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const base = fixture.commit("base");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("a.txt", "a2");
    fixture.add("a.txt");
    fixture.commit("second");

    const resolved = resolveBaseline(fixture.dir, undefined, undefined);
    expect(resolved).toEqual({ sha: base, source: "merge-base-origin-main" });
  });

  it("resolves via merge-base HEAD main — the common ancestor, not main's diverged raw tip", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const base = fixture.commit("base");

    fixture.git("branch", "feature");
    fixture.writeFile("a.txt", "main-only-change");
    fixture.add("a.txt");
    const mainTip = fixture.commit("main-only-commit");

    fixture.git("checkout", "feature");
    fixture.writeFile("b.txt", "feature-only");
    fixture.add("b.txt");
    fixture.commit("feature-only-commit");

    const resolved = resolveBaseline(fixture.dir, undefined, undefined);
    expect(resolved.source).toBe("merge-base-main");
    expect(resolved.sha).toBe(base);
    expect(resolved.sha).not.toBe(mainTip);
  });

  it("hard-fails when neither main nor origin/main is reachable", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");

    fixture.git("checkout", "--orphan", "other");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("other-init");
    fixture.git("branch", "-D", "main");

    expect(() => resolveBaseline(fixture!.dir, undefined, undefined)).toThrow(BaselineResolutionError);
  });

  // Regression (Codex finding: the exact reproduction). origin/main exists as
  // a ref but points at an object git cannot read; a valid local main also
  // exists. Baseline resolution must fail closed on origin/main's corruption
  // rather than treating it as "no origin/main here" and silently falling
  // back to local main — a corrupt remote-tracking ref is a fatal git
  // problem, not evidence that this candidate is simply absent.
  it("fails closed on a corrupt origin/main and does NOT fall back to a valid local main", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    fixture.git("update-ref", "refs/remotes/origin/main", sha); // exists...
    const objectPath = join(fixture.dir, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    rmSync(objectPath, { force: true });
    writeFileSync(objectPath, "not-a-zlib-stream"); // ...but unreadable

    // Local main is completely healthy and would otherwise be a perfectly
    // valid fallback baseline.
    expect(() => resolveBaseline(fixture!.dir, undefined, undefined)).toThrow(BaselineResolutionError);
  });

  // Regression (Codex re-review finding: the remaining classification gap).
  // A ref lookup can fail for two different reasons that both exit nonzero
  // from a plain existence check: the ref genuinely isn't there, or the ref
  // slot is physically present but its content is malformed (a corrupt loose
  // ref file). Only the first is an expected miss a fallback chain may step
  // past; the second must fail closed exactly like a corrupt/unreadable
  // target object does, and must never be silently read as "no origin/main
  // here" and fall through to local main.
  it("fails closed on a malformed (physically present but unparseable) origin/main and does NOT fall back to local main", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    // A loose ref file that exists on disk but holds neither a valid 40-hex
    // SHA nor a "ref: " symref line.
    mkdirSync(join(fixture.dir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(fixture.dir, ".git", "refs", "remotes", "origin", "main"), "not-a-valid-sha-or-symref\n");

    // Local main is completely healthy and would otherwise be a perfectly
    // valid fallback baseline.
    expect(() => resolveBaseline(fixture!.dir, undefined, undefined)).toThrow(BaselineResolutionError);
  });
});
