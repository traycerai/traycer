/**
 * Fails the protocol test leg when a test file took more than
 * {@link TEST_FILE_BUDGET_MS} and `test-budget-allowlist.json` does not name it
 * with a reason. The reading is the JUnit report's: a file's hooks and tests,
 * not its import, which the report does not carry.
 *
 * `test.yml` runs this after `Test`, on the report that run wrote:
 *
 *   bun protocol/scripts/test-budget.ts protocol/test-results/junit.xml
 *
 * One reading is not enough to fail on, because a file's time on the shared
 * runner moves by half between runs of the same commit. So a file over the
 * budget runs once more, alone, and only a second reading over the budget, or a
 * second run that fails, fails the step. A file that passes alone is still
 * printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROTOCOL_DIRECTORY = join(import.meta.dirname, "..");
const ALLOWLIST_PATH = join(PROTOCOL_DIRECTORY, "test-budget-allowlist.json");

/** A test file's budget on the merge run. */
export const TEST_FILE_BUDGET_MS = 10_000;

/** A file over the budget, with both its readings. */
type OverBudgetFile = {
  readonly path: string;
  readonly firstMs: number;
  /** `null` when the second run failed or wrote no time for the file. */
  readonly aloneMs: number | null;
};

type TestBudgetResult = {
  /** Over the budget on the leg, and again alone or with no second reading: these fail the step. */
  readonly overBudget: readonly OverBudgetFile[];
  /** Over the budget on the leg, within it alone. */
  readonly spikes: readonly OverBudgetFile[];
  /** How many files the allowlist let over the budget. */
  readonly allowlistedOver: number;
};

function xmlAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(attributes);
  return match?.[1] ?? null;
}

/**
 * Vitest writes one `<testsuite>` per file, with the file as `name` and the
 * seconds its tests took as `time`.
 */
export function junitFileDurationsMs(xml: string): ReadonlyMap<string, number> {
  const durations = new Map<string, number>();
  for (const [, attributes] of xml.matchAll(/<testsuite\s([^>]*)>/gu)) {
    const name = xmlAttribute(attributes, "name");
    const time = xmlAttribute(attributes, "time");
    // `Number(null)` and `Number("")` are 0, which would read a suite with no
    // time as one measured at zero; only a number that was written counts.
    if (name === null || time === null || time.trim() === "") continue;
    const seconds = Number(time);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    durations.set(name, seconds * 1_000);
  }
  return durations;
}

/**
 * Reads `test-budget-allowlist.json`'s parsed content, a map from a test file's
 * path under `protocol/` to the reason it may exceed the budget. Returns `null`
 * for anything else, because a guard that cannot read its allowlist must not
 * guess at it.
 */
export function parseTestBudgetAllowlist(
  value: unknown,
): ReadonlyMap<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const allowlist = new Map<string, string>();
  for (const [path, reason] of Object.entries(value)) {
    if (typeof reason !== "string") return null;
    allowlist.set(path, reason);
  }
  return allowlist;
}

/**
 * Judges one run's readings. `remeasureAloneMs` is called only when a file not
 * on the allowlist is over the budget, with exactly those files. An entry with a
 * blank reason names a file without saying why, and allows nothing.
 */
export function evaluateTestBudget(
  durationsMs: ReadonlyMap<string, number>,
  allowlist: ReadonlyMap<string, string>,
  remeasureAloneMs: (paths: readonly string[]) => ReadonlyMap<string, number>,
): TestBudgetResult {
  const over = [...durationsMs.entries()]
    .filter(([, ms]) => ms > TEST_FILE_BUDGET_MS)
    .sort(([left], [right]) => left.localeCompare(right));
  const unlisted = over.filter(
    ([path]) => (allowlist.get(path) ?? "").trim() === "",
  );
  const secondReadings =
    unlisted.length === 0
      ? new Map<string, number>()
      : remeasureAloneMs(unlisted.map(([path]) => path));
  const readings = unlisted.map(([path, firstMs]) => ({
    path,
    firstMs,
    aloneMs: secondReadings.get(path) ?? null,
  }));
  return {
    overBudget: readings.filter(
      ({ aloneMs }) => aloneMs === null || aloneMs > TEST_FILE_BUDGET_MS,
    ),
    spikes: readings.filter(
      ({ aloneMs }) => aloneMs !== null && aloneMs <= TEST_FILE_BUDGET_MS,
    ),
    allowlistedOver: over.length - unlisted.length,
  };
}

/**
 * What a second run measured. A run that did not exit cleanly measured nothing,
 * whatever its report says: a killed fork or a failed import still writes a
 * report, with the file at about zero, and that must not read as a fast file.
 */
export function secondRunDurationsMs(
  exitStatus: number | null,
  reportXml: string | null,
): ReadonlyMap<string, number> {
  if (exitStatus !== 0 || reportXml === null) return new Map<string, number>();
  return junitFileDurationsMs(reportXml);
}

/** Runs `paths` one worker at a time and reads what they took from their own report. */
function remeasureAloneMs(
  paths: readonly string[],
): ReadonlyMap<string, number> {
  const directory = mkdtempSync(join(tmpdir(), "protocol-test-budget-"));
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
      { cwd: PROTOCOL_DIRECTORY, stdio: "inherit" },
    );
    return secondRunDurationsMs(
      status,
      existsSync(report) ? readFileSync(report, "utf8") : null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * One file's readings in the shape the run logs are searched by:
 * `budget <path> first=12.3s second=4.1s verdict=spike`. `second=none` is a
 * second run that failed or wrote no time for the file.
 */
export function describeBudgetReading(
  { path, firstMs, aloneMs }: OverBudgetFile,
  verdict: "over" | "spike",
): string {
  const second = aloneMs === null ? "none" : seconds(aloneMs);
  return `budget ${path} first=${seconds(firstMs)} second=${second} verdict=${verdict}`;
}

function main(report: string | undefined): void {
  if (report === undefined) {
    console.error("usage: test-budget.ts <JUnit report>");
    process.exit(2);
  }
  const allowlistJson: unknown = JSON.parse(
    readFileSync(ALLOWLIST_PATH, "utf8"),
  );
  const allowlist = parseTestBudgetAllowlist(allowlistJson);
  if (allowlist === null) {
    console.error(
      `${ALLOWLIST_PATH} is not a map from a test file to a reason.`,
    );
    process.exit(1);
  }
  // The tests passed to get here, and Nx restores this report on a cache hit,
  // so a report that is missing or names no file means nothing was measured,
  // and that is not a pass.
  const durationsMs = existsSync(report)
    ? junitFileDurationsMs(readFileSync(report, "utf8"))
    : new Map<string, number>();
  if (durationsMs.size === 0) {
    console.error(`${report} names no test file, so nothing was measured.`);
    process.exit(1);
  }
  const { overBudget, spikes, allowlistedOver } = evaluateTestBudget(
    durationsMs,
    allowlist,
    remeasureAloneMs,
  );
  console.log(
    `${String(durationsMs.size)} files measured against ${seconds(TEST_FILE_BUDGET_MS)}; ${String(allowlistedOver)} over it on the allowlist.`,
  );
  for (const file of spikes) {
    console.log(describeBudgetReading(file, "spike"));
  }
  if (overBudget.length > 0) {
    for (const file of overBudget) {
      console.error(describeBudgetReading(file, "over"));
    }
    console.error(
      "Make each file marked over fast, or name it in protocol/test-budget-allowlist.json with a reason. second=none means the second run failed, and its output is above; every file it was running reads none.",
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv[2]);
}
