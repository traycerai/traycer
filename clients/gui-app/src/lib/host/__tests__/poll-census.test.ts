import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { authQueryKeys } from "@/lib/query-keys";

/**
 * Static census for redesign P4.1 / F22: push replaced the two 1s readiness
 * polls, and the app's only remaining standing timer against `GET
 * /api/v3/hosts` is the 60s `HOST_DIRECTORY_REFRESH_POLL_MS` interval.
 *
 * This is an ABSENCE search (no 1s poll survives), and an absence search that
 * is silently broken (wrong path, a typo'd regex) returns the empty set and
 * reads as success either way. Every "must be absent" assertion below is
 * paired with a positive control in the same suite that proves the search
 * machinery can still find something when something is actually there - see
 * `describe("positive controls")`.
 */
const guiAppSrc = path.resolve(import.meta.dirname, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(guiAppSrc, relativePath), "utf8");
}

/** Matches a 1-second-cadence `setInterval` or `refetchInterval`, spelled
 * either `1000` or `1_000`. */
const ONE_SECOND_CADENCE =
  /(?:setInterval\s*\([^,]*,\s*1_?000\s*\)|refetchInterval:\s*1_?000\b)/;

describe("poll census — 1s readiness polls stay gone", () => {
  it("has ZERO 1-second-cadence setInterval/refetchInterval in use-host-reachability.ts", () => {
    const source = readSource("hooks/agent/use-host-reachability.ts");
    expect(source).not.toMatch(ONE_SECOND_CADENCE);
    expect(source).not.toMatch(/setInterval/);
  });

  it("has ZERO 1-second-cadence setInterval/refetchInterval in use-remote-sessions-poll-readiness.ts", () => {
    const source = readSource(
      "hooks/host/use-remote-sessions-poll-readiness.ts",
    );
    expect(source).not.toMatch(ONE_SECOND_CADENCE);
    expect(source).not.toMatch(/setInterval/);
  });
});

describe("poll census — exactly one 60s registry poller in production", () => {
  it("HOST_DIRECTORY_REFRESH_POLL_MS is the sole surviving 60s registry poller", () => {
    const source = readSource("lib/host/host-directory-service.ts");
    expect(source).toMatch(/const HOST_DIRECTORY_REFRESH_POLL_MS\s*=\s*60_000/);
    expect(source).toMatch(/window\.setInterval\(/);
  });

  it("use-registered-hosts-query.ts declares no poll constant and passes no interval", () => {
    const source = readSource("hooks/auth/use-registered-hosts-query.ts");
    // No standing timer of its own: no `setInterval`, and no locally-declared
    // *_POLL_MS / *_INTERVAL_MS constant this file could pass as one.
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/const\s+\w*(POLL|INTERVAL)\w*_MS\s*=/);
    // Every `refetchInterval:` site in this file is literally `false` (or the
    // ternary collapsing to `false`), never a poll cadence.
    const refetchIntervalSites = [
      ...source.matchAll(/refetchInterval:\s*[^,\n]+/g),
    ].map((match) => match[0]);
    expect(refetchIntervalSites.length).toBeGreaterThan(0);
    for (const site of refetchIntervalSites) {
      expect(site).toMatch(/\bfalse\b/);
      // No numeric cadence anywhere in the expression - the file resolves
      // `refetchInterval` to `false` unconditionally, never a poll duration.
      expect(site).not.toMatch(/\d/);
    }
    // Every CALL site into the query-options builder (excluding its own
    // `function registeredHostsQueryOptions(...)` declaration, which the same
    // pattern also matches) passes `false` as the trailing `pollMs` argument,
    // never a named interval constant.
    const builderCallSites = [
      ...source.matchAll(/registeredHostsQueryOptions\([^)]*\)/g),
    ]
      .map((match) => match[0])
      .filter((site) => !site.includes(":"));
    expect(builderCallSites.length).toBeGreaterThan(0);
    for (const callSite of builderCallSites) {
      expect(callSite.trim().endsWith("false)")).toBe(true);
    }
  });

  it("only ONE file in the gui-app source declares a 60s registry-poll constant", () => {
    const declarationPattern =
      /const\s+HOST_DIRECTORY_REFRESH_POLL_MS\s*=\s*60_000/;
    const hits = sourceFiles(guiAppSrc).filter((relativePath) => {
      if (relativePath.includes("__tests__")) return false;
      return declarationPattern.test(readSource(relativePath));
    });
    expect(hits).toEqual(["lib/host/host-directory-service.ts"]);
  });
});

