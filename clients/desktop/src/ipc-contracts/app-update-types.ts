export type DesktopAppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "up-to-date"
  | "unavailable";

export type DesktopAppUpdateCheckIntent = "automatic" | "manual";

// Linux deb/rpm only: shown when a privileged install can't be applied for
// the user automatically (WSL, or an install the package manager doesn't own
// at the path we're running from) and the renderer needs actual steps to
// follow, not just a tooltip label. `command` is the exact shell command to
// run against the file already downloaded to `installerPath`-equivalent
// storage; null only if guidance is somehow requested before a download
// completed.
export interface DesktopAppUpdateGuidance {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly command: string | null;
  readonly releaseUrl: string;
}

export interface DesktopAppUpdateSnapshot {
  readonly sequence: number;
  readonly status: DesktopAppUpdateStatus;
  readonly currentVersion: string;
  /** Whether update checks may select release candidates and prereleases. */
  readonly allowPrerelease: boolean;
  readonly latestVersion: string | null;
  /**
   * The client-compatibility EPOCH the resolved candidate declares, stamped
   * into the updater feed beside its version. Same lifecycle as
   * {@link latestVersion}.
   *
   * `null` means the candidate's generation could not be established - an
   * unstamped feed, an unparseable one, or a build reached by
   * electron-updater's deep-validation fallback rather than the one the release
   * gate proved. It does NOT mean "epoch 1": mapping a missing declaration to
   * the legacy generation is honest only for a client a host observed on the
   * wire, never for a build nobody has run yet.
   *
   * Every consumer must therefore treat `null` as INSUFFICIENT, because
   * offering an unknown-generation build as the remedy for a compatibility
   * rejection restarts the app straight back into the same rejection.
   *
   * Mirrored in `gui-app/src/lib/windows/types.ts` - this pair crosses the IPC
   * boundary and the two must not drift.
   */
  readonly latestCompatibilityEpoch: number | null;
  // Whole-percent download progress (0-100) while `status` is "downloading";
  // null in every other state (including before a user-initiated download).
  readonly downloadProgress: number | null;
  // Non-null when updates can't be installed from the current location (macOS
  // app running outside /Applications). Carries the user-facing reason; the
  // renderer disables the download affordance and shows it as a tooltip.
  readonly installBlockedReason: string | null;
  // Non-null when a Linux deb/rpm install needs a manual step to finish
  // (see `DesktopAppUpdateGuidance`). Unlike `installBlockedReason`, the
  // renderer keeps the download/restart affordance clickable and opens a
  // dialog with the steps instead of disabling it - the update can still be
  // applied, just not fully automatically.
  readonly installGuidance: DesktopAppUpdateGuidance | null;
  // True from the moment `installDownloadedUpdate` hands off to
  // `quitAndInstall` until the install either ends the process or fails back to
  // "error". The quit it triggers is not instant (`before-quit` drains an
  // in-flight host mutation, then the renderer projections), so without this the
  // renderer sees NO state change for the whole drain and every restart
  // affordance - in every window - stays armed to fire a second install. Status
  // deliberately stays "ready" throughout: the artifact is still staged, and the
  // updater's own "ready" guards key on that.
  readonly installInFlight: boolean;
  readonly errorMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckIntent: DesktopAppUpdateCheckIntent | null;
}

/**
 * Result of a channel-preference mutation. The setter reports what happened
 * instead of deciding how to present it, so the IPC boundary can turn a
 * refusal into a user-visible error and only run the post-change fan-out after
 * a durable success.
 *
 *   - `changed`   - persisted durably; the new channel is live.
 *   - `unchanged` - the requested channel was already selected; nothing moved.
 *   - `refused-update-pending` - an update is downloading, or a staged artifact
 *     could not be discarded on this platform, so the mutation was rejected
 *     before persistence. This is a failure, not a setting change. On macOS it
 *     is a STANDING outcome rather than a transient one - see
 *     {@link DesktopCompatRecoveryPlan}'s `restart-to-clear-staged` route.
 */
export type DesktopAppUpdateChannelChangeOutcome =
  | "changed"
  | "unchanged"
  | "refused-update-pending";

export interface DesktopAppUpdateChannelChange {
  readonly outcome: DesktopAppUpdateChannelChangeOutcome;
  readonly snapshot: DesktopAppUpdateSnapshot;
}

/**
 * WHERE A COMPATIBILITY-REJECTED APP SHOULD SEND THE USER, decided in the main
 * process because every input to the decision lives there: the platform, the
 * staged-artifact state, `autoInstallOnAppQuit`, and the RC feed.
 *
 * The renderer deliberately gets a ROUTE rather than the facts behind it. The
 * alternative - shipping `process.platform` and `updateArtifactStaged` to the
 * renderer and letting it re-derive the policy - puts a second copy of §5's
 * platform reasoning in a place that cannot observe electron-updater at all,
 * and the two copies would drift on the first bump.
 *
 *   - `update-available`        the candidate the selected feed already holds
 *                               clears the floor; the ordinary download/install
 *                               affordances are the remedy and no channel change
 *                               is offered.
 *   - `enable-rc`               stable cannot help, the rejecting host is on the
 *                               RC line, and a bounded read-only probe found an
 *                               RC build whose stamped epoch clears the floor.
 *                               Anything staged has already been discarded, so
 *                               the opt-in will be accepted.
 *   - `restart-to-clear-staged` macOS with an insufficient update already staged
 *                               natively by Squirrel. Nothing supported can
 *                               discard it, so the honest instruction is to let
 *                               it apply and relaunch - recovery then
 *                               re-evaluates with nothing staged.
 *   - `manual`                  everything else, including the honest corner
 *                               where the only sufficient build is a stable
 *                               release the updater cannot resolve.
 */
export type DesktopCompatRecoveryRoute =
  | "update-available"
  | "enable-rc"
  | "restart-to-clear-staged"
  | "manual";

export interface DesktopCompatRecoveryPlan {
  readonly route: DesktopCompatRecoveryRoute;
  /**
   * The RC build the probe found, on the `enable-rc` route only. Named so the
   * dialog can say which build it is about to opt the user into rather than
   * asking them to consent to an unnamed channel change.
   */
  readonly rcCandidateVersion: string | null;
  /**
   * The version of an insufficient artifact still staged for install, on the
   * `restart-to-clear-staged` route only. This is the build that WILL apply at
   * the next quit whatever the user does, which is the one fact that route
   * exists to state plainly.
   */
  readonly stagedVersion: string | null;
  // Deliberately carries NO snapshot. Resolving a plan can discard an
  // insufficient staged artifact, but that transition is already published
  // through the ordinary `appUpdateChange` fan-out that every window is
  // subscribed to - returning a second copy here gave callers two sources for
  // one fact, and the one they would reach for first is the stale one.
}
