#!/usr/bin/env node
// Per-file time budget for the gui-app suite, run by each shard of `test.yml`.
//
//   node scripts/ci-gui-test-budget.mjs <junit.xml> <allowlist.json>
//
// A file over the budget fails the job unless the allowlist names it with a
// reason. The allowlist is a JSON object of file path to reason.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FILE_BUDGET_SECONDS = 10;

const TESTSUITE_TAG = /<testsuite\s[^>]*>/g;

function readAttribute(tag, name) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

export function readFileSeconds(junitXml) {
  const files = [];
  for (const [tag] of junitXml.matchAll(TESTSUITE_TAG)) {
    const path = readAttribute(tag, "name");
    const seconds = Number(readAttribute(tag, "time"));
    if (path === null || !Number.isFinite(seconds)) {
      throw new Error(`Unreadable testsuite in the JUnit report: ${tag}`);
    }
    files.push({ path, seconds });
  }
  return files;
}

export function findOverBudget(files, allowlist) {
  return files
    .filter(({ path, seconds }) => {
      if (seconds <= FILE_BUDGET_SECONDS) return false;
      const reason = allowlist[path];
      return typeof reason !== "string" || reason.trim() === "";
    })
    .toSorted((a, b) => b.seconds - a.seconds);
}

function main([junitPath, allowlistPath]) {
  const files = readFileSeconds(readFileSync(junitPath, "utf8"));
  // An empty report would pass every budget, so a guard that read nothing fails.
  if (files.length === 0) {
    console.error(`No test files in ${junitPath}: nothing was checked.`);
    return 1;
  }
  const over = findOverBudget(
    files,
    JSON.parse(readFileSync(allowlistPath, "utf8")),
  );
  for (const { path, seconds } of over) {
    console.error(`${path}: ${seconds.toFixed(1)} s`);
  }
  if (over.length > 0) {
    console.error(
      `${over.length} test file(s) over the ${FILE_BUDGET_SECONDS} s budget. ` +
        "Wait on a fake clock or an event, not on real time (clients/gui-app/AGENTS.md, Testing), " +
        `or name the file with a reason in ${allowlistPath}.`,
    );
    return 1;
  }
  console.log(`${files.length} test files within ${FILE_BUDGET_SECONDS} s.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
