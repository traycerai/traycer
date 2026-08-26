/**
 * THE Desktop update channel model: which policy an update check runs under,
 * and what a change of policy is allowed to disturb.
 *
 * A boolean cannot express the selection rules this app needs. `allowPrerelease`
 * answers "may a check see prerelease tags at all", and two genuinely different
 * policies answer it the same way:
 *
 *   - an RC build silently FOLLOWING ITS OWN LINE (`2.0.0-rc.1` may take
 *     `2.0.0-rc.2` or `2.0.0`, and nothing else), which is derived from the
 *     installed version and is never persisted; and
 *   - a user who explicitly OPTED IN to prereleases, whose opt-in is broad by
 *     design and may cross release lines.
 *
 * Collapsing those two onto one flag is what makes an implicit follower jump to
 * `2.1.0-rc.1`, and what makes a compatibility dialog offer to "enable RC
 * updates" to a build that is already receiving them - persisting an opt-in the
 * user never asked for. So the mode, not the flag, is what candidate selection
 * and channel transitions are keyed on; the flag is a derived effect of it.
 *
 * Pure and electron-free on purpose: `updater.ts` cannot be imported without
 * `electron` and `electron-updater`, and these rules are exactly the part that
 * deserves to be table-tested without either.
 *
 * THE RELEASE-LINE VOCABULARY IS NOT DEFINED HERE. "Is this a canonical
 * `X.Y.Z-rc.N`" and "are these two versions on one line" are the same questions
 * the CLI's catalog defaulting asks, and a second copy of that predicate is
 * precisely the drift the shared module exists to prevent - so they are
 * imported from `@traycer-clients/shared/host-version/release-line`, the same
 * boundary `electron-main/host` already reads its comparator from. What lives
 * here is only what is genuinely Desktop policy: which mode those facts imply,
 * and what a mode change is allowed to disturb.
 */
import {
  isCanonicalReleaseCandidate,
  isSameReleaseLine,
} from "@traycer-clients/shared/host-version/release-line";

export type DesktopUpdateChannelMode =
  "stable-only" | "implicit-rc-line" | "explicit-prerelease";

/**
 * The mode a check runs under, from the two inputs that decide it: the durable
 * explicit preference, and the version this app was built as.
 *
 * The explicit preference wins outright - it is a broader opt-in than implicit
 * following, and an RC user who asked for prereleases asked for all of them.
 */
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

/**
 * `electron-updater.allowPrerelease` as a DERIVED effect of the mode.
 *
 * Both non-stable modes must let prerelease tags through the feed; what they
 * must not share is which candidate they then select. That distinction lives in
 * the selector, which receives the mode itself.
 */
export function modeAllowsPrerelease(mode: DesktopUpdateChannelMode): boolean {
  return mode !== "stable-only";
}

/**
 * Whether a discovered release is selectable for `mode`, given the installed
 * version and an already-decided "is it strictly newer" verdict.
 *
 * The newer-ness verdict is passed in rather than computed: the comparator the
 * selector uses is the one that must decide it, and a second comparison here
 * would be a second answer to the same question.
 *
 *   - `implicit-rc-line` restricts to the installed build's OWN line. Stable
 *     `X.Y.Z` and later `X.Y.Z-rc.M` both qualify; `X.Y+1.0-rc.1` does not, at
 *     any version distance. An ABANDONED line therefore has no implicit exit -
 *     if `2.0.0` is never published and the work ships as `2.1.0`, a
 *     `2.0.0-rc.1` build stops seeing updates. That is the accepted product
 *     behavior, not an oversight: the alternative (letting the follower take a
 *     newer stable on any line) is a cross-line jump nobody consented to, and
 *     the remedy for an abandoned line is to publish its stable or to reinstall.
 *   - `explicit-prerelease` keeps the existing broad behavior (the newest
 *     usable stable or RC release, whatever its line).
 *   - `stable-only` never reaches the namespaced selector at all - it uses the
 *     ordinary stable feed - so it is answered here only for totality.
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
 * PERSISTED INTENT AND EFFECTIVE MODE ARE STILL TWO THINGS, and
 * `performChannelChange` keeps them ordered as two - but under the derivation
 * above they cannot come apart, so nothing here decides between them.
 *
 * `resolveUpdateChannelMode(true, …)` is always `explicit-prerelease` and
 * `resolveUpdateChannelMode(false, …)` never is, so any request that moves the
 * saved preference necessarily moves the mode. A helper that answered "did the
 * effective mode change" would have exactly one possible answer, and the branch
 * consuming it would be unreachable - which is why neither exists.
 *
 * The distinction still matters to a reader, and to whoever extends this: if a
 * future mode is selectable under BOTH preference values, the persist step and
 * the transition choreography must be split at the call site (see the note in
 * `performChannelChange`), because the destructive half is only ever warranted
 * by a change in which candidates the updater would select.
 */
