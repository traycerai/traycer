import { describe, expect, it, vi } from "vitest";

// `cli-discovery.ts` imports `app/logger` (which imports `electron-log`).
// Stub it so the module loads under vitest.
vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info", resolvePathFn: vi.fn() },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// `compareHostVersions` drives the host "update available?" decision in
// `buildUpdateState`. Unlike `compareSemver` (CLI bundled-vs-PATH trust, which
// strips pre-release suffixes by design), this comparator MUST order a
// pre-release below its GA so a `1.0.0-rc.1` host upgrades to `1.0.0`.
describe("compareHostVersions", () => {
  it("orders ordinary triplets", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    expect(compareHostVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareHostVersions("1.5.0", "1.5.1")).toBe(-1);
    expect(compareHostVersions("1.5.0", "1.5.0")).toBe(0);
    expect(compareHostVersions("1.10.0", "1.9.0")).toBe(1);
  });

  // The reported bug: a release-candidate host must see its GA as newer.
  // `compareSemver` stripped the `-rc.1` and called them equal, so the Updates
  // row read "Up to date" and the launch auto-update never fired.
  it("orders a pre-release below its GA (1.0.0-rc.1 < 1.0.0)", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareHostVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("orders pre-releases against each other by SemVer §11", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    // beta < rc (ASCII), rc.1 < rc.2, and numeric fields compare numerically
    // (beta.2 < beta.11) rather than lexically (where "2" > "11").
    expect(compareHostVersions("1.0.0-beta.3", "1.0.0-rc.1")).toBe(-1);
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBe(-1);
    expect(compareHostVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
    // A longer identifier list outranks its prefix (alpha < alpha.1).
    expect(compareHostVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });

  it("does not advertise a downgrade when installed is newer than latest", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    expect(compareHostVersions("0.0.3", "0.0.2")).toBe(1);
    expect(compareHostVersions("1.2.0", "1.2.0-rc.5")).toBe(1);
  });

  it("ignores build metadata", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    expect(compareHostVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
    expect(compareHostVersions("1.0.0-rc.1+build", "1.0.0")).toBe(-1);
  });

  it("returns 0 for unparseable input so no spurious update is advertised", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    expect(compareHostVersions("not-a-version", "1.0.0")).toBe(0);
    expect(compareHostVersions("1.0.0", "")).toBe(0);
    expect(compareHostVersions("1.0", "1.0.0")).toBe(0);
    // Malformed input is rejected rather than smuggled through by a lenient
    // Number.parseInt ("1.2.3abc" → [1,2,3]); accepting the trailing garbage
    // would make these compare as -1 and wrongly advertise an update.
    expect(compareHostVersions("1.2.3abc", "1.2.4")).toBe(0);
    expect(compareHostVersions("1.0.0 ", "1.0.1")).toBe(0);
  });
});

/**
 * PARITY WITH THE CLIENT-SHARED COMPARATOR.
 *
 * The desktop app updater's release selector orders `desktop-v*` candidates
 * with THIS comparator, while the host update surfaces order the same kinds of
 * version strings with `@traycer-clients/shared`'s. Two comparators deciding
 * "which build is newer" for one product is a drift risk, and the one that
 * would hurt is silent: an RC-line follower and a Settings row disagreeing
 * about whether `2.0.0` outranks `2.0.0-rc.2`.
 *
 * These pin agreement over the domain the selector actually sees - versions
 * that survived `projectDesktopRelease`'s strict `X.Y.Z[-rc.N]` tag grammar -
 * and state the one place outside that domain where the two deliberately
 * differ. If a bump or refactor makes them disagree inside it, this fails
 * before a release does.
 */
describe("compareHostVersions parity with @traycer-clients/shared", () => {
  // Every pair the desktop selector can be asked to order: same line, across
  // lines, RC vs its GA, and RC vs RC.
  const SELECTOR_DOMAIN_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["2.0.0-rc.1", "2.0.0-rc.2"],
    ["2.0.0-rc.2", "2.0.0-rc.1"],
    ["2.0.0-rc.1", "2.0.0-rc.1"],
    ["2.0.0-rc.1", "2.0.0"],
    ["2.0.0", "2.0.0-rc.9"],
    ["2.0.0-rc.1", "2.1.0-rc.1"],
    ["2.0.0-rc.1", "2.0.1"],
    ["2.0.0", "2.0.0"],
    ["2.0.0", "10.0.0"],
    ["1.9.0", "2.0.0-rc.0"],
    ["2.0.0-rc.0", "2.0.0-rc.10"],
    ["0.0.0", "0.0.1-rc.1"],
  ];

  function sharedSign(ordering: "less" | "equal" | "greater"): number {
    if (ordering === "greater") return 1;
    return ordering === "less" ? -1 : 0;
  }

  it.each(SELECTOR_DOMAIN_PAIRS)(
    "orders %s vs %s identically",
    async (a, b) => {
      const { compareHostVersions } = await import("../cli-discovery");
      const { compareHostVersions: sharedCompare } =
        await import("@traycer-clients/shared/host-version/compare-host-versions");
      const shared = sharedCompare(a, b);
      if (!shared.comparable) {
        throw new Error(`expected ${a} vs ${b} to be comparable`);
      }
      expect(compareHostVersions(a, b)).toBe(sharedSign(shared.ordering));
    },
  );

  it("differs only outside that domain, on input the selector cannot produce", async () => {
    const { compareHostVersions } = await import("../cli-discovery");
    const { compareHostVersions: sharedCompare } =
      await import("@traycer-clients/shared/host-version/compare-host-versions");
    // A leading-zero numeric identifier is not valid SemVer. The shared
    // comparator rejects it outright; this one's looser `\d+` grammar compares
    // it. Harmless HERE because `projectDesktopRelease` rejects
    // `desktop-v2.0.0-rc.01` at the tag gate, so no such version ever reaches
    // the selector - and `isCanonicalReleaseCandidate` rejects it a second time
    // before it could name a release line. Pinned so the divergence stays a
    // known, contained one rather than a surprise at the next bump.
    expect(sharedCompare("2.0.0-rc.01", "2.0.0-rc.2").comparable).toBe(false);
    expect(compareHostVersions("2.0.0-rc.01", "2.0.0-rc.2")).toBe(-1);
  });
});
