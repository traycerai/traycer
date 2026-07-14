import { describe, expect, it } from "vitest";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
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
