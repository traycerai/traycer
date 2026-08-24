// Canonical release-candidate identity for the host/app update domain.
//
// The RC-to-stable updater lets an installed release candidate follow its OWN
// release line without any saved preference: `2.0.0-rc.1` may select
// `2.0.0-rc.2` or stable `2.0.0`, and nothing else. Two decisions hang off
// this file, in both the CLI and desktop main, so they must not diverge:
//
//   1. Does the installed version activate implicit following at all?
//   2. Is a candidate on the SAME release line as the installed version?
//
// `includes("-")` cannot answer either one. Only a CANONICAL release
// candidate activates implicit following: valid SemVer whose core is exactly
// `X.Y.Z` and whose pre-release is exactly `rc.<non-negative integer>`.
// `beta`, `alpha`, `nightly`, `test`, arbitrary hyphenated strings, the
// `local-<basename>-<timestamp>` pin a local-file install records, and
// malformed versions all fail closed to stable-only discovery — which is the
// conservative answer, since a stable-only user never receives an RC
// automatically.
//
// Build metadata (`+…`) is deliberately NOT accepted on a canonical RC.
// SemVer ignores it for precedence, but no published Traycer RC carries it,
// so a version that does is not one of ours to follow; refusing it fails
// closed rather than opening implicit following to an unknown build.
//
// A THIRD, BROADER question also lives here — `isPreReleaseVersion`, "is this
// version a pre-release at all", which the `host available` catalog filter
// asks and which legitimately covers every pre-release shape. It shares this
// file so the contrast is impossible to miss, and it must stay a SEPARATE
// export: widening canonical RC detection to answer it would silently let
// `2.0.0-beta.1` start following a release line, and narrowing it to the
// canonical predicate would make the catalog filter and the Desktop
// staged-artifact revalidation disagree about which rows the default listing
// returns — which purges a perfectly good staged `2.0.0-beta.1`.

import { isValidHostVersion } from "./compare-host-versions";

/**
 * A version's `X.Y.Z` core — the identity an implicit follow is scoped to.
 *
 * Module-private, like {@link hostReleaseLine} below: no caller outside this
 * file has ever needed a line in the hand. They ask questions ABOUT lines —
 * "same line?", "is this the stable that ends this line?" — and those are the
 * exported surface.
 */
type HostReleaseLine = string;

const CANONICAL_RC_PATTERN = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/;
const STABLE_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * The release line of a canonical `X.Y.Z-rc.N`, or `null` for every other
 * shape.
 *
 * Module-private, and the RC ordinal it matches is deliberately discarded.
 * Nothing needs it: ordering two RCs on one line is `compareHostVersions`'s
 * job (it handles arbitrary-precision numeric identifiers, which a caller
 * comparing ordinals by hand would get wrong past 2^53), and identity is the
 * full version string. An exported ordinal would be an invitation to order by
 * it.
 *
 * `isValidHostVersion` runs alongside the pattern rather than being replaced
 * by it: the pattern proves the SHAPE, the validator proves the SemVer
 * grammar the shape does not encode — notably leading zeros, which are legal
 * digit strings (`1.02.0`, `1.0.0-rc.01`) and illegal SemVer.
 */
function canonicalReleaseCandidateLine(
  version: string,
): HostReleaseLine | null {
  const match = CANONICAL_RC_PATTERN.exec(version);
  if (match === null) return null;
  if (!isValidHostVersion(version)) return null;
  return match[1];
}

/** Whether `version` activates implicit same-line following. */
export function isCanonicalReleaseCandidate(version: string): boolean {
  return canonicalReleaseCandidateLine(version) !== null;
}

