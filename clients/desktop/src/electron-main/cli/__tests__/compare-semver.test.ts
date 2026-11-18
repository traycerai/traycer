import { describe, expect, it, vi } from "vitest";

// `cli-discovery.ts` imports the desktop logger, whose `electron` dependency
// otherwise boots Vitest's real Electron runtime. These tests exercise only a
// pure comparator, so keep the suite independent of a downloaded Electron
// binary and the app lifecycle.
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

// `compareSemver` is the comparator that drives launch-time
// reconciliation's newest-wins decision (`cli-reconcile.ts`). SemVer
// precedence and the local-build sentinel are intentional and need
// regression coverage so a future contributor does not flatten RC ordering.
describe("compareSemver", () => {
  it("returns 1 / -1 / 0 for ordinary triplets", async () => {
    const { compareSemver } = await import("../cli-discovery");
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.5.0", "1.5.1")).toBe(-1);
    expect(compareSemver("1.5.0", "1.5.0")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
  });

  it.each([
    ["1.5.0-rc.10", "1.5.0-rc.2", 1],
    ["1.5.0-rc.2", "1.5.0-rc.10", -1],
    ["1.5.0", "1.5.0-rc.10", 1],
    ["1.5.0-rc.10", "1.5.0", -1],
    ["1.5.0+build.1", "1.5.0+build.2", 0],
  ] as const)("uses SemVer precedence for %s vs %s", async (a, b, expected) => {
    const { compareSemver } = await import("../cli-discovery");
    expect(compareSemver(a, b)).toBe(expected);
  });

  // Review item 6 - `0.0.0-local` is the placeholder
  // `readBundledCliVersion()` returns when version.json is missing
  // (local dev builds). Before the fix `compareSemver("0.0.0-local",
  // "1.5.0")` returned 0 → cli-reconcile.ts derived `trusted-equal` and
  // silently skipped the upgrade. The sentinel must sort below any real
  // release version so newest-wins routes through the installed CLI.
  it("treats the 0.0.0-local sentinel as less than any real semver", async () => {
    const { compareSemver } = await import("../cli-discovery");
    expect(compareSemver("0.0.0-local", "1.5.0")).toBe(-1);
    expect(compareSemver("1.5.0", "0.0.0-local")).toBe(1);
    expect(compareSemver("0.0.0-local", "0.0.1")).toBe(-1);
    // Two sentinels still compare equal so we don't trigger spurious
    // upgrades against a freshly-built local CLI.
    expect(compareSemver("0.0.0-local", "0.0.0-local")).toBe(0);
    // The naked "0.0.0" (no suffix) is treated the same way - any
    // 0.0.0-prefixed string is a placeholder by convention.
    expect(compareSemver("0.0.0", "1.0.0")).toBe(-1);
  });
});
