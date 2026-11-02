import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateBudget,
  readFileSeconds,
  secondRunSeconds,
} from "../ci-gui-test-budget.mjs";

const SLOW = "src/slow.test.tsx";
const FAST = "src/fast.test.ts";

function junit(entries) {
  const suites = entries
    .map(
      ([path, seconds]) =>
        `    <testsuite name="${path}" timestamp="2026-11-03T00:00:00.000Z" hostname="h" tests="1" failures="0" errors="0" skipped="0" time="${seconds}">\n` +
        `        <testcase classname="${path}" name="a" time="${seconds}"></testcase>\n` +
        "    </testsuite>\n",
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="${entries.length}" failures="0" errors="0" time="99.9">\n${suites}</testsuites>\n`;
}

const SHARD = junit([
  [SLOW, 12.5],
  [FAST, 0.25],
]);

const roots = [];

function runBudget(report, allowlist) {
  const root = mkdtempSync(join(tmpdir(), "gui-test-budget-"));
  roots.push(root);
  const junitPath = join(root, "junit.xml");
  writeFileSync(junitPath, report);
  writeFileSync(
    join(root, "test-budget-allowlist.json"),
    JSON.stringify(allowlist),
  );
  return spawnSync(
    process.execPath,
    ["scripts/ci-gui-test-budget.mjs", junitPath, root],
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
    expect(readFileSeconds(SHARD)).toEqual([
      { path: SLOW, seconds: 12.5 },
      { path: FAST, seconds: 0.25 },
    ]);
  });

  it("fails a file over budget again alone, and asks only about that file", () => {
    const asked = [];
    const result = evaluateBudget(readFileSeconds(SHARD), {}, (paths) => {
      asked.push(...paths);
      return new Map([[SLOW, 11.9]]);
    });
    expect(asked).toEqual([SLOW]);
    expect(result).toEqual({
      overBudget: [{ path: SLOW, seconds: 12.5, aloneSeconds: 11.9 }],
      spikes: [],
    });
  });

  it("counts a file within budget alone as a stall, not a failure", () => {
    const result = evaluateBudget(
      readFileSeconds(SHARD),
      {},
      () => new Map([[SLOW, 4.2]]),
    );
    expect(result).toEqual({
      overBudget: [],
      spikes: [{ path: SLOW, seconds: 12.5, aloneSeconds: 4.2 }],
    });
  });

  it("fails a file whose second run failed, whatever that run's report says", () => {
    const failedRun = secondRunSeconds(1, junit([[SLOW, 0.01]]));
    const result = evaluateBudget(readFileSeconds(SHARD), {}, () => failedRun);
    expect(result.overBudget).toEqual([
      { path: SLOW, seconds: 12.5, aloneSeconds: null },
    ]);
  });

  it("does not take a bare allowlist entry as a reason", () => {
    const result = evaluateBudget(
      readFileSeconds(SHARD),
      { [SLOW]: "  " },
      () => new Map(),
    );
    expect(result.overBudget).toEqual([
      { path: SLOW, seconds: 12.5, aloneSeconds: null },
    ]);
  });

  it("passes a file over budget that the allowlist names with a reason, without running it again", () => {
    const result = runBudget(SHARD, { [SLOW]: "a sweep over every setting" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 test files within 10 s");
  });

  it("fails a report with no test files, so a guard that read nothing is not green", () => {
    const result = runBudget("<testsuites></testsuites>", {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing was checked");
  });
});