/**
 * THE BROAD one: would the default `host available` catalog hide this version
 * behind `--include-pre-releases`?
 *
 * Deliberately not {@link isCanonicalReleaseCandidate}, and the two are not
 * interchangeable in either direction. This one answers a CATALOG question and
 * covers every pre-release shape — `rc`, `beta`, `alpha`, `nightly`, a
 * leading-zero `-rc.01`, anything after the `-`. The canonical predicate
 * answers a POLICY question ("may this build follow a release line") and is
 * narrow on purpose.
 *
 * Two processes ask this, which is why it is here rather than in either of
 * them: the CLI's `filterHostAvailableVersions` decides which rows to return,
 * and Desktop's `HostController` has to PREDICT that decision — a staged build
 * whose row is missing from the listing reads as yanked and gets purged. A
 * second copy in either place is a purge waiting for the day the two spellings
 * diverge.
 *
 * Anchored on a full `X.Y.Z-` triplet rather than a bare `includes("-")`: the
 * substring test also matched the `local-<basename>-<timestamp>` version a
 * local-file install records, which is not a registry row at all. Build
 * metadata alone (`1.8.0+build.4`) is not a pre-release, per SemVer.
 */
export function isPreReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/**
 * The release line a version belongs to, for the versions implicit following
 * can reason about: a canonical RC and the stable release it leads to share
 * one line, which is what makes `2.0.0` the terminating candidate for
 * `2.0.0-rc.1`.
 *
 * Every other pre-release shape returns `null` rather than its bare core. A
 * `2.0.0-beta.1` DOES have core `2.0.0`, but treating that as "the 2.0.0
 * line" would let the beta follow the line's RCs and stable — exactly the
 * broadening the canonical predicate exists to prevent.
 *
 * MODULE-PRIVATE. It was exported for a caller that never materialized: every
 * consumer across the CLI, Desktop main, and the GUI asks `isSameReleaseLine`
 * or `isMatchingStableRelease` instead. Keeping it public would publish a bare
 * string whose only correct use is equality against another line from this same
 * function — an invitation to compare cores by hand, which is how
 * `2.0.0-beta.1` ends up on the `2.0.0` line. Export it again only alongside a
 * real caller that genuinely needs to tell "different line" from "cannot
 * classify".
 */
function hostReleaseLine(version: string): HostReleaseLine | null {
  const canonical = canonicalReleaseCandidateLine(version);
  if (canonical !== null) return canonical;
  if (!STABLE_PATTERN.test(version)) return null;
  if (!isValidHostVersion(version)) return null;
  return version;
}

/**
 * Whether two versions sit on one release line. Incomparable or non-canonical
 * input is never "same line", which fails closed: a version this module cannot
 * classify never joins anyone's line.
 *
 * That does collapse "different line" and "cannot classify" into one `false`.
 * No caller has needed to tell them apart — both mean "not a candidate for this
 * install" at every call site — and the pair is far easier to get wrong than to
 * use, so the distinction stays unexported until something genuinely needs it.
 */
export function isSameReleaseLine(a: string, b: string): boolean {
  const lineA = hostReleaseLine(a);
  if (lineA === null) return false;
  return lineA === hostReleaseLine(b);
}

/**
 * Whether `candidate` is the stable release that terminates `installedRc`'s
 * line — the candidate implicit following must prefer over every later RC on
 * that line, since it is what ends implicit participation.
 *
 * Exported ahead of its caller, deliberately. `HostController`'s candidate
 * resolver (the generalization of `resolveRcDownloadTarget`) has to answer
 * exactly this question to pin matching stable with `host download <version>`
 * even when the registry's `latest` pointer still lags on the stable channel —
 * installed `2.0.0-rc.1` must take published `2.0.0` while `latest` says
 * `1.9.0`. That resolver is a Desktop-side consumer, so it cannot own the
 * predicate: this module is the single definition both processes read, and a
 * second copy over there is precisely the RC-detection drift this file exists
 * to prevent. `isSameReleaseLine` alone is not enough — it cannot express
 * "prefer the stable one", which is what guarantees the follow terminates.
 */
export function isMatchingStableRelease(
  candidate: string,
  installedRc: string,
): boolean {
  const line = canonicalReleaseCandidateLine(installedRc);
  if (line === null) return false;
  return STABLE_PATTERN.test(candidate) && candidate === line;
}
