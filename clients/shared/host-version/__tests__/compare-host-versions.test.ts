import { describe, expect, it } from "vitest";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
  isValidHostVersion,
} from "../compare-host-versions";

describe("compareHostVersions", () => {
  it("orders ordinary triplets", () => {
    expect(compareHostVersions("2.0.0", "1.9.9")).toEqual({
      comparable: true,
      ordering: "greater",
    });
    expect(compareHostVersions("1.5.0", "1.5.1")).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions("1.5.0", "1.5.0")).toEqual({
      comparable: true,
      ordering: "equal",
    });
    expect(compareHostVersions("1.10.0", "1.9.0")).toEqual({
      comparable: true,
      ordering: "greater",
    });
  });

  it("orders a pre-release below its GA (1.0.0-rc.1 < 1.0.0)", () => {
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0")).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions("1.0.0", "1.0.0-rc.1")).toEqual({
      comparable: true,
      ordering: "greater",
    });
  });

  it("orders pre-releases against each other by SemVer §11", () => {
    // beta < rc (ASCII), rc.1 < rc.2, and numeric fields compare
    // numerically (beta.2 < beta.11) rather than lexically.
    expect(compareHostVersions("1.0.0-beta.3", "1.0.0-rc.1")).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0-rc.2")).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions("1.0.0-beta.2", "1.0.0-beta.11")).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions("1.0.0-rc.1", "1.0.0-rc.1")).toEqual({
      comparable: true,
      ordering: "equal",
    });
    // A longer identifier list outranks its prefix (alpha < alpha.1).
    expect(compareHostVersions("1.0.0-alpha", "1.0.0-alpha.1")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });

  it("does not advertise a downgrade when installed is newer than latest", () => {
    expect(compareHostVersions("0.0.3", "0.0.2")).toEqual({
      comparable: true,
      ordering: "greater",
    });
    expect(compareHostVersions("1.2.0", "1.2.0-rc.5")).toEqual({
      comparable: true,
      ordering: "greater",
    });
  });

  it("ignores build metadata", () => {
    expect(compareHostVersions("1.0.0+abc", "1.0.0+def")).toEqual({
      comparable: true,
      ordering: "equal",
    });
    expect(compareHostVersions("1.0.0-rc.1+build", "1.0.0")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });

  // The whole point of this module over the legacy number-returning
  // comparator it replaces: unparseable input is explicitly incomparable,
  // not silently "equal" - callers decide what that means (skip an
  // automatic stage, or proceed on an explicit user action).
  it("returns comparable:false for unparseable input instead of collapsing to equal", () => {
    expect(compareHostVersions("not-a-version", "1.0.0")).toEqual({
      comparable: false,
    });
    expect(compareHostVersions("1.0.0", "")).toEqual({ comparable: false });
    expect(compareHostVersions("1.0", "1.0.0")).toEqual({
      comparable: false,
    });
    // Malformed input is rejected rather than smuggled through by a lenient
    // Number.parseInt ("1.2.3abc" -> [1,2,3]).
    expect(compareHostVersions("1.2.3abc", "1.2.4")).toEqual({
      comparable: false,
    });
    expect(compareHostVersions("1.0.0 ", "1.0.1")).toEqual({
      comparable: false,
    });
  });

  it("treats a local-file install version as incomparable against registry SemVer", () => {
    // Shape produced by the CLI's `deriveLocalVersion` for `--from` installs.
    expect(
      compareHostVersions(
        "local-traycer-host-2026-01-01T00-00-00-000Z",
        "1.5.0",
      ),
    ).toEqual({ comparable: false });
  });

  it("rejects a leading zero in a core version component", () => {
    expect(compareHostVersions("01.2.3", "1.2.3")).toEqual({
      comparable: false,
    });
    expect(compareHostVersions("1.02.3", "1.2.3")).toEqual({
      comparable: false,
    });
    expect(compareHostVersions("1.2.03", "1.2.3")).toEqual({
      comparable: false,
    });
    // "0" alone is a valid numeric identifier - only a leading zero
    // BEFORE another digit is rejected.
    expect(compareHostVersions("0.0.0", "0.0.1")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });

  it("rejects a leading zero in a numeric pre-release identifier", () => {
    expect(compareHostVersions("1.0.0-01", "1.0.0-1")).toEqual({
      comparable: false,
    });
    // An alphanumeric identifier that merely starts with a digit is a
    // different grammar production and is not subject to this rule.
    expect(compareHostVersions("1.0.0-01a", "1.0.0-02a")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });

  it("compares numeric pre-release identifiers with arbitrary precision, not double-precision float", () => {
    // 2^53 and 2^53+1 - a genuine `Number`/`Number.parseInt` collision (see
    // the core-triplet test below for why this exact pair, not an
    // arbitrary huge/huger pair, is what actually pins the invariant).
    const huge = "9007199254740992";
    const huger = "9007199254740993";
    expect(compareHostVersions(`1.0.0-${huge}`, `1.0.0-${huger}`)).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions(`1.0.0-${huge}`, `1.0.0-${huge}`)).toEqual({
      comparable: true,
      ordering: "equal",
    });
    // A longer digit string (no leading zero) is always numerically
    // larger - exercises the digit-length branch directly.
    expect(compareHostVersions("1.0.0-9", "1.0.0-10")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });

  it("compares core-triplet components with arbitrary precision too, not just pre-release", () => {
    // 2^53 and 2^53+1 - a genuine `Number`/`Number.parseInt` collision
    // (IEEE-754 doubles can't represent odd integers past 2^53, so
    // `Number("9007199254740993")` rounds DOWN to the same value as
    // `Number("9007199254740992")`). A prior version of this test used a
    // non-colliding pair (…993/…994, which round to distinct doubles) -
    // a flawed Number-based comparator would have passed it anyway.
    const huge = "9007199254740992";
    const huger = "9007199254740993";
    expect(compareHostVersions(`${huge}.0.0`, `${huger}.0.0`)).toEqual({
      comparable: true,
      ordering: "less",
    });
    expect(compareHostVersions(`${huge}.0.0`, `${huge}.0.0`)).toEqual({
      comparable: true,
      ordering: "equal",
    });
    // A 400-digit core component overflows `Number.parseInt` to `Infinity`
    // and would be wrongly rejected as unparseable; it's still a valid,
    // comparable SemVer core per the grammar's unbounded `\d+`.
    const longDigits = "1".repeat(400);
    expect(
      compareHostVersions(`${longDigits}.0.0`, `${longDigits}.0.0`),
    ).toEqual({ comparable: true, ordering: "equal" });
    expect(compareHostVersions(`${longDigits}.0.0`, "1.0.0")).toEqual({
      comparable: true,
      ordering: "greater",
    });
    // A longer digit string (no leading zero) is always numerically larger
    // - exercises the digit-length branch directly on the core, not just
    // pre-release.
    expect(compareHostVersions("9.0.0", "10.0.0")).toEqual({
      comparable: true,
      ordering: "less",
    });
  });
});

describe("isValidHostVersion", () => {
  it("is true for well-formed SemVer, including pre-release and build metadata", () => {
    expect(isValidHostVersion("1.5.0")).toBe(true);
    expect(isValidHostVersion("1.0.0-rc.1")).toBe(true);
    expect(isValidHostVersion("1.0.0-rc.1+build")).toBe(true);
    expect(isValidHostVersion("0.0.0")).toBe(true);
  });

  it("is false for malformed or non-SemVer input", () => {
    expect(isValidHostVersion("v1.0.0")).toBe(false);
    expect(isValidHostVersion("1.0")).toBe(false);
    expect(isValidHostVersion("01.0.0")).toBe(false);
    expect(isValidHostVersion("local-abc-2026")).toBe(false);
    expect(isValidHostVersion("")).toBe(false);
  });
});

describe("isStrictlyNewerHostVersion", () => {
  it("is true only when comparable and strictly greater", () => {
    expect(isStrictlyNewerHostVersion("1.5.1", "1.5.0")).toBe(true);
    expect(isStrictlyNewerHostVersion("1.5.0", "1.5.0")).toBe(false);
    expect(isStrictlyNewerHostVersion("1.4.9", "1.5.0")).toBe(false);
  });

  it("is false for incomparable input, never a false positive", () => {
    expect(isStrictlyNewerHostVersion("local-abc", "1.5.0")).toBe(false);
    expect(isStrictlyNewerHostVersion("1.5.0", "local-abc")).toBe(false);
  });
});
