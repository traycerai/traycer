import { describe, expect, it } from "vitest";
import {
  requiresPreReleaseListing,
  resolveHostChannelMode,
  resolveHostStageTarget,
} from "../host-stage-policy";
import type { DesktopUpdateChannelMode } from "../../app/update-channel-mode";

describe("resolveHostChannelMode", () => {
  it.each([
    [false, "1.8.0", "stable-only"],
    [false, "2.0.0-rc.1", "implicit-rc-line"],
    [false, "2.0.0-rc.0", "implicit-rc-line"],
    // Not a canonical RC: no implicit following, whatever it calls itself.
    [false, "2.0.0-beta.1", "stable-only"],
    [false, "2.0.0-rc.01", "stable-only"],
    [false, "local-host-1730000000", "stable-only"],
    [true, "1.8.0", "explicit-prerelease"],
    [true, "2.0.0-rc.1", "explicit-prerelease"],
  ] as ReadonlyArray<readonly [boolean, string, DesktopUpdateChannelMode]>)(
    "explicit=%s installed=%s -> %s",
    (explicitPrerelease, installedVersion, expected) => {
      expect(
        resolveHostChannelMode({ explicitPrerelease, installedVersion }),
      ).toBe(expected);
    },
  );

  it("fails closed to stable-only when the install record is missing or unreadable", () => {
    // `readDesktopHostInstallRecord` answers null for absent, malformed, and
    // unreadable alike; none of them may switch a Host onto RC discovery.
    expect(
      resolveHostChannelMode({
        explicitPrerelease: false,
        installedVersion: null,
      }),
    ).toBe("stable-only");
  });

  it("still honors an explicit opt-in with no readable install record", () => {
    // The preference is the user's standing instruction rather than something
    // inferred from disk, so a corrupt record does not revoke it. The target
    // resolver separately refuses to pin anything without an installed version.
    expect(
      resolveHostChannelMode({
        explicitPrerelease: true,
        installedVersion: null,
      }),
    ).toBe("explicit-prerelease");
  });
});

// The catalog predicate itself is owned and table-tested by
// `@traycer-clients/shared/host-version/release-line` - the same definition the
// CLI's `filterHostAvailableVersions` consumes, so the two cannot drift. What
// is tested here is only how this module USES it.
describe("requiresPreReleaseListing", () => {
  it("asks for the pre-release view in both non-stable modes", () => {
    expect(
      requiresPreReleaseListing({
        mode: "implicit-rc-line",
        stagedVersion: null,
      }),
    ).toBe(true);
    expect(
      requiresPreReleaseListing({
        mode: "explicit-prerelease",
        stagedVersion: null,
      }),
    ).toBe(true);
  });

  it("stays stable-only for a stable-only Host with nothing staged", () => {
    expect(
      requiresPreReleaseListing({ mode: "stable-only", stagedVersion: null }),
    ).toBe(false);
    expect(
      requiresPreReleaseListing({
        mode: "stable-only",
        stagedVersion: "1.9.0",
      }),
    ).toBe(false);
  });

  it.each(["1.9.0-rc.1", "1.9.0-beta.1"])(
    "widens the query to revalidate a staged %s even in stable-only mode",
    (stagedVersion) => {
      // Query-only: the mode and the persisted preference are untouched, so an
      // RC staged before an opt-out is revalidated rather than purged, without
      // putting the Host back on RC selection.
      expect(
        requiresPreReleaseListing({ mode: "stable-only", stagedVersion }),
      ).toBe(true);
    },
  );
});

