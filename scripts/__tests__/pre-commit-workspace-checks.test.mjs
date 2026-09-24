// Tests for scripts/pre_commit_workspace_checks.sh, the OSS local pre-commit
// hook. Modeled on the internal monorepo's harness for its own hook test
// (scripts/__tests__/pre-commit-workspace-checks-cache.test.mjs): stub `bun`
// and `git` as shell functions inside the SAME bash process that sources the
// hook, and log every `bun`/`bun x` invocation's argv, NUL-delimited so an
// empty argument can't be lost, to a file the test reads back afterward.
//
// The hook iterates candidate base refs `origin/main main HEAD~1` (in that
// order) via `git rev-parse --verify`; the stub here verifies only
// `origin/main`, matching a normal clone with a remote.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "pre_commit_workspace_checks.sh");

// Logs every `bun`/`bun x` call's argv. `git` is stubbed separately below so
// only `origin/main` verifies as a base ref, and everything else about git
// (rev-parse --show-toplevel) returns the fixture root.
//
// Unlike the internal hook, the OSS local lane also invokes bun DIRECTLY on
// a script path (`bun scripts/lint-changed-files.mjs <base>`), not only as
// `bun run ...` / `bun x ...`, so the stub accepts that shape too.
const BASH_PRELUDE = [
  "set -euo pipefail",
  "bun() {",
  '  case "${1-}" in run|x|*.mjs) ;; *) return 97 ;; esac',
  '  printf "%s\\0" "$#" >> "$WORKSPACE_CHECK_CALLS"',
  '  for argument do printf "%s\\0" "$argument" >> "$WORKSPACE_CHECK_CALLS"; done',
  "}",
  "git() {",
  '  if [ "$#" -eq 2 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then',
  '    printf "%s" "$WORKSPACE_CHECK_ROOT"',
  "    return 0",
  "  fi",
  '  if [ "$#" -eq 3 ] && [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "origin/main" ]; then',
  '    printf "%s" "origin/main"',
  "    return 0",
  "  fi",
  "  return 1",
  "}",
  'source "$1"',
].join("\n");
const FAIL_CLOSED_STUB = [
  "#!/bin/sh",
  "echo unexpected tool invocation >&2",
  "exit 97",
].join("\n");

function createStub(name, body) {
  const directory = mkdtempSync(join(tmpdir(), "oss-workspace-checks-"));
  const file = join(directory, name);
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
  return { directory, file };
}

function runHook({ ci, base, head }) {
  const fixture = mkdtempSync(join(tmpdir(), "oss-workspace-checks-root-"));
  const slotDir = mkdtempSync(join(tmpdir(), "oss-workspace-checks-slot-"));
  const callsFile = join(fixture, "calls.bin");
  const bunx = createStub("bunx", FAIL_CLOSED_STUB);
  const nx = createStub("nx", FAIL_CLOSED_STUB);

  const env = {
    ...process.env,
    PATH: `${bunx.directory}${delimiter}${nx.directory}${delimiter}${process.env.PATH}`,
    WORKSPACE_CHECK_CALLS: callsFile,
    WORKSPACE_CHECK_ROOT: fixture,
    TRAYCER_MACHINE_SLOT_DIR: slotDir,
  };
  if (ci) env.CI = "true";
  else delete env.CI;
  if (base === undefined) delete env.NX_BASE;
  else env.NX_BASE = base;
  if (head === undefined) delete env.NX_HEAD;
  else env.NX_HEAD = head;

  try {
    const result = spawnSync(
      "/bin/bash",
      ["-c", BASH_PRELUDE, "hook", SCRIPT],
      {
        cwd: fixture,
        encoding: "utf8",
        env,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `hook harness failed (${String(result.status)}): ${result.stderr || result.error?.message || result.stdout}`,
      );
    }
    let calls = [];
    if (existsSync(callsFile)) {
      const fields = readFileSync(callsFile, "utf8").split("\0");
      for (let index = 0; index < fields.length - 1;) {
        const argumentCount = Number(fields[index]);
        index += 1;
        calls.push(fields.slice(index, index + argumentCount));
        index += argumentCount;
      }
    }
    const slotLockFiles = existsSync(slotDir) ? readdirSync(slotDir) : [];
    return { result, calls, slotLockFiles };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(slotDir, { recursive: true, force: true });
    rmSync(bunx.directory, { recursive: true, force: true });
    rmSync(nx.directory, { recursive: true, force: true });
  }
}

function hasArgs(calls, ...needles) {
  return calls.some((args) => needles.every((needle) => args.includes(needle)));
}

function anyArgvContains(calls, substring) {
  return calls.some((args) => args.some((arg) => arg.includes(substring)));
}

describe("pre_commit_workspace_checks.sh (OSS, local lane)", () => {
  it("runs lint-changed-files, format, and an nx affected compile - never build", () => {
    const { result, calls, slotLockFiles } = runHook({ ci: false });

    expect(result.status, result.stderr).toBe(0);

    // `bun scripts/lint-changed-files.mjs origin/main`
    expect(
      hasArgs(calls, "scripts/lint-changed-files.mjs", "origin/main"),
    ).toBe(true);
    // `bun run format`
    expect(hasArgs(calls, "run", "format")).toBe(true);
    // `bun x nx affected --target=compile --base=origin/main ...`
    const compileCall = calls.find(
      (args) =>
        args[0] === "x" &&
        args[1] === "nx" &&
        args[2] === "affected" &&
        args.includes("--target=compile") &&
        args.includes("--base=origin/main"),
    );
    expect(compileCall).toBeDefined();

    // No build target anywhere, in any call - the whole point of the local
    // lane change under test.
    expect(anyArgvContains(calls, "--target=build")).toBe(false);
    expect(anyArgvContains(calls, "--targets=compile,build")).toBe(false);
    expect(hasArgs(calls, "run", "build")).toBe(false);

    // The machine-wide slot was actually acquired: its lock file exists.
    expect(slotLockFiles).toContain("traycer-slot-commit-checks.0.lock");
  });

  it("CI lane runs nx affected lint + compile,build and never touches the slot", () => {
    const { result, calls, slotLockFiles } = runHook({
      ci: true,
      base: "base-sha",
      head: "head-sha",
    });

    expect(result.status, result.stderr).toBe(0);

    const lintCall = calls.find(
      (args) =>
        args[0] === "x" &&
        args[1] === "nx" &&
        args[2] === "affected" &&
        args.includes("--target=lint"),
    );
    expect(lintCall).toBeDefined();

    const compileBuildCall = calls.find(
      (args) =>
        args[0] === "x" &&
        args[1] === "nx" &&
        args[2] === "affected" &&
        args.includes("--targets=compile,build"),
    );
    expect(compileBuildCall).toBeDefined();

    // `bun run format:check`, never `bun run format`
    expect(hasArgs(calls, "run", "format:check")).toBe(true);

    // CI never sources machine-slot.sh, so no lock file is created.
    expect(slotLockFiles).toEqual([]);
  });
});
