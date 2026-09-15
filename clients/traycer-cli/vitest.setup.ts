import { afterEach, beforeEach } from "vitest";

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

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
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
