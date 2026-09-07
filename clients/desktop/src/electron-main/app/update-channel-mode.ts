/**
 * A boolean cannot express the selection rules this app needs.
 * `allowPrerelease` answers "may a check see prerelease tags at all", and two genuinely different policies answer it the same way.
 */
import {
  isCanonicalReleaseCandidate,
  isSameReleaseLine,
} from "@traycer-clients/shared/host-version/release-line";

export type DesktopUpdateChannelMode =
  | "stable-only"
  | "implicit-rc-line"
  | "explicit-prerelease";

export function resolveUpdateChannelMode(
  explicitPrerelease: boolean,
  installedVersion: string,
): DesktopUpdateChannelMode {
  if (explicitPrerelease) {
    return "explicit-prerelease";
  }
  return isCanonicalReleaseCandidate(installedVersion)
    ? "implicit-rc-line"
    : "stable-only";
}

/** Both non-stable modes must let prerelease tags through the feed; what they must not share is which candidate they then select. */
export function modeAllowsPrerelease(mode: DesktopUpdateChannelMode): boolean {
  return mode !== "stable-only";
}

/**
 * The newer-ness verdict is passed in rather than computed: the comparator the selector uses is the one that must decide it, and a second comparison here would be a second answer to.
 * An ABANDONED line therefore has no implicit exit - if `2.0.0` is never published and the work ships as `2.1.0`, a `2.0.0-rc.1` build stops seeing updates.
 */
export function isSelectableCandidate(input: {
  readonly mode: DesktopUpdateChannelMode;
  readonly installedVersion: string;
  readonly candidateVersion: string;
  readonly isStrictlyNewer: boolean;
}): boolean {
  if (input.mode !== "implicit-rc-line") {
    return true;
  }
  return (
    input.isStrictlyNewer &&
    isSameReleaseLine(input.installedVersion, input.candidateVersion)
  );
}

/**
 * PERSISTED INTENT AND EFFECTIVE MODE ARE STILL TWO THINGS, and `performChannelChange` keeps them ordered as two.
 * `resolveUpdateChannelMode(true, …)` is always `explicit-prerelease` and `resolveUpdateChannelMode(false, …)` never is, so any request that moves the saved preference necessarily.
 */
