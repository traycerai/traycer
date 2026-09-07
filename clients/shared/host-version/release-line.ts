// Canonical release-candidate identity for the host/app update domain.
// The RC-to-stable updater lets an installed release candidate follow its own release line without any saved preference: `2.0.0-rc.1` may select `2.0.0-rc.2` or stable `2.0.0`, and nothing else.

import { isValidHostVersion } from "./compare-host-versions";

type HostReleaseLine = string;

const CANONICAL_RC_PATTERN = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/;
const STABLE_PATTERN = /^\d+\.\d+\.\d+$/;

function canonicalReleaseCandidateLine(
  version: string,
): HostReleaseLine | null {
  const match = CANONICAL_RC_PATTERN.exec(version);
  if (match === null) return null;
  if (!isValidHostVersion(version)) return null;
  return match[1];
}

export function isCanonicalReleaseCandidate(version: string): boolean {
  return canonicalReleaseCandidateLine(version) !== null;
}

/**
 * The broad one: would the default `host available` catalog hide this version behind `--include-pre-releases`?
 * This one answers a catalog question and covers every pre-release shape - `rc`, `beta`, `alpha`, `nightly`, a leading-zero `-rc.01`, anything after the `-`.
 */
export function isPreReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/**
 * Every other pre-release shape returns `null` rather than its bare core.
 * It was exported for a caller that never materialized: every consumer across the CLI, Desktop main, and the gui asks `isSameReleaseLine` or `isMatchingStableRelease` instead.
 */
function hostReleaseLine(version: string): HostReleaseLine | null {
  const canonical = canonicalReleaseCandidateLine(version);
  if (canonical !== null) return canonical;
  if (!STABLE_PATTERN.test(version)) return null;
  if (!isValidHostVersion(version)) return null;
  return version;
}

/**
 * Whether two versions sit on one release line.
 * Incomparable or non-canonical input is never "same line", which fails closed: a version this module cannot classify never joins anyone's line.
 */
export function isSameReleaseLine(a: string, b: string): boolean {
  const lineA = hostReleaseLine(a);
  if (lineA === null) return false;
  return lineA === hostReleaseLine(b);
}

/**
 * Whether `candidate` is the stable release that terminates `installedRc`'s line - the candidate implicit following must prefer over every later RC on that line, since it is what ends implicit participation.
 * `isSameReleaseLine` alone is not enough - it cannot express "prefer the stable one", which is what guarantees the follow terminates.
 */
export function isMatchingStableRelease(
  candidate: string,
  installedRc: string,
): boolean {
  const line = canonicalReleaseCandidateLine(installedRc);
  if (line === null) return false;
  return STABLE_PATTERN.test(candidate) && candidate === line;
}