describe("resolveHostStageTarget", () => {
  const stableOnlyInput = {
    mode: "stable-only" as const,
    installedVersion: "1.8.0",
    availableVersions: ["1.8.0", "1.9.0", "2.0.0-rc.1"],
    stableLatest: "1.9.0",
  };

  it("never pins in stable-only mode - `--automatic` already follows latest", () => {
    expect(resolveHostStageTarget(stableOnlyInput)).toBeNull();
  });

  it("never pins without a readable installed version", () => {
    expect(
      resolveHostStageTarget({
        mode: "explicit-prerelease",
        installedVersion: null,
        availableVersions: ["2.0.0-rc.1"],
        stableLatest: "1.9.0",
      }),
    ).toBeNull();
  });

  describe("implicit-rc-line", () => {
    const installedVersion = "2.0.0-rc.1";

    function target(
      availableVersions: readonly string[],
      stableLatest: string | null,
    ): string | null {
      return resolveHostStageTarget({
        mode: "implicit-rc-line",
        installedVersion,
        availableVersions,
        stableLatest,
      });
    }

    it("pins the matching stable even when the manifest `latest` lags behind it", () => {
      // The plan's exact case: `2.0.0` is published, `latest` still says
      // `1.9.0`, and `--automatic` would fetch 1.9.0 - a DOWNGRADE for an RC
      // of the 2.0.0 line. The exact-version pin is what makes stable reachable.
      expect(target(["1.9.0", "2.0.0-rc.2", "2.0.0"], "1.9.0")).toBe("2.0.0");
    });

    it("prefers the matching stable over every later RC on the line", () => {
      expect(target(["2.0.0", "2.0.0-rc.9", "2.0.0-rc.2"], "2.0.0")).toBe(
        "2.0.0",
      );
    });

    it("falls back to the highest later RC on the line when stable is unpublished", () => {
      expect(target(["2.0.0-rc.2", "2.0.0-rc.10", "2.0.0-rc.3"], "1.9.0")).toBe(
        "2.0.0-rc.10",
      );
    });

    it.each([
      // Newer, but a different line - the jump implicit following never makes.
      [["2.1.0-rc.1"], "2.1.0-rc.1 (another RC line)"],
      [["2.1.0"], "2.1.0 (another line's stable)"],
      [["3.0.0"], "3.0.0 (a much newer line)"],
      [["2.0.1"], "2.0.1 (a patch line of its own)"],
      // Same line, but not newer.
      [["2.0.0-rc.1", "2.0.0-rc.0"], "only itself and an older RC"],
      // Right core, wrong prerelease grammar: not on the 2.0.0 line at all.
      [["2.0.0-beta.5"], "2.0.0-beta.5"],
    ] as ReadonlyArray<readonly [readonly string[], string]>)(
      "does not pin %s",
      (availableVersions) => {
        expect(target(availableVersions, "1.9.0")).toBeNull();
      },
    );

    it("ignores a yanked/unavailable stable, since the caller filtered it out", () => {
      // `availableVersions` is already the installable set: a withdrawn 2.0.0
      // is simply absent, and the highest usable later RC takes over.
      expect(target(["2.0.0-rc.2", "2.0.0-rc.3"], "1.9.0")).toBe("2.0.0-rc.3");
    });
  });

  describe("explicit-prerelease", () => {
    function target(
      installedVersion: string,
      availableVersions: readonly string[],
      stableLatest: string | null,
    ): string | null {
      return resolveHostStageTarget({
        mode: "explicit-prerelease",
        installedVersion,
        availableVersions,
        stableLatest,
      });
    }

    it("stays broad: pins the newest pre-release across release lines", () => {
      expect(target("2.0.0-rc.1", ["2.0.0", "2.1.0-rc.1"], "2.0.0")).toBe(
        "2.1.0-rc.1",
      );
    });

    it("defers to `--automatic` when the newest listed build is the stable latest", () => {
      expect(target("1.8.0", ["1.8.0", "1.9.0"], "1.9.0")).toBeNull();
    });

    it("defers to `--automatic` when the newest RC does not beat the stable latest", () => {
      expect(target("1.8.0", ["1.9.0-rc.1", "1.9.0"], "1.9.0")).toBeNull();
    });

    it("never downgrades to an older pre-release", () => {
      expect(target("2.0.0", ["1.9.0-rc.1"], "1.8.0")).toBeNull();
    });

    it("never downgrades onto an incomparable installed version", () => {
      expect(target("local-host-1730000000", ["2.0.0-rc.1"], null)).toBeNull();
    });
  });
});
