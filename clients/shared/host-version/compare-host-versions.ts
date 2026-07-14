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
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value: string): ParsedSemver | null {
  // Reject anything that isn't a full SemVer triplet up front: a lenient
  // Number.parseInt would otherwise smuggle malformed input through (e.g.
  // "1.2.3abc" -> [1,2,3]) and skew the comparison.
  if (!SEMVER_PATTERN.test(value)) return null;
  const withoutBuild = value.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const coreText =
    dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const coreParts = coreText
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (coreParts.length !== 3 || coreParts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const preText = dashIndex === -1 ? "" : withoutBuild.slice(dashIndex + 1);
  return {
    core: [coreParts[0], coreParts[1], coreParts[2]],
    pre: preText === "" ? [] : preText.split("."),
  };
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
      const an = Number.parseInt(ai, 10);
      const bn = Number.parseInt(bi, 10);
      if (an !== bn) return an > bn ? "greater" : "less";
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
    if (ap.core[i] !== bp.core[i]) {
      return {
        comparable: true,
        ordering: ap.core[i] > bp.core[i] ? "greater" : "less",
      };
    }
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
