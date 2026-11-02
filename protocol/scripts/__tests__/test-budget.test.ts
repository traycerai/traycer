import { describe, expect, it, vi } from "vitest";

import {
  TEST_FILE_BUDGET_MS,
  describeBudgetReading,
  evaluateTestBudget,
  junitFileDurationsMs,
  parseTestBudgetAllowlist,
  secondRunDurationsMs,
} from "../test-budget";

const OVER_MS = TEST_FILE_BUDGET_MS + 1;

const REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" time="9">
  <testsuite name="src/a.test.ts" timestamp="2026-11-03T00:00:00Z" tests="2" time="1.5">
    <testcase classname="src/a.test.ts" name="one" time="99"></testcase>
  </testsuite>
  <testsuite time="2.25" name="src/b.test.ts" tests="1"></testsuite>
</testsuites>`;

describe("junitFileDurationsMs", () => {
  it("reads each suite's seconds as milliseconds, whatever the attribute order, and ignores testcases", () => {
    expect(junitFileDurationsMs(REPORT)).toEqual(
      new Map([
        ["src/a.test.ts", 1_500],
        ["src/b.test.ts", 2_250],
      ]),
    );
  });

  it("skips a suite with no time, a blank time or a non-numeric time", () => {
    const xml = `
      <testsuite name="none.test.ts" tests="1">
      <testsuite name="blank.test.ts" time="  ">
      <testsuite name="text.test.ts" time="fast">
      <testsuite name="ok.test.ts" time="0">`;
    expect(junitFileDurationsMs(xml)).toEqual(new Map([["ok.test.ts", 0]]));
  });
});

describe("parseTestBudgetAllowlist", () => {
  it("parses a map of path to reason", () => {
    expect(
      parseTestBudgetAllowlist({ "src/a.test.ts": "boots a server" }),
    ).toEqual(new Map([["src/a.test.ts", "boots a server"]]));
  });

  it.each([
    ["an array", ["src/a.test.ts"]],
    ["null", null],
    ["a non-string reason", { "src/a.test.ts": 3 }],
  ])("returns null for %s", (_label, value) => {
    expect(parseTestBudgetAllowlist(value)).toBeNull();
  });
});

describe("evaluateTestBudget", () => {
  it("passes a reasoned allowlist entry without re-measuring it", () => {
    const remeasure = vi.fn(() => new Map<string, number>());
    const result = evaluateTestBudget(
      new Map([["slow.test.ts", OVER_MS]]),
      new Map([["slow.test.ts", "boots a server"]]),
      remeasure,
    );
    expect(result).toEqual({ overBudget: [], spikes: [], allowlistedOver: 1 });
    expect(remeasure).not.toHaveBeenCalled();
  });

  it("judges a blank-reason entry, and a file exactly at the budget is not over", () => {
    const remeasure = vi.fn(() => new Map([["blank.test.ts", OVER_MS]]));
    const result = evaluateTestBudget(
      new Map([
        ["blank.test.ts", OVER_MS],
        ["edge.test.ts", TEST_FILE_BUDGET_MS],
      ]),
      new Map([["blank.test.ts", "  "]]),
      remeasure,
    );
    expect(result).toEqual({
      overBudget: [
        { path: "blank.test.ts", firstMs: OVER_MS, aloneMs: OVER_MS },
      ],
      spikes: [],
      allowlistedOver: 0,
    });
  });

  it("sorts files into spikes, overs and no-reading, and re-measures only the unlisted over-budget ones", () => {
    const remeasure = vi.fn(
      () =>
        new Map([
          ["spike.test.ts", TEST_FILE_BUDGET_MS],
          ["over.test.ts", OVER_MS],
        ]),
    );
    const result = evaluateTestBudget(
      new Map([
        ["spike.test.ts", 20_000],
        ["over.test.ts", 30_000],
        ["missing.test.ts", 40_000],
        ["listed.test.ts", 50_000],
        ["fast.test.ts", 100],
      ]),
      new Map([["listed.test.ts", "boots a server"]]),
      remeasure,
    );
    expect(remeasure).toHaveBeenCalledExactlyOnceWith([
      "missing.test.ts",
      "over.test.ts",
      "spike.test.ts",
    ]);
    expect(result).toEqual({
      overBudget: [
        { path: "missing.test.ts", firstMs: 40_000, aloneMs: null },
        { path: "over.test.ts", firstMs: 30_000, aloneMs: OVER_MS },
      ],
      spikes: [
        {
          path: "spike.test.ts",
          firstMs: 20_000,
          aloneMs: TEST_FILE_BUDGET_MS,
        },
      ],
      allowlistedOver: 1,
    });
  });
});

describe("secondRunDurationsMs", () => {
  it.each([
    ["a non-zero exit", 1, REPORT],
    ["a null exit", null, REPORT],
    ["a null report", 0, null],
  ])("measures nothing for %s", (_label, status, report) => {
    expect(secondRunDurationsMs(status, report)).toEqual(new Map());
  });

  it("reads the report on exit 0", () => {
    expect(secondRunDurationsMs(0, REPORT)).toEqual(
      new Map([
        ["src/a.test.ts", 1_500],
        ["src/b.test.ts", 2_250],
      ]),
    );
  });
});

describe("describeBudgetReading", () => {
  it("renders the spike log line", () => {
    expect(
      describeBudgetReading(
        { path: "src/a.test.ts", firstMs: 12_340, aloneMs: 4_100 },
        "spike",
      ),
    ).toBe("budget src/a.test.ts first=12.3s second=4.1s verdict=spike");
  });

  it("writes second=none when there is no second reading", () => {
    expect(
      describeBudgetReading(
        { path: "src/a.test.ts", firstMs: 12_340, aloneMs: null },
        "over",
      ),
    ).toBe("budget src/a.test.ts first=12.3s second=none verdict=over");
  });
});
