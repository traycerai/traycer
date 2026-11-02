#!/usr/bin/env node
/**
 * Writes `browser-tests/test-timings.json`, the measured time per spec file
 * that `browser-test-shard-plan.ts` cuts the shards by. From `clients/gui-app`,
 * with the id of a run whose shards all passed:
 *
 *   gh run download <run id> --repo traycerai/traycer \
 *     --pattern 'browser-results-*' --dir /tmp/browser-results
 *   node scripts/browser-test-timings.ts /tmp/browser-results
 *
 * Refresh it when a run's slowest shard is well above its median one: that is
 * what a slow spec added since the last refresh looks like. Nothing breaks in
 * the meantime; a stale file costs balance, never coverage.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { reportedTests, type JsonReport } from "./browser-test-report.ts";
import { TIMINGS_PATH, type FileTimings } from "./browser-test-shard-plan.ts";

/** Fewer files than this is part of a run, not a whole one. */
const WHOLE_RUN_MIN_FILES = 50;

/** Seconds per file over all of `reports`, to the tenth, sorted by path. */
export function fileTimings(reports: readonly JsonReport[]): FileTimings {
  const seconds = new Map<string, number>();
  for (const report of reports) {
    for (const test of reportedTests(report)) {
      seconds.set(test.file, (seconds.get(test.file) ?? 0) + test.seconds);
    }
  }
  return Object.fromEntries(
    [...seconds.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, total]) => [file, Math.round(total * 10) / 10]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv.at(2);
  if (root === undefined) {
    throw new Error("usage: browser-test-timings.ts <downloaded artifacts>");
  }
  const reports = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith("test-results.json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(root, name), "utf8")) as JsonReport,
    );
  const timings = fileTimings(reports);
  const files = Object.keys(timings).length;
  if (files < WHOLE_RUN_MIN_FILES) {
    throw new Error(
      `${String(files)} files measured: that is not a whole run's reports`,
    );
  }
  writeFileSync(TIMINGS_PATH, `${JSON.stringify(timings, null, 2)}\n`);
  process.stdout.write(`${String(files)} files written to ${TIMINGS_PATH}\n`);
}
