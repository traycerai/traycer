import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: (): string => "/tmp/desktop-app" },
}));

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

// A pre-release must sort below its GA so a `1.0.0-rc.1` host upgrades to `1.0.0`.
describe("compareHostVersions", () => {
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
    // Pinned so the divergence stays a known, contained one rather than a surprise at the next bump.
    expect(sharedCompare("2.0.0-rc.01", "2.0.0-rc.2").comparable).toBe(false);
    expect(compareHostVersions("2.0.0-rc.01", "2.0.0-rc.2")).toBe(-1);
  });
});
