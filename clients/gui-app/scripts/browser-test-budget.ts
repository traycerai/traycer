#!/usr/bin/env node
/**
 * The browser regressions' per-test budget, read from one shard's JSON report.
 * A test over it fails the shard unless `browser-tests/test-budget-allowlist.json`
 * names it with the reason its time is the claim; the list's key is
 * `<file> › <describes and title>`, as this prints it. Time a test merely waits
 * is cut, not listed: see "Wait for a condition" in `browser-tests/README.md`.
 *
 *   node scripts/browser-test-budget.ts test-results.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  reportedTests,
  type JsonReport,
  type ReportedTest,
} from "./browser-test-report.ts";

const BUDGET_SECONDS = 20;

/** One line per problem; none when the shard is within budget. */
export function budgetProblems(
  tests: readonly ReportedTest[],
  allowlist: Readonly<Record<string, string>>,
): string[] {
  const keyOf = (test: ReportedTest): string => `${test.file} › ${test.name}`;
  const keys = new Set(tests.map(keyOf));
  const files = new Set(tests.map((test) => test.file));
  const overBudget = tests
    .filter((test) => test.seconds > BUDGET_SECONDS)
    .filter((test) => !(keyOf(test) in allowlist))
    .map(
      (test) =>
        `${test.seconds.toFixed(1)} s, over the ${String(BUDGET_SECONDS)} s budget: ${keyOf(test)}`,
    );
  // A shard sees only its own files, so only those can prove an entry stale.
  const stale = Object.keys(allowlist)
    .filter((key) => files.has(key.split(" › ")[0]) && !keys.has(key))
    .map((key) => `allowlisted, but no such test ran: ${key}`);
  return [...overBudget, ...stale];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reportPath = process.argv.at(2);
  if (reportPath === undefined) {
    throw new Error("usage: browser-test-budget.ts <test-results.json>");
  }
  const allowlistPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../browser-tests/test-budget-allowlist.json",
  );
  const problems = budgetProblems(
    reportedTests(JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport),
    JSON.parse(readFileSync(allowlistPath, "utf8")) as Record<string, string>,
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}
