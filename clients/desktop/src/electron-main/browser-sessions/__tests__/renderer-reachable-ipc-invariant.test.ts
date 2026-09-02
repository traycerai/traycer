import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NO COOKIE, STORAGE STATE OR KEY MATERIAL CROSSES TO A RENDERER.
 *
 * The primary enforcement of this is the type system: main projects
 * `BrowserSessionsUxServerFrame`, which the protocol defines as an `Exclude`
 * over every jar-bearing frame plus a `never` assertion over `cookies` /
 * `storageState` / `rawKey` / `wrappedKey` / `seedStorageState`, so a new jar
 * frame that is not excluded fails the build at the projection.
 *
 * This is the second line, and it covers what types cannot: a NEW channel.
 * A type only speaks for the payloads someone declared; a fresh
 * `browserViewSomethingWithCookies` handler would type-check perfectly. So the
 * three files that together define what a renderer can reach - the channel
 * list, the payload schemas it parses, and the bridge surface the preload
 * exposes - are scanned for the vocabulary of jar material.
 *
 * Modelled on `traycer-host/src/__tests__/no-account-identifiers-in-logs.test.ts`,
 * and with the same stated limit: a source scan decides a syntactic question.
 * It cannot see a cookie that arrives inside an opaque `unknown`, which is why
 * the compile-time gate above is the primary one and this is the tripwire.
 */

/** The desktop package root, which is vitest's working directory here. */
const DESKTOP = process.cwd();

/** The three files that decide what a renderer can reach. */
const RENDERER_REACHABLE_SOURCES = [
  {
    label: "ipc-channels.ts",
    path: resolve(DESKTOP, "src/ipc-contracts/ipc-channels.ts"),
  },
  {
    label: "browser-view-ipc-payload.ts",
    path: resolve(DESKTOP, "src/electron-main/ipc/browser-view-ipc-payload.ts"),
  },
  {
    label: "shared/platform/browser-view.ts",
    path: resolve(DESKTOP, "../shared/platform/browser-view.ts"),
  },
] as const;

/**
 * The vocabulary of jar material. Names rather than shapes, because a scan can
 * only decide names - and every one of these is the exact identifier the
 * deleted channels used, so a re-introduction spells itself.
 */
const FORBIDDEN = [
  "browserStorageStateSchema",
  "browserStorageCookieSchema",
  "BrowserStorageState",
  "BrowserStorageCookie",
  "seedStorageState",
  "storageState",
  "rawKey",
  "wrappedKey",
  "cookies",
] as const;

function offendingLines(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      (entry) =>
        // Comments may name what was removed and why; declarations may not.
        !entry.line.trimStart().startsWith("*") &&
        !entry.line.trimStart().startsWith("//") &&
        FORBIDDEN.some((token) => entry.line.includes(token)),
    )
    .map((entry) => `${entry.number}: ${entry.line.trim()}`);
}

describe("no renderer-reachable browser IPC carries jar material", () => {
  for (const source of RENDERER_REACHABLE_SOURCES) {
    it(`${source.label} names no cookie array, storage state or key material`, () => {
      expect(offendingLines(readFileSync(source.path, "utf8"))).toEqual([]);
    });
  }

  it("scans files that actually exist", () => {
    for (const source of RENDERER_REACHABLE_SOURCES) {
      expect(readFileSync(source.path, "utf8").length).toBeGreaterThan(0);
    }
  });
});
