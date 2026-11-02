import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

// Pin the home directory to a private temp dir for every test file, BEFORE
// the file - or anything it imports - is evaluated. The same guard as
// `clients/traycer-cli/vitest.setup.ts`, which has the full rationale.
//
// This package reaches `~/.traycer` too: the bearer source reads
// `~/.traycer/cli/credentials` (`auth/bearer-source.ts`), and the protocol
// path helpers it imports resolve the host home and the update lock from
// `os.homedir()`. That answers from HOME (USERPROFILE on Windows) on every
// call, so setting both here redirects every module, mocked or not; a
// suite's own per-test isolation nests inside this one.
const ORIGINAL_HOME_ENV = "TRAYCER_VITEST_ORIGINAL_HOME";
const originalHome = process.env[ORIGINAL_HOME_ENV] ?? homedir();
process.env[ORIGINAL_HOME_ENV] = originalHome;
const testHome = mkdtempSync(join(tmpdir(), "traycer-shared-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
if (homedir() !== testHome || homedir() === originalHome) {
  throw new Error(
    "vitest.setup: os.homedir() does not resolve to this file's temp home - refusing to run a suite against the developer's home",
  );
}

afterEach(() => {
  // A test that restores a HOME it captured before this file ran would put
  // the rest of the file back on the developer's home.
  if (homedir() === originalHome) {
    throw new Error(
      "vitest.setup: a test put os.homedir() back on the developer's home",
    );
  }
});

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
