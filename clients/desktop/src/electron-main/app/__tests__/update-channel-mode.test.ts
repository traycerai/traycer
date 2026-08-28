import { describe, expect, it } from "vitest";
import {
  isSelectableCandidate,
  modeAllowsPrerelease,
  resolveUpdateChannelMode,
  type DesktopUpdateChannelMode,
} from "../update-channel-mode";

// The release-line vocabulary itself (canonical `X.Y.Z-rc.N` detection, line
// extraction, same-line equality) is owned and table-tested by
// `@traycer-clients/shared/host-version/release-line`. What is tested here is
// the Desktop policy layered on it: which mode a build runs in, which
// candidates that mode may select, and what a preference change may disturb.
// The version tables below still span the near-miss shapes, because the wiring
// that matters is that a `2.0.0-beta.1` build does NOT acquire implicit
// following.
describe("resolveUpdateChannelMode", () => {
  it.each([
    // Explicit preference OFF: the installed version decides.
    [false, "2.0.0", "stable-only"],
    [false, "2.0.0-rc.1", "implicit-rc-line"],
    [false, "2.0.0-rc.0", "implicit-rc-line"],
    // A prerelease that is not a canonical RC never acquires implicit
    // following - it falls back to the ordinary stable policy.
    [false, "2.0.0-beta.1", "stable-only"],
    [false, "2.0.0-rc.01", "stable-only"],
    [false, "1.0.0-test", "stable-only"],
    [false, "not-a-version", "stable-only"],
    [false, "", "stable-only"],
    // Explicit preference ON always wins: the opt-in is deliberately broader
    // than implicit following.
    [true, "2.0.0", "explicit-prerelease"],
    [true, "2.0.0-rc.1", "explicit-prerelease"],
    [true, "2.0.0-beta.1", "explicit-prerelease"],
    [true, "garbage", "explicit-prerelease"],
  ] as ReadonlyArray<readonly [boolean, string, DesktopUpdateChannelMode]>)(
    "explicit=%s installed=%s -> %s",
    (explicitPrerelease, installedVersion, expected) => {
      expect(
        resolveUpdateChannelMode(explicitPrerelease, installedVersion),
      ).toBe(expected);
    },
  );

  it("derives allowPrerelease for both non-stable modes", () => {
    expect(modeAllowsPrerelease("stable-only")).toBe(false);
    expect(modeAllowsPrerelease("implicit-rc-line")).toBe(true);
    expect(modeAllowsPrerelease("explicit-prerelease")).toBe(true);
  });

  it("returns to stable-only once the RC's own GA is what is installed", () => {
    // The termination guarantee, stated as a mode transition: an implicit
    // follower that takes its line's stable release relaunches as a stable
    // build, which derives stable-only with no preference change involved.
    expect(resolveUpdateChannelMode(false, "2.0.0-rc.3")).toBe(
      "implicit-rc-line",
    );
    expect(resolveUpdateChannelMode(false, "2.0.0")).toBe("stable-only");
  });
});

describe("isSelectableCandidate", () => {
  const installedVersion = "2.0.0-rc.1";

  it.each([
    // Same line, strictly newer: the two things implicit following may take.
    ["2.0.0-rc.2", true, true],
    ["2.0.0", true, true],
    // Same line but not newer (the installed build itself, or an older RC).
    ["2.0.0-rc.1", false, false],
    ["2.0.0-rc.0", false, false],
    // Newer, but on another line - the jump implicit following must never make,
    // at any version distance.
    ["2.1.0-rc.1", true, false],
    ["2.1.0", true, false],
    ["3.0.0-rc.1", true, false],
    // Newer, but names no release line at all.
    ["2.0.0-beta.9", true, false],
  ])(
    "implicit-rc-line: %s (newer=%s) -> %s",
    (candidateVersion, isStrictlyNewer, expected) => {
      expect(
        isSelectableCandidate({
          mode: "implicit-rc-line",
          installedVersion,
          candidateVersion,
          isStrictlyNewer,
        }),
      ).toBe(expected);
    },
  );

  it("keeps explicit opt-in broad: every candidate stays eligible", () => {
    for (const candidateVersion of ["2.1.0-rc.1", "3.0.0", "1.0.0"]) {
      expect(
        isSelectableCandidate({
          mode: "explicit-prerelease",
          installedVersion,
          candidateVersion,
          // Even a not-strictly-newer candidate stays eligible here: the
          // strictly-newer gate for the broad mode is electron-updater's, and
          // duplicating it would be a second answer to one question.
          isStrictlyNewer: false,
        }),
      ).toBe(true);
    }
  });
});

// A CHANGED PREFERENCE ALWAYS CHANGES THE MODE, which is what makes a
// "persisted moved, mode did not" branch unreachable and is why neither that
// branch nor a helper deciding it exists. Pinned here so the invariant
// `performChannelChange` relies on fails loudly if the derivation gains a mode
// both preference values can select.
describe("preference-to-mode invariant", () => {
  it.each([
    "2.0.0",
    "2.0.0-rc.1",
    "2.0.0-rc.0",
    "2.0.0-beta.1",
    "1.0.0-test",
    "not-a-version",
  ])("toggling the preference on %s crosses a mode boundary", (version) => {
    expect(resolveUpdateChannelMode(false, version)).not.toBe(
      resolveUpdateChannelMode(true, version),
    );
  });
});
