// Tests for scripts/ci-last-green-sha.sh: which commit a push run compares
// itself against. The REAL script runs in a throwaway git repository with a
// stub `gh` first on PATH. The stub answers `gh api ... --jq <expr>` with
// canned run lists piped through the real `jq`, so the script's own `--jq`
// expression is what selects the head SHAs.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ci-last-green-sha.sh");

// Reads the canned workflow-runs JSON from $GH_STUB_RUNS, applies the `--jq`
// expression it was given, and logs its argv. GH_STUB_FAIL makes it fail the
// way an API outage does.
const GH_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
  '[ -z "${GH_STUB_FAIL:-}" ] || { echo "gh: HTTP 502" >&2; exit 1; }',
  'expression=""',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--jq" ]; then expression=$2; fi',
  "  shift",
  "done",
  'jq -r "$expression" "$GH_STUB_RUNS"',
].join("\n");

let sandbox;
let repo;
let commits;

const git = (...args) => {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

// The newest-first `workflow_runs` list GitHub returns, as head SHAs.
const runsJson = (shas) =>
  JSON.stringify({ workflow_runs: shas.map((head_sha) => ({ head_sha })) });

const run = (args, { runs = [], fail = false } = {}) => {
  const runsFile = join(sandbox, "runs.json");
  const logFile = join(sandbox, "gh.log");
  writeFileSync(runsFile, runsJson(runs));
  writeFileSync(logFile, "");
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(sandbox, "bin")}${delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "traycerai/traycer",
      GH_TOKEN: "stub",
      GH_STUB_RUNS: runsFile,
      GH_STUB_LOG: logFile,
      GH_STUB_FAIL: fail ? "1" : "",
    },
  });
  return { ...result, ghCalls: readFileSync(logFile, "utf8") };
};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ci-last-green-"));
  repo = join(sandbox, "repo");
  const bin = join(sandbox, "bin");
  spawnSync("mkdir", ["-p", repo, bin]);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);
  git("init", "-q", "-b", "main");
  commits = [];
  for (let n = 1; n <= 5; n += 1) {
    git("commit", "-q", "--allow-empty", "-m", `c${n}`);
    commits.push(git("rev-parse", "HEAD"));
  }
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("ci-last-green-sha.sh", () => {
  it("prints <before> when the previous push was green", () => {
    const [, c2, c3] = commits;
    // Newest first, as the API returns them.
    const result = run(["test.yml", "main", c3], { runs: [c3, c2] });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(c3);
  });

  it("asks for the successful push runs of THIS workflow on THIS branch", () => {
    const [, , c3] = commits;
    const { ghCalls } = run(["pre-commit.yml", "main", c3], { runs: [c3] });
    expect(ghCalls).toContain(
      "repos/traycerai/traycer/actions/workflows/pre-commit.yml/runs?branch=main&event=push&status=success&per_page=100",
    );
  });

  it("prints the newest successful ancestor when the previous push was red", () => {
    const [c1, c2, , c4] = commits;
    // c4 is the push before this one and it failed; c2 passed; c1 passed.
    const result = run(["test.yml", "main", c4], { runs: [c2, c1] });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(c2);
  });

  it("skips a successful run on a commit after <before>", () => {
    const [c1, c2, c3, , c5] = commits;
    // A run for c5 finished out of order. It is not an ancestor of c3, so it
    // is no base for a push whose previous head was c3.
    const result = run(["test.yml", "main", c3], { runs: [c5, c2, c1] });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(c2);
  });

  it("prints <before> and warns when gh fails", () => {
    const [, , c3] = commits;
    const result = run(["test.yml", "main", c3], { fail: true });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(c3);
    expect(result.stderr).toContain("::warning::");
    expect(result.stderr).toContain("comparing against the previous push");
  });

  it("prints <before> and warns when no successful run is an ancestor", () => {
    const [, , c3, , c5] = commits;
    const result = run(["test.yml", "main", c3], { runs: [c5] });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(c3);
    expect(result.stderr).toContain("::warning::");
  });

  it("prints <before> unchanged, without asking gh, when it is not a commit", () => {
    const zeros = "0000000000000000000000000000000000000000";
    const result = run(["test.yml", "main", zeros], { runs: commits });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(zeros);
    expect(result.ghCalls).toBe("");
  });

  it("exits 2 with usage on the wrong number of arguments", () => {
    for (const args of [
      [],
      ["test.yml"],
      ["test.yml", "main"],
      ["a", "b", "c", "d"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: ci-last-green-sha.sh");
      expect(result.stdout).toBe("");
    }
  });

  it("is executable, so a workflow step can run it by path", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const result = spawnSync("test", ["-x", SCRIPT]);
    expect(result.status).toBe(0);
  });
});
