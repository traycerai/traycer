/**
 * Reads Playwright's JSON report, which `browser-regressions.yml` uploads from
 * every shard as `browser-results-<shard>`.
 */

interface ReportedAttempt {
  readonly status: string;
  readonly duration: number;
}

interface ReportedSuite {
  readonly title: string;
  readonly specs?: readonly {
    readonly title: string;
    readonly file: string;
    readonly tests: readonly { readonly results: readonly ReportedAttempt[] }[];
  }[];
  readonly suites?: readonly ReportedSuite[];
}

export interface JsonReport {
  readonly suites?: readonly ReportedSuite[];
}

export interface ReportedTest {
  /** The path from `clients/gui-app`. */
  readonly file: string;
  /** The describe titles and the test title, joined. */
  readonly name: string;
  /** The last attempt's time. */
  readonly seconds: number;
  /** Attempts before the last. */
  readonly retries: number;
}

/** Every test that ran; a skipped one took no time and is left out. */
export function reportedTests(report: JsonReport): ReportedTest[] {
  const tests: ReportedTest[] = [];
  const visit = (suite: ReportedSuite, titles: readonly string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        if (last === undefined || last.status === "skipped") continue;
        tests.push({
          file: `browser-tests/${spec.file}`,
          name: [...titles, spec.title].join(" › "),
          seconds: last.duration / 1000,
          retries: test.results.length - 1,
        });
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, [...titles, child.title]);
    }
  };
  // A top-level suite is the file; its title is the path, not a describe.
  for (const fileSuite of report.suites ?? []) visit(fileSuite, []);
  return tests;
}
