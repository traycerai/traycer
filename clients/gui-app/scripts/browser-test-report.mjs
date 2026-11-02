/**
 * Reads Playwright's JSON report, which `browser-regressions.yml` uploads from
 * every shard as `browser-results-<shard>`.
 */

/**
 * @typedef {object} ReportedTest
 * @property {string} file path from `clients/gui-app`
 * @property {string} name the describe titles and the test title, joined
 * @property {number} seconds the last attempt's time
 * @property {number} retries attempts before the last
 */

/**
 * Every test that ran, one entry per project and repeat; a skipped test has
 * no attempt that took time and is left out.
 *
 * @param {{ suites?: readonly object[] }} report
 * @returns {ReportedTest[]}
 */
export function reportedTests(report) {
  /** @type {ReportedTest[]} */
  const tests = [];
  /**
   * @param {any} suite
   * @param {readonly string[]} titles
   */
  const visit = (suite, titles) => {
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
