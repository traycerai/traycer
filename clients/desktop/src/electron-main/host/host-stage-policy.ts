/**
 * WHICH HOST VERSION BACKGROUND STAGING SHOULD FETCH, as pure functions.
 *
 * `HostController.reconcileEligibleStage` is orchestration - locks, lanes,
 * fingerprints, purge choreography - and the policy questions buried in it are
 * three small ones that deserve to be answered where they can be table-tested
 * without a controller, a filesystem, or a spawned CLI:
 *
 *   1. Which channel mode is this Host install on?
 *   2. Does the registry listing need to include pre-releases?
 *   3. Which exact version should be downloaded, if not `--automatic`?
 *
 * THE MODE MODEL IS THE DESKTOP APP'S, deliberately reused rather than
 * re-declared: the plan applies one three-mode model to both updater domains,
 * and the only difference is which installed version feeds it - the packaged
 * app version there, the Host install record here. Two enums with the same
 * three members would be two things to keep in step for no benefit.
 *
 * NOTHING HERE RE-DECLARES A VERSION PREDICATE. The controller has to predict
 * which rows `host available` will return - a staged build whose row is missing
 * reads as yanked and gets purged - and that prediction is only safe while both
 * processes read ONE definition, so `isPreReleaseVersion` comes from
 * `@traycer-clients/shared/host-version/release-line`, which the CLI's own
 * catalog filter now consumes too.
 */
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import {
  isMatchingStableRelease,
  isPreReleaseVersion,
  isSameReleaseLine,
} from "@traycer-clients/shared/host-version/release-line";
import {
  modeAllowsPrerelease,
  resolveUpdateChannelMode,
  type DesktopUpdateChannelMode,
} from "../app/update-channel-mode";

/**
 * The mode this Host install is on.
 *
 * FAILS CLOSED on a missing, malformed, or unreadable install record:
 * `readDesktopHostInstallRecord` answers `null` for all three, and a Host whose
 * version cannot be established never activates implicit RC following. The
 * explicit preference still applies, because that one is the user's own
 * standing instruction rather than something inferred from disk.
 */
export function resolveHostChannelMode(input: {
  readonly explicitPrerelease: boolean;
  readonly installedVersion: string | null;
}): DesktopUpdateChannelMode {
  if (input.installedVersion === null) {
    return input.explicitPrerelease ? "explicit-prerelease" : "stable-only";
  }
  return resolveUpdateChannelMode(
    input.explicitPrerelease,
    input.installedVersion,
  );
}

/**
 * Whether `host available` must be asked for the pre-release view.
 *
 * Two independent reasons, and the second is NOT a mode:
 *
 *   - the mode allows pre-releases (implicit following or an explicit opt-in);
 *   - a pre-release is ALREADY STAGED. Its row has to be in the listing for
 *     `stageIsEligible` to revalidate it; asked stable-only, the row is absent,
 *     the stage reads as yanked, and a perfectly good verified artifact is
 *     purged. This widens the QUERY only - it changes neither the selection
 *     mode nor the persisted preference, so an RC staged before an opt-out is
 *     revalidated without silently putting the user back on prereleases.
 */
export function requiresPreReleaseListing(input: {
  readonly mode: DesktopUpdateChannelMode;
  readonly stagedVersion: string | null;
}): boolean {
  if (modeAllowsPrerelease(input.mode)) {
    return true;
  }
  return (
    input.stagedVersion !== null && isPreReleaseVersion(input.stagedVersion)
  );
}

/**
 * The exact version to pin with `host download <version>`, or null to use the
 * ordinary `host download --automatic` (which follows the manifest's stable
 * `latest` pointer).
 *
 * `availableVersions` is the listing already filtered to installable rows, so
 * yanked and platform-unavailable builds are gone before any policy runs here.
 *
 *   - `stable-only`: null. The stable pointer is exactly the right answer and
 *     `--automatic` already follows it.
 *   - `implicit-rc-line`: the installed RC's OWN line only - its matching
 *     stable first, otherwise the highest later RC on that line.
 *   - `explicit-prerelease`: unchanged broad behavior - the newest available
 *     pre-release, but only when it beats both the installed build and the
 *     stable `latest` (otherwise `--automatic` is already fetching the better
 *     one).
 *
 * `latest` IS NOT THE CANDIDATE SOURCE. RC releases never move that pointer,
 * and a line's stable can be published while it still names an older release -
 * so installed `2.0.0-rc.1` must pin `2.0.0` even while `latest` reads
 * `1.9.0`. Nothing here reads or changes `latest` semantics; `stableLatest` is
 * consulted only to avoid pinning a version `--automatic` would beat anyway.
 */
export function resolveHostStageTarget(input: {
  readonly mode: DesktopUpdateChannelMode;
  readonly installedVersion: string | null;
  readonly availableVersions: readonly string[];
  readonly stableLatest: string | null;
}): string | null {
  const installedVersion = input.installedVersion;
  if (installedVersion === null || input.mode === "stable-only") {
    return null;
  }
  if (input.mode === "implicit-rc-line") {
    return resolveSameLineTarget(installedVersion, input.availableVersions);
  }
  return resolveBroadPreReleaseTarget(
    installedVersion,
    input.availableVersions,
    input.stableLatest,
  );
}

/**
 * MATCHING STABLE WINS OUTRIGHT over every later RC on the line, and that
 * priority is what makes implicit following terminate: taking `2.0.0` leaves
 * the next launch a stable install, which derives `stable-only` with no
 * preference to undo.
 *
 * No downgrade guard is needed on the stable arm - SemVer puts `X.Y.Z` above
 * every `X.Y.Z-rc.N`, and `isMatchingStableRelease` only answers true when the
 * installed version is a canonical RC of that exact line. The RC arm keeps its
 * `isStrictlyNewerHostVersion` filter, which also drops the installed build
 * itself and anything incomparable.
 */
function resolveSameLineTarget(
  installedVersion: string,
  availableVersions: readonly string[],
): string | null {
  const matchingStable = availableVersions.find((version) =>
    isMatchingStableRelease(version, installedVersion),
  );
  if (matchingStable !== undefined) {
    return matchingStable;
  }
  const laterOnLine = availableVersions.filter(
    (version) =>
      isSameReleaseLine(installedVersion, version) &&
      isStrictlyNewerHostVersion(version, installedVersion),
  );
  if (laterOnLine.length === 0) {
    return null;
  }
  return laterOnLine.reduce((newest, version) =>
    isStrictlyNewerHostVersion(version, newest) ? version : newest,
  );
}

function resolveBroadPreReleaseTarget(
  installedVersion: string,
  availableVersions: readonly string[],
  stableLatest: string | null,
): string | null {
  const newest = newestVersion(availableVersions);
  if (newest === null || !isPreReleaseVersion(newest)) {
    return null;
  }
  if (!isStrictlyNewerHostVersion(newest, installedVersion)) {
    return null;
  }
  if (
    stableLatest !== null &&
    !isStrictlyNewerHostVersion(newest, stableLatest)
  ) {
    return null;
  }
  return newest;
}

// Newest listed version INCLUDING pre-releases, unlike the manifest's stable
// `latest` pointer. Registry versions are always valid SemVer, so the pairwise
// comparison never hits the incomparable arm.
function newestVersion(versions: readonly string[]): string | null {
  if (versions.length === 0) {
    return null;
  }
  return versions.reduce((newest, version) =>
    isStrictlyNewerHostVersion(version, newest) ? version : newest,
  );
}
