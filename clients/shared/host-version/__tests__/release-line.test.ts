import { describe, expect, it } from "vitest";
import {
  isCanonicalReleaseCandidate,
  isMatchingStableRelease,
  isPreReleaseVersion,
  isSameReleaseLine,
} from "../release-line";

/**
 * The whole updater rests on this predicate answering "no" for everything that
 * is not one of our release candidates. A false positive does not merely
 * mislabel a version - it silently enrols that install into automatic updates
 * it never asked for, so the negative table is the load-bearing half.
 */
describe("isCanonicalReleaseCandidate", () => {
  it("accepts canonical X.Y.Z-rc.N", () => {
    for (const version of [
      "2.0.0-rc.0",
      "2.0.0-rc.1",
      "2.0.0-rc.42",
      "0.0.1-rc.1",
      "10.20.30-rc.999",
    ]) {
      expect(isCanonicalReleaseCandidate(version)).toBe(true);
    }
  });

  it("rejects every other prerelease shape", () => {
    for (const version of [
      // Other prerelease words - the ones `includes("-")` cannot tell apart.
      "2.0.0-beta.1",
      "2.0.0-alpha",
      "2.0.0-alpha.1",
      "2.0.0-nightly.3",
      "2.0.0-test",
      "2.0.0-rc1",
      // `rc` with no ordinal, a non-numeric ordinal, or extra identifiers.
      "2.0.0-rc",
      "2.0.0-rc.x",
      "2.0.0-rc.1.2",
      "2.0.0-rc.1-hotfix",
      // Leading zeros are legal digits and illegal SemVer.
      "2.0.0-rc.01",
      "02.0.0-rc.1",
      // Build metadata: SemVer-valid, but no published RC of ours carries it.
      "2.0.0-rc.1+build.7",
      // Not a version at all - including the local-file install pin.
      "local-traycer-host-1730000000",
      "1.0.0-test",
      "2.0",
      "v2.0.0-rc.1",
      "",
      "  2.0.0-rc.1  ",
    ]) {
      expect(isCanonicalReleaseCandidate(version)).toBe(false);
    }
  });

  it("rejects a stable release - stable never follows a line implicitly", () => {
    expect(isCanonicalReleaseCandidate("2.0.0")).toBe(false);
  });

  it("scopes an RC to the line its core names", () => {
    // Asserted through the public surface: `2.3.4-rc.7` shares a line with the
    // `2.3.4` core and with nothing else, while `2.3.4-beta.7` has no line to
    // share at all.
    expect(isSameReleaseLine("2.3.4-rc.7", "2.3.4")).toBe(true);
    expect(isSameReleaseLine("2.3.4-rc.7", "2.3.5")).toBe(false);
    expect(isSameReleaseLine("2.3.4-beta.7", "2.3.4")).toBe(false);
  });
});

// Line membership itself is module-private (`hostReleaseLine`): callers ask
// these two questions, never "what line is this". Both halves of the rule are
// pinned here through them - which versions DO share a line, and which shapes
// have no line to share despite carrying the same core.
describe("release-line membership", () => {
  it("gives a canonical RC and its stable the same line", () => {
    expect(isSameReleaseLine("2.0.0-rc.1", "2.0.0")).toBe(true);
    expect(isSameReleaseLine("2.0.0", "2.0.0")).toBe(true);
    expect(isMatchingStableRelease("2.0.0", "2.0.0-rc.1")).toBe(true);
  });

  it("refuses a line for a non-canonical prerelease that shares the core", () => {
    // `2.0.0-beta.1` does have core `2.0.0`. Treating that as the 2.0.0 line
    // would let the beta follow the line's RCs and stable, which is exactly
    // what the canonical predicate exists to prevent - so it matches neither
    // the line's stable nor the line's other members.
    for (const version of [
      "2.0.0-beta.1",
      "2.0.0-rc.01",
      "local-traycer-host-1730000000",
      "2.0.0+build.4",
    ]) {
      expect(isSameReleaseLine(version, "2.0.0")).toBe(false);
      expect(isSameReleaseLine(version, "2.0.0-rc.1")).toBe(false);
      expect(isMatchingStableRelease("2.0.0", version)).toBe(false);
    }
  });

  it("is reflexive only for versions it can classify", () => {
    // The one asymmetry worth stating: a classifiable version shares a line
    // with itself, an unclassifiable one does not even do that.
    expect(isSameReleaseLine("2.0.0-rc.1", "2.0.0-rc.1")).toBe(true);
    expect(isSameReleaseLine("2.0.0-beta.1", "2.0.0-beta.1")).toBe(false);
  });
});

