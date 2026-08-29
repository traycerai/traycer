import { describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesGetFilter, CookiesSetDetails } from "electron";
import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { migrateBrowserPersistenceToPersistentPartition } from "../browser-persistence-migration";
import type {
  BrowserEphemeralStorageSession,
  BrowserPersistenceMigrationDependencies,
} from "../browser-persistence-migration";
import { seedBrowserViewCookies } from "../browser-storage-state";
import type { BrowserStorageSession } from "../browser-storage-state";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const SESSION_COOKIE: Cookie = {
  name: "sid",
  value: "abc",
  domain: "example.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  session: false,
  expirationDate: 4102444800,
  sameSite: "lax",
};

/** Order matters more than any single call here, so every step records into it. */
class MigrationTrace {
  readonly steps: string[] = [];
}

function makeEphemeralSession(
  trace: MigrationTrace,
  cookies: readonly Cookie[],
): BrowserEphemeralStorageSession {
  return {
    cookies: {
      get: (_filter: CookiesGetFilter) => {
        trace.steps.push("ephemeral-get");
        return Promise.resolve([...cookies]);
      },
      set: (_details: CookiesSetDetails) => Promise.resolve(),
      flushStore: () => Promise.resolve(),
    },
    clearStorageData: () => {
      trace.steps.push("ephemeral-clear");
      return Promise.resolve();
    },
  };
}

function makePersistentSession(
  trace: MigrationTrace,
  written: CookiesSetDetails[],
): BrowserStorageSession {
  return {
    cookies: {
      get: (_filter: CookiesGetFilter) => Promise.resolve([]),
      set: (details: CookiesSetDetails) => {
        trace.steps.push("persistent-set");
        written.push(details);
        return Promise.resolve();
      },
      flushStore: () => Promise.resolve(),
    },
  };
}

function makeDependencies(input: {
  readonly trace: MigrationTrace;
  readonly cookies: readonly Cookie[];
  readonly written: CookiesSetDetails[];
  readonly recreated: readonly string[];
}): BrowserPersistenceMigrationDependencies {
  return {
    readEphemeralSession: () =>
      makeEphemeralSession(input.trace, input.cookies),
    readPersistentSession: () =>
      makePersistentSession(input.trace, input.written),
    // The real seed path, not a stub: its validation is the reason §6.4 routes
    // the copy through it rather than looping `cookies.set` by hand.
    seedCookies: seedBrowserViewCookies,
    recreateTabs: () => {
      input.trace.steps.push("recreate-tabs");
      return Promise.resolve(input.recreated);
    },
  };
}

describe("migrateBrowserPersistenceToPersistentPartition", () => {
  it("copies the ephemeral jar into the persistent one through the seed path", async () => {
    const trace = new MigrationTrace();
    const written: CookiesSetDetails[] = [];
    const result = await migrateBrowserPersistenceToPersistentPartition(
      makeDependencies({
        trace,
        cookies: [SESSION_COOKIE],
        written,
        recreated: [],
      }),
    );

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      name: "sid",
      value: "abc",
      url: "https://example.com/",
      httpOnly: true,
      secure: true,
    });
    expect(result.cookiesCopied).toBe(1);
  });

  it("recreates the open tabs after the copy and clears the ephemeral jar last", async () => {
    const trace = new MigrationTrace();
    const result = await migrateBrowserPersistenceToPersistentPartition(
      makeDependencies({
        trace,
        cookies: [SESSION_COOKIE],
        written: [],
        recreated: ["guest-a", "guest-b"],
      }),
    );

    // A tile recreated before the copy would come back signed out, and a jar
    // cleared before the tiles move would take the logins with it.
    expect(trace.steps).toEqual([
      "ephemeral-get",
      "persistent-set",
      "recreate-tabs",
      "ephemeral-clear",
    ]);
    expect(result).toEqual({
      cookiesCopied: 1,
      tabsRecreated: 2,
      ephemeralCleared: true,
    });
  });

  it("still moves the tiles when the cookie copy fails", async () => {
    const trace = new MigrationTrace();
    const failing: BrowserPersistenceMigrationDependencies = {
      ...makeDependencies({
        trace,
        cookies: [],
        written: [],
        recreated: ["guest-a"],
      }),
      seedCookies: (_state: BrowserStorageState | null) =>
        Promise.reject(new Error("jar unreadable")),
    };

    const result =
      await migrateBrowserPersistenceToPersistentPartition(failing);

    expect(result).toEqual({
      cookiesCopied: 0,
      tabsRecreated: 1,
      ephemeralCleared: true,
    });
    expect(trace.steps).toContain("recreate-tabs");
  });
});
