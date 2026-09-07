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

/** FAILS CLOSED on a missing, malformed, or unreadable install record: `readDesktopHostInstallRecord` answers `null` for all three, and a Host whose version cannot be established. */
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

/** Whether `host available` must be asked for the pre-release view. */
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

/** RC releases never move that pointer, and a line's stable can be published while it still names an older release. */
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