describe("isSameReleaseLine", () => {
  it("keeps an RC on its own line", () => {
    expect(isSameReleaseLine("2.0.0-rc.1", "2.0.0-rc.2")).toBe(true);
    expect(isSameReleaseLine("2.0.0-rc.1", "2.0.0")).toBe(true);
  });

  it("never crosses to another release line", () => {
    // The termination guarantee: implicit following can only ever end at the
    // stable for ITS line, so `2.1.0-rc.1` must be out of reach.
    expect(isSameReleaseLine("2.0.0-rc.1", "2.1.0-rc.1")).toBe(false);
    expect(isSameReleaseLine("2.0.0-rc.1", "2.0.1-rc.1")).toBe(false);
    expect(isSameReleaseLine("2.0.0-rc.1", "3.0.0")).toBe(false);
  });

  it("is never true for input it cannot classify", () => {
    expect(isSameReleaseLine("2.0.0-beta.1", "2.0.0")).toBe(false);
    expect(isSameReleaseLine("garbage", "garbage")).toBe(false);
  });
});

/**
 * The CATALOG predicate, and the one two processes must agree on to the letter:
 * the CLI filters `host available` rows with it, and Desktop's `HostController`
 * predicts that filter with it to decide whether a staged build would still
 * appear in the default listing. Disagreement is not cosmetic - a staged build
 * whose row goes missing reads as yanked and is purged.
 */
describe("isPreReleaseVersion", () => {
  it("accepts every pre-release shape, not just canonical RCs", () => {
    for (const version of [
      "2.0.0-rc.1",
      "2.0.0-rc.01",
      "2.0.0-beta.1",
      "2.0.0-alpha",
      "2.0.0-nightly.3",
      "2.0.0-test",
      "2.0.0-rc",
      "2.0.0-rc.1+build.7",
      "0.0.1-x",
      "10.20.30-anything.at.all",
    ]) {
      expect(isPreReleaseVersion(version)).toBe(true);
    }
  });

  it("rejects stable releases, including ones carrying build metadata", () => {
    // SemVer: build metadata is not a pre-release. `1.8.0+build.4` is a stable
    // release and must stay in the default catalog.
    for (const version of ["2.0.0", "0.0.0", "10.20.30", "1.8.0+build.4"]) {
      expect(isPreReleaseVersion(version)).toBe(false);
    }
  });

  it("rejects values that are not registry versions at all", () => {
    // The local-file install pin is the one a bare `includes("-")` used to
    // match; the anchored triplet does not, and it is not a catalog row anyway.
    for (const version of [
      "local-traycer-host-1730000000",
      "v2.0.0-rc.1",
      "2.0-rc.1",
      "not-a-version",
      "",
      "  2.0.0-rc.1  ",
    ]) {
      expect(isPreReleaseVersion(version)).toBe(false);
    }
  });

  it("stays strictly broader than the canonical predicate", () => {
    // The invariant that keeps the two questions apart: everything that may
    // follow a line is a pre-release, but not every pre-release may follow one.
    for (const version of ["2.0.0-rc.1", "2.0.0-beta.1", "2.0.0-rc.01"]) {
      expect(isPreReleaseVersion(version)).toBe(true);
    }
    expect(isCanonicalReleaseCandidate("2.0.0-beta.1")).toBe(false);
    expect(isCanonicalReleaseCandidate("2.0.0-rc.01")).toBe(false);
    expect(isCanonicalReleaseCandidate("2.0.0-rc.1")).toBe(true);
  });
});

describe("isMatchingStableRelease", () => {
  it("identifies the stable that terminates an RC's line", () => {
    expect(isMatchingStableRelease("2.0.0", "2.0.0-rc.1")).toBe(true);
  });

  it("rejects a later RC, another line's stable, and a non-canonical install", () => {
    expect(isMatchingStableRelease("2.0.0-rc.2", "2.0.0-rc.1")).toBe(false);
    expect(isMatchingStableRelease("2.1.0", "2.0.0-rc.1")).toBe(false);
    expect(isMatchingStableRelease("2.0.0", "2.0.0-beta.1")).toBe(false);
  });
});
