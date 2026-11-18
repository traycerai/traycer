#!/usr/bin/env node
/**
 * Cuts the browser regressions into shards of equal measured time.
 *
 * Playwright's `--shard` deals tests out in order, and a spec here takes
 * anywhere from under a second to many minutes in total, so equal counts are
 * not equal work: the shards of one run took 3.8 to 13.2 minutes on
 * 2 Nov 2026, and the workflow waits for the slowest. This deals whole spec
 * files out by what each took when last measured
 * (`browser-tests/test-timings.json`, written by `browser-test-timings.ts`).
 *
 * Every shard job computes the whole plan from the same checkout and takes its
 * own share, so the plan is a pure function of the files and the timings, and
 * a file on disk is in exactly one share whatever the timings say about it. A
 * stale timing costs balance, never coverage.
 *
 *   node scripts/browser-test-shard-plan.ts 3/8   # the third share, one path a line
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUI_APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_ROOT = "browser-tests";
export const TIMINGS_PATH = join(GUI_APP_ROOT, SPEC_ROOT, "test-timings.json");

/** Seconds by spec file, as `test-timings.json` stores them. */
export type FileTimings = Readonly<Record<string, number>>;

/**
 * Deals `files` into `count` shares, heaviest file first, each to the lightest
 * share so far. A file with no timing weighs the mean of those that have one.
 */
export function planShards(
  files: readonly string[],
  timings: Readonly<Partial<FileTimings>>,
  count: number,
): string[][] {
  const known = files.flatMap((file) => timings[file] ?? []);
  const unknownWeight =
    known.length === 0
      ? 1
      : known.reduce((sum, seconds) => sum + seconds, 0) / known.length;
  const weighted = files
    .map((file) => ({ file, weight: timings[file] ?? unknownWeight }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shares = Array.from({ length: count }, () => ({
    files: [] as string[],
    weight: 0,
  }));
  for (const { file, weight } of weighted) {
    const lightest = shares.reduce((best, share) =>
      share.weight < best.weight ? share : best,
    );
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return shares.map((share) => share.files.sort());
}

/** Every spec on disk, as a path from `clients/gui-app`. */
function specFiles(): string[] {
  return readdirSync(join(GUI_APP_ROOT, SPEC_ROOT), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => `${SPEC_ROOT}/${name.split("\\").join("/")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
  if (match === null) {
    throw new Error("usage: browser-test-shard-plan.ts <index>/<count>");
  }
  const timings = JSON.parse(readFileSync(TIMINGS_PATH, "utf8")) as FileTimings;
  const shares = planShards(specFiles(), timings, Number(match[2]));
  process.stdout.write(`${shares[Number(match[1]) - 1].join("\n")}\n`);
}
