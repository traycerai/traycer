import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOverBudget, readFileSeconds } from "../ci-gui-test-budget.mjs";

const SLOW = "src/slow.test.tsx";
const FAST = "src/fast.test.ts";
const JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="0" errors="0" time="99.9">
    <testsuite name="${SLOW}" timestamp="2026-11-03T00:00:00.000Z" hostname="h" tests="2" failures="0" errors="0" skipped="0" time="12.5">
        <testcase classname="${SLOW}" name="a" time="12.5"></testcase>
    </testsuite>
    <testsuite name="${FAST}" timestamp="2026-11-03T00:00:00.000Z" hostname="h" tests="1" failures="0" errors="0" skipped="0" time="0.25">
        <testcase classname="${FAST}" name="b" time="0.25"></testcase>
    </testsuite>
</testsuites>
`;

const roots = [];

function runBudget(junit, allowlist) {
  const root = mkdtempSync(join(tmpdir(), "gui-test-budget-"));
  roots.push(root);
  const junitPath = join(root, "junit.xml");
  const allowlistPath = join(root, "allowlist.json");
  writeFileSync(junitPath, junit);
  writeFileSync(allowlistPath, JSON.stringify(allowlist));
  return spawnSync(
    process.execPath,
    ["scripts/ci-gui-test-budget.mjs", junitPath, allowlistPath],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the gui-app per-file budget", () => {
  it("reads each file's own time, not the run's total", () => {
    expect(readFileSeconds(JUNIT)).toEqual([
      { path: SLOW, seconds: 12.5 },
      { path: FAST, seconds: 0.25 },
    ]);
  });

  it("fails on a file over budget and names it with its seconds", () => {
    const result = runBudget(JUNIT, {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${SLOW}: 12.5 s`);
    expect(result.stderr).not.toContain(FAST);
  });

  it("passes a file over budget that the allowlist names with a reason", () => {
    const result = runBudget(JUNIT, { [SLOW]: "a sweep over every setting" });
    expect(result.status).toBe(0);
  });

  it("does not take a bare allowlist entry as a reason", () => {
    expect(findOverBudget(readFileSeconds(JUNIT), { [SLOW]: "  " })).toEqual([
      { path: SLOW, seconds: 12.5 },
    ]);
  });

  it("fails a report with no test files, so a guard that read nothing is not green", () => {
    const result = runBudget("<testsuites></testsuites>", {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing was checked");
  });
});