describe("positive controls — the search machinery can still find something real", () => {
  it("locates the surviving HOST_DIRECTORY_REFRESH_POLL_MS declaration", () => {
    const source = readSource("lib/host/host-directory-service.ts");
    const match = /const HOST_DIRECTORY_REFRESH_POLL_MS\s*=\s*(\d[\d_]*)/.exec(
      source,
    );
    expect(match).not.toBeNull();
    // Assert the CAPTURED number, not just "something matched" - proves the
    // pattern reads the real value rather than merely finding the identifier.
    if (match === null) throw new Error("unreachable: checked above");
    expect(match[1].replaceAll("_", "")).toBe("60000");
  });

  it("ONE_SECOND_CADENCE matches a deliberately-constructed 1s setInterval string", () => {
    expect("window.setInterval(() => tick(), 1_000)").toMatch(
      ONE_SECOND_CADENCE,
    );
    expect("window.setInterval(() => tick(), 1000)").toMatch(
      ONE_SECOND_CADENCE,
    );
  });

  it("ONE_SECOND_CADENCE matches a deliberately-constructed 1s refetchInterval string", () => {
    expect("refetchInterval: 1_000,").toMatch(ONE_SECOND_CADENCE);
    expect("refetchInterval: 1000,").toMatch(ONE_SECOND_CADENCE);
  });

  it("ONE_SECOND_CADENCE does NOT match a 60s interval (the pattern is cadence-specific, not just any interval)", () => {
    expect("window.setInterval(() => tick(), 60_000)").not.toMatch(
      ONE_SECOND_CADENCE,
    );
    expect("refetchInterval: 60_000,").not.toMatch(ONE_SECOND_CADENCE);
  });

  it("the declaration-count search finds a real hit before it is asked to find only one", () => {
    // Guards the "only ONE file declares this constant" test above: run the
    // SAME scan with a pattern known to match every source file's own
    // filename comment-free content at least twice (any gui-app file plus
    // this very file, which is excluded by the `__tests__` filter) - proving
    // `sourceFiles` walks more than a single directory and the filter is
    // doing real work, not vacuously passing because the walk found nothing.
    const anyFile = sourceFiles(guiAppSrc).filter(
      (relativePath) => !relativePath.includes("__tests__"),
    );
    expect(anyFile.length).toBeGreaterThan(10);
    expect(anyFile.includes("lib/host/host-directory-service.ts")).toBe(true);
  });
});

describe("registeredHostsAll is a genuine PREFIX of registeredHosts (F22 invalidation)", () => {
  // The directory's poll invalidates through `registeredHostsAll()` because
  // it runs outside React with no `AuthService` reference to build the exact
  // `registeredHosts(authService, userId)` key - it relies on TanStack's
  // prefix matching to catch every entry in the family at once. If the two
  // builders ever drift (a field reordered, a segment renamed on one but not
  // the other), the poll tick keeps running, `invalidateQueries` keeps
  // returning normally, and NOTHING in the suite goes red - Settings
  // liveness just quietly stops refreshing. A string-equality check on some
  // fixed length would not catch a genuine drift (it would need to already
  // know the "right" length), so this asserts prefix membership element-wise
  // against the ACTUAL longer key, which is what TanStack itself checks.
  it("every element of registeredHostsAll() matches the corresponding element of registeredHosts(...) in order", () => {
    const authServiceStub = {};
    const all = authQueryKeys.registeredHostsAll();
    const full = authQueryKeys.registeredHosts(authServiceStub, "user-1");

    expect(all.length).toBeGreaterThan(0);
    // A prefix cannot be longer than the key it prefixes - if it ever grew
    // to equal or exceed `full`'s length, TanStack's `partialMatchKey` would
    // stop treating it as a wildcard prefix.
    expect(all.length).toBeLessThan(full.length);
    for (let i = 0; i < all.length; i += 1) {
      expect(full[i]).toBe(all[i]);
    }
  });

  it("positive control: a deliberately-diverged prefix is NOT accepted as a match — the assertion above can fail", () => {
    const divergedAll: readonly unknown[] = ["auth", "registered-hosts-WRONG"];
    const full = authQueryKeys.registeredHosts({}, "user-1");
    const isPrefix =
      divergedAll.length > 0 &&
      divergedAll.length < full.length &&
      divergedAll.every((value, i) => full[i] === value);
    expect(isPrefix).toBe(false);
  });
});

function sourceFiles(directory: string): string[] {
  return listFilesRecursive(directory, directory);
}

function listFilesRecursive(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules"
        ? []
        : listFilesRecursive(root, absolutePath);
    }
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [path.relative(root, absolutePath)];
  });
}
