import { describe, expect, it } from "vitest";

import { budgetProblems } from "../scripts/browser-test-budget.ts";
import {
  reportedTests,
  type JsonReport,
} from "../scripts/browser-test-report.ts";
import { planShards } from "../scripts/browser-test-shard-plan.ts";
import { fileTimings } from "../scripts/browser-test-timings.ts";

const REPORT: JsonReport = {
  suites: [
    {
      title: "a.spec.ts",
      specs: [
        {
          title: "top",
          file: "a.spec.ts",
          tests: [{ results: [{ status: "passed", duration: 2_500 }] }],
        },
        {
          title: "skipped",
          file: "a.spec.ts",
          tests: [{ results: [{ status: "skipped", duration: 0 }] }],
        },
      ],
      suites: [
        {
          title: "group",
          specs: [
            {
              title: "retried",
              file: "a.spec.ts",
              tests: [
                {
                  results: [
                    { status: "failed", duration: 60_000 },
                    { status: "passed", duration: 21_000 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("planShards", () => {
  it("puts every file in exactly one share and balances by weight", () => {
    const shares = planShards(
      ["a", "b", "c", "d"],
      { a: 100, b: 60, c: 30, d: 20 },
      2,
    );
    expect(shares).toEqual([["a"], ["b", "c", "d"]]);
  });

  it("weighs a file with no timing as the mean, so it still lands in a share", () => {
    const shares = planShards(
      ["heavy", "light", "new"],
      { heavy: 30, light: 10 },
      2,
    );
    expect(shares).toEqual([["heavy"], ["light", "new"]]);
  });
});

describe("the JSON report", () => {
  it("reads the last attempt's time and the attempts before it, keeping describes in the name", () => {
    expect(reportedTests(REPORT)).toEqual([
      {
        file: "browser-tests/a.spec.ts",
        name: "top",
        seconds: 2.5,
        retries: 0,
      },
      {
        file: "browser-tests/a.spec.ts",
        name: "group › retried",
        seconds: 21,
        retries: 1,
      },
    ]);
  });

  it("sums a file's tests into its timing", () => {
    expect(fileTimings([REPORT])).toEqual({
      "browser-tests/a.spec.ts": 23.5,
    });
  });
});

describe("budgetProblems", () => {
  const tests = reportedTests(REPORT);

  it("names a test over budget", () => {
    expect(budgetProblems(tests, {})).toEqual([
      "21.0 s, over the 20 s budget: browser-tests/a.spec.ts › group › retried",
    ]);
  });

  it("lets an allowlisted test through", () => {
    expect(
      budgetProblems(tests, {
        "browser-tests/a.spec.ts › group › retried": "the pause is the claim",
      }),
    ).toEqual([]);
  });

  it("fails an entry whose file ran without it, and ignores another shard's", () => {
    expect(
      budgetProblems(tests, {
        "browser-tests/a.spec.ts › group › retried": "the pause is the claim",
        "browser-tests/a.spec.ts › gone": "the pause is the claim",
        "browser-tests/b.spec.ts › elsewhere": "the pause is the claim",
      }),
    ).toEqual([
      "allowlisted, but no such test ran: browser-tests/a.spec.ts › gone",
    ]);
  });
});
