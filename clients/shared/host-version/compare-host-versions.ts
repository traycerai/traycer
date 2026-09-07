// Single-authority SemVer comparator for the host registry's version domain (`install.json.version`, `staged.json.version`, manifest versions - see the Host Update Layer Redesign Tech Plan's "Version identity" section).
// Consumed by both the CLI (`clients/traycer-cli`) and desktop main (`clients/desktop`) so update/stage/promote decisions never diverge between the two processes.

export type VersionOrdering = "less" | "equal" | "greater";

export type VersionComparisonResult =
  | { readonly comparable: true; readonly ordering: VersionOrdering }
  | { readonly comparable: false };

interface ParsedSemver {
  // `compareNumericIdentifiers` below compares these with arbitrary precision instead, the same way pre-release identifiers are.
  readonly core: readonly [string, string, string];
  readonly pre: readonly string[];
}

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

  // SemVer's numeric-identifier grammar (spec §9 for the core triplet, §11 for numeric pre-release identifiers): "0" alone is valid, but any other numeric identifier with a leading zero ("01", "00") is not.
// `SEMVER_PATTERN` above only checks that a segment IS all-digits, not that it's leading-zero-free - this closes that gap.
function isLeadingZeroFree(digits: string): boolean {
  return digits === "0" || !digits.startsWith("0");
}

function parseSemver(value: string): ParsedSemver | null {
  // Reject anything that isn't a full SemVer triplet up front: a lenient Number.parseInt would otherwise smuggle malformed input through (e.g. "1.2.3abc" -> [1,2,3]) and skew the comparison.
  if (!SEMVER_PATTERN.test(value)) return null;
  const withoutBuild = value.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const coreText =
    dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const coreTextParts = coreText.split(".");
  if (coreTextParts.length !== 3 || !coreTextParts.every(isLeadingZeroFree)) {
    return null;
  }
  const preText = dashIndex === -1 ? "" : withoutBuild.slice(dashIndex + 1);
  const pre = preText === "" ? [] : preText.split(".");
  if (pre.some((id) => /^\d+$/.test(id) && !isLeadingZeroFree(id))) {
    return null;
  }
  return {
    core: [coreTextParts[0], coreTextParts[1], coreTextParts[2]],
    pre,
  };
}

// Compares two numeric pre-release identifiers with arbitrary precision.
function compareNumericIdentifiers(a: string, b: string): VersionOrdering {
  if (a.length !== b.length) return a.length > b.length ? "greater" : "less";
  if (a === b) return "equal";
  return a > b ? "greater" : "less";
}

function comparePreRelease(
  a: readonly string[],
  b: readonly string[],
): VersionOrdering {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return "less";
    if (i >= b.length) return "greater";
    const ai = a[i];
    const bi = b[i];
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const cmp = compareNumericIdentifiers(ai, bi);
      if (cmp !== "equal") return cmp;
    } else if (aNumeric) {
      return "less";
    } else if (bNumeric) {
      return "greater";
    } else if (ai !== bi) {
      return ai > bi ? "greater" : "less";
    }
  }
  return "equal";
}

export function compareHostVersions(
  a: string,
  b: string,
): VersionComparisonResult {
  const ap = parseSemver(a);
  const bp = parseSemver(b);
  if (ap === null || bp === null) return { comparable: false };
  for (let i = 0; i < 3; i++) {
    // Arbitrary-precision comparison, same as pre-release identifiers -
    // `parseSemver` already rejected leading zeros, so this is safe.
    const cmp = compareNumericIdentifiers(ap.core[i], bp.core[i]);
    if (cmp !== "equal") return { comparable: true, ordering: cmp };
  }
  // Equal core triplet: a version carrying a pre-release ranks below the
  // same version without one (1.0.0-rc.1 < 1.0.0).
  if (ap.pre.length === 0 && bp.pre.length === 0) {
    return { comparable: true, ordering: "equal" };
  }
  if (ap.pre.length === 0) return { comparable: true, ordering: "greater" };
  if (bp.pre.length === 0) return { comparable: true, ordering: "less" };
  return { comparable: true, ordering: comparePreRelease(ap.pre, bp.pre) };
}

// Convenience predicate for the common "is `candidate` strictly newer than `reference`" check used throughout the stage/promote/apply flows.
// Incomparable input is never "strictly newer" - callers that need to distinguish "not newer" from "can't tell" should call `compareHostVersions` directly instead.
export function isStrictlyNewerHostVersion(
  candidate: string,
  reference: string,
): boolean {
  const result = compareHostVersions(candidate, reference);
  return result.comparable && result.ordering === "greater";
}

// Standalone SemVer-parseability check, for callers that need to assert a single version string is well-formed rather than compare two.
// A malformed registry version is a data-integrity failure, not a legitimate "can't compare" outcome, so callers on that side should hard-fail on `false` rather than degrade to incomparable handling.
export function isValidHostVersion(value: string): boolean {
  return compareHostVersions(value, value).comparable;
}
