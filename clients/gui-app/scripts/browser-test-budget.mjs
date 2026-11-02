#!/usr/bin/env node
/**
 * The browser regressions' per-test budget, read from one shard's JSON report.
 * A test over it fails the shard unless `browser-tests/test-budget-allowlist.json`
 * names it with the reason its time is the claim; the list's key is
 * `<file> › <describes and title>`, as this prints it. Time a test merely waits
 * is cut, not listed: see "Wait for a condition" in `browser-tests/README.md`.
 *
 *   node scripts/browser-test-budget.mjs test-results.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { reportedTests } from "./browser-test-report.mjs";

export const BUDGET_SECONDS = 20;

/**
 * @param {readonly import("./browser-test-report.mjs").ReportedTest[]} tests
 * @param {Readonly<Record<string, string>>} allowlist reason by test key
 * @returns {string[]} one line per problem; none when the shard is within budget
 */
export function budgetProblems(tests, allowlist) {
  const keys = new Set(tests.map((test) => `${test.file} › ${test.name}`));
  const files = new Set(tests.map((test) => test.file));
  const overBudget = tests
    .filter((test) => test.seconds > BUDGET_SECONDS)
    .filter((test) => allowlist[`${test.file} › ${test.name}`] === undefined)
    .map(
      (test) =>
        `${test.seconds.toFixed(1)} s, over the ${String(BUDGET_SECONDS)} s budget: ${test.file} › ${test.name}`,
    );
  // A shard sees only its own files, so only those can prove an entry stale.
  const stale = Object.keys(allowlist)
    .filter((key) => files.has(key.split(" › ")[0]) && !keys.has(key))
    .map((key) => `allowlisted, but no such test ran: ${key}`);
  return [...overBudget, ...stale];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reportPath = process.argv[2];
  if (reportPath === undefined) {
    throw new Error("usage: browser-test-budget.mjs <results.json>");
  }
  const allowlistPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../browser-tests/test-budget-allowlist.json",
  );
  const problems = budgetProblems(
    reportedTests(JSON.parse(readFileSync(reportPath, "utf8"))),
    JSON.parse(readFileSync(allowlistPath, "utf8")),
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}
