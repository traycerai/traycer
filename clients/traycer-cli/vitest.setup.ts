import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

// Pin the home directory to a private temp dir for every test file, BEFORE
// the file - or anything it imports - is evaluated.
//
// `store/paths` binds `~/.traycer` from `os.homedir()` at module load, and the
// protocol and shared path helpers resolve it themselves. A suite that runs a
// real provisioning segment, the update-attempt lock or a CLI-slot staging
// without isolating the home therefore reads and writes the developer's REAL
// `~/.traycer` - the live host's home, its update lock, its credentials.
// Several did (`ensure`, `host-install`, `provision*`). Per-suite `node:os`
// mocks cannot be trusted to cover it: replacing one `store/paths` export
// leaves every helper that calls the module's own `hostHomeDir` on the real
// home. `os.homedir()` answers from HOME (USERPROFILE on Windows) on every
// call, so setting both here redirects every module, mocked or not; a
// suite's own per-test isolation nests inside this one.
//
// Per test file, not per worker: setup files run before each file, and a
// worker's environment carries over between them, so the ORIGINAL home is
// kept in the environment on the first pass and never re-read from HOME.
const ORIGINAL_HOME_ENV = "TRAYCER_VITEST_ORIGINAL_HOME";
const originalHome = process.env[ORIGINAL_HOME_ENV] ?? homedir();
process.env[ORIGINAL_HOME_ENV] = originalHome;
const testHome = mkdtempSync(join(tmpdir(), "traycer-cli-test-home-"));
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

// Refuse any `fetch` that would leave this machine, and FAIL the test that
// made it.
//
// The CLI's registry code paths - the store-format floor's manifest lookup,
// the registry client, the yank lookup - reach GitHub Releases through the
// global `fetch`. A suite that exercises one of them without stubbing
// `registry/fetch-resource` therefore does a REAL network round trip per
// case, and the manifest lookup's 5 s watchdog equals vitest's default test
// timeout, so a slow CDN reply fails the case as "Test timed out in 5000ms"
// with nothing in the output that names the network. Two suites shipped that
// way and flaked on `main` (#1893).
//
// Rejecting the call is not enough on its own: `fetchText` retries a
// rejection and the floor then fails soft to its fixed table, so an
// unmocked suite would still pass - slower, and silently. The `afterEach`
// below is what makes the escape loud: every blocked URL is charged to the
// test that was running, and that test fails naming it.
//
// Loopback stays open: the registry client's blackhole suites and the
// download-stage suites run real HTTP fixture servers on 127.0.0.1. The RFC
// 2606 `.invalid` TLD stays open too - it never resolves, and one suite uses
// it to exercise a DNS failure. A suite that needs any other host installs
// its own `fetch` (`vi.stubGlobal`) or mocks `registry/fetch-resource`.
//
// Anything that opens a socket without going through `fetch` (`node:http`,
// `node:net`) is not covered here.

const originalFetch = globalThis.fetch;
let blockedUrls: string[] = [];

// The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    IPV4_LOOPBACK.test(hostname) ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".invalid")
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

globalThis.fetch = (
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Response> => {
  const url = requestUrl(input);
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Not an absolute URL: let `fetch` produce its own TypeError.
    return originalFetch(input, init);
  }
  if (!isLocalHostname(hostname)) {
    blockedUrls.push(url);
    return Promise.reject(
      new TypeError(
        `traycer-cli tests must not reach the network: fetch(${url}) blocked by vitest.setup.ts`,
      ),
    );
  }
  return originalFetch(input, init);
};

beforeEach(() => {
  blockedUrls = [];
});

afterEach(() => {
  if (blockedUrls.length === 0) return;
  const urls = [...new Set(blockedUrls)].join(", ");
  blockedUrls = [];
  throw new Error(
    `this test reached the network through fetch (${urls}). ` +
      "Stub 'registry/fetch-resource' (see host-update-downgrade.test.ts) or install a test fetch with vi.stubGlobal.",
  );
});
