// Single-authority SemVer comparator for the host registry's version
// domain (`install.json.version`, `staged.json.version`, manifest
// versions - see the Host Update Layer Redesign Tech Plan's "Version
// identity" section). Consumed by both the CLI (`clients/traycer-cli`)
// and desktop main (`clients/desktop`) so update/stage/promote decisions
// never diverge between the two processes.
//
// Full SemVer precedence (spec §11), pre-release included:
// `1.0.0-rc.1 < 1.0.0` - unlike a "trust the newer CLI binary" comparator,
// the host update decision needs a release candidate to always upgrade to
// its GA. Build metadata (`+...`) is ignored per spec.
//
// Unlike a plain `-1|0|1` comparator, malformed/non-SemVer input (e.g. a
// `local-<basename>-<timestamp>` version recorded by a local-file install)
// produces an explicit `{ comparable: false }` result instead of silently
// collapsing to "equal". Callers decide what "can't compare" means for
// their flow (skip, refuse, or proceed) - see the Tech Plan's "Incomparable
// registry versions" section.

export type VersionOrdering = "less" | "equal" | "greater";

export type VersionComparisonResult =
  | { readonly comparable: true; readonly ordering: VersionOrdering }
  | { readonly comparable: false };

interface ParsedSemver {
  // Kept as digit strings, not `number` - the core triplet has no upper
  // bound in the SemVer grammar (`\d+`), and `Number.parseInt` silently
  // loses precision past 2^53 (two distinct huge core versions could
  // compare equal) or overflows to `Infinity` for very long digit strings
  // (a validly-formed 400-digit component would be wrongly rejected as
  // non-finite). `compareNumericIdentifiers` below compares these with
  // arbitrary precision instead, the same way pre-release identifiers are.
  readonly core: readonly [string, string, string];
  readonly pre: readonly string[];
}

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// SemVer's numeric-identifier grammar (spec §9 for the core triplet,
// §11 for numeric pre-release identifiers): "0" alone is valid, but any
// other numeric identifier with a leading zero ("01", "00") is not.
// `SEMVER_PATTERN` above only checks that a segment IS all-digits, not
// that it's leading-zero-free - this closes that gap.
function isLeadingZeroFree(digits: string): boolean {
  return digits === "0" || !digits.startsWith("0");
}

function parseSemver(value: string): ParsedSemver | null {
  // Reject anything that isn't a full SemVer triplet up front: a lenient
  // Number.parseInt would otherwise smuggle malformed input through (e.g.
  // "1.2.3abc" -> [1,2,3]) and skew the comparison.
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
  // A purely-numeric pre-release identifier is subject to the same
  // leading-zero rule as the core triplet; an alphanumeric identifier
  // that merely starts with a digit (e.g. "1a", "01a") is a different
  // grammar production and is exempt.
  if (pre.some((id) => /^\d+$/.test(id) && !isLeadingZeroFree(id))) {
    return null;
  }
  return {
    core: [coreTextParts[0], coreTextParts[1], coreTextParts[2]],
    pre,
  };
}

// Compares two numeric pre-release identifiers with arbitrary precision.
// `parseSemver` has already rejected leading zeros, so a longer digit
// string is always numerically larger and equal-length digit strings
// compare lexicographically (ASCII digit order matches numeric order) -
// this avoids `Number.parseInt`, which silently loses precision past
// 2^53 and could misorder two very large identifiers.
function compareNumericIdentifiers(a: string, b: string): VersionOrdering {
  if (a.length !== b.length) return a.length > b.length ? "greater" : "less";
  if (a === b) return "equal";
  return a > b ? "greater" : "less";
}

// Compares two non-empty dot-separated pre-release identifier lists per
// SemVer §11: numeric identifiers compare numerically and rank below
// alphanumeric ones, alphanumeric identifiers compare in ASCII order, and a
// longer list outranks a shorter one when all preceding identifiers match.
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

// Convenience predicate for the common "is `candidate` strictly newer than
// `reference`" check used throughout the stage/promote/apply flows.
// Incomparable input is never "strictly newer" - callers that need to
// distinguish "not newer" from "can't tell" should call
// `compareHostVersions` directly instead.
export function isStrictlyNewerHostVersion(
  candidate: string,
  reference: string,
): boolean {
  const result = compareHostVersions(candidate, reference);
  return result.comparable && result.ordering === "greater";
}

// Standalone SemVer-parseability check, for callers that need to assert
// a single version string is well-formed rather than compare two. The
// registry side of the version domain (manifest entries, resolved
// download targets, staged-sidecar versions) must always be valid
// SemVer per the Tech Plan - incomparability is a policy reserved for
// the INSTALLED side only (e.g. a `local-*` pin). A malformed registry
// version is a data-integrity failure, not a legitimate "can't compare"
// outcome, so callers on that side should hard-fail on `false` rather
// than degrade to incomparable handling.
export function isValidHostVersion(value: string): boolean {
  return compareHostVersions(value, value).comparable;
}
