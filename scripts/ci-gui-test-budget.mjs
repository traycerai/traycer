#!/usr/bin/env node
// Per-file time budget for the gui-app suite, run by each shard of `test.yml`.
//
//   node scripts/ci-gui-test-budget.mjs <junit.xml> <project directory>
//
// A file over the budget fails the job unless the project's
// `test-budget-allowlist.json` names it with a reason: a JSON object of file
// path (as the report names it, relative to the project) to reason.
//
// One reading is not enough to fail on. On the shared runners a file of 5 s
// read 12 s in one run and under 5 s in the next, with nothing changed. So a
// file over the budget runs once more, alone, and only a second reading over
// the budget, or a second run that fails, fails the step. A file that passes
// alone is still printed: a stall that size is worth a look.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FILE_BUDGET_SECONDS = 10;

const ALLOWLIST_FILE = "test-budget-allowlist.json";
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

/**
 * Judges one shard's readings. `remeasureAlone` is called only when a file the
 * allowlist does not name is over the budget, with exactly those paths, and
 * returns a Map of path to seconds. An entry with a blank reason allows nothing.
 */
export function evaluateBudget(files, allowlist, remeasureAlone) {
  const unlisted = files
    .filter(({ path, seconds }) => {
      if (seconds <= FILE_BUDGET_SECONDS) return false;
      const reason = allowlist[path];
      return typeof reason !== "string" || reason.trim() === "";
    })
    .toSorted((a, b) => b.seconds - a.seconds);
  const second =
    unlisted.length === 0
      ? new Map()
      : remeasureAlone(unlisted.map(({ path }) => path));
  const readings = unlisted.map(({ path, seconds }) => ({
    path,
    seconds,
    aloneSeconds: second.get(path) ?? null,
  }));
  return {
    overBudget: readings.filter(
      ({ aloneSeconds }) =>
        aloneSeconds === null || aloneSeconds > FILE_BUDGET_SECONDS,
    ),
    spikes: readings.filter(
      ({ aloneSeconds }) =>
        aloneSeconds !== null && aloneSeconds <= FILE_BUDGET_SECONDS,
    ),
  };
}

/**
 * What a second run measured. A run that did not exit cleanly measured nothing,
 * whatever its report says: a failed import still writes the file at about zero,
 * and that must not read as a fast file.
 */
export function secondRunSeconds(exitStatus, reportXml) {
  if (exitStatus !== 0 || reportXml === null) return new Map();
  return new Map(
    readFileSeconds(reportXml).map(({ path, seconds }) => [path, seconds]),
  );
}

function remeasureAlone(projectDirectory, paths) {
  const directory = mkdtempSync(join(tmpdir(), "gui-test-budget-"));
  try {
    const report = join(directory, "report.xml");
    const { status } = spawnSync(
      "bun",
      [
        "run",
        "vitest",
        "run",
        ...paths,
        "--maxWorkers=1",
        "--reporter=default",
        "--reporter=junit",
        `--outputFile.junit=${report}`,
      ],
      { cwd: projectDirectory, stdio: "inherit" },
    );
    return secondRunSeconds(
      status,
      existsSync(report) ? readFileSync(report, "utf8") : null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function describeSecond(aloneSeconds) {
  return aloneSeconds === null
    ? "the second run failed"
    : `${aloneSeconds.toFixed(1)} s alone`;
}

function main([junitPath, projectDirectory]) {
  const files = readFileSeconds(readFileSync(junitPath, "utf8"));
  // An empty report would pass every budget, so a guard that read nothing fails.
  if (files.length === 0) {
    console.error(`No test files in ${junitPath}: nothing was checked.`);
    return 1;
  }
  const allowlistPath = join(projectDirectory, ALLOWLIST_FILE);
  const { overBudget, spikes } = evaluateBudget(
    files,
    JSON.parse(readFileSync(allowlistPath, "utf8")),
    (paths) => remeasureAlone(projectDirectory, paths),
  );
  for (const { path, seconds, aloneSeconds } of spikes) {
    console.log(
      `${path}: ${seconds.toFixed(1)} s on the shard, ${describeSecond(aloneSeconds)}: a stall, not counted.`,
    );
  }
  for (const { path, seconds, aloneSeconds } of overBudget) {
    console.error(
      `${path}: ${seconds.toFixed(1)} s on the shard, ${describeSecond(aloneSeconds)}`,
    );
  }
  if (overBudget.length > 0) {
    console.error(
      `${overBudget.length} test file(s) over the ${FILE_BUDGET_SECONDS} s budget. ` +
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
