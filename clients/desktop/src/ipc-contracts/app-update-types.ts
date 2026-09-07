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
   * It does NOT mean "epoch 1": mapping a missing declaration to the legacy generation is honest only for a client a host observed on the wire, never for a build nobody has run yet.
   * Every consumer must therefore treat `null` as INSUFFICIENT, because offering an unknown-generation build as the remedy for a compatibility rejection restarts the app straight back.
   */
  readonly latestCompatibilityEpoch: number | null;
  // Whole-percent download progress (0-100) while `status` is "downloading";
  // null in every other state (including before a user-initiated download).
  readonly downloadProgress: number | null;
  // Non-null when updates can't be installed from the current location (macOS
  // app running outside /Applications). Carries the user-facing reason; the
  // renderer disables the download affordance and shows it as a tooltip.
  readonly installBlockedReason: string | null;
  readonly installGuidance: DesktopAppUpdateGuidance | null;
  readonly installInFlight: boolean;
  readonly errorMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckIntent: DesktopAppUpdateCheckIntent | null;
}

export type DesktopAppUpdateChannelChangeOutcome =
  | "changed"
  | "unchanged"
  | "refused-update-pending";

export interface DesktopAppUpdateChannelChange {
  readonly outcome: DesktopAppUpdateChannelChangeOutcome;
  readonly snapshot: DesktopAppUpdateSnapshot;
}

/**
 * The alternative - shipping `process.platform` and `updateArtifactStaged` to the renderer and letting it re-derive the policy.
 * - `enable-rc` stable cannot help, the rejecting host is on the RC line, and a bounded read-only probe found an RC build whose stamped epoch clears the floor.
 */
export type DesktopCompatRecoveryRoute =
  | "update-available"
  | "enable-rc"
  | "restart-to-clear-staged"
  | "manual";

export interface DesktopCompatRecoveryPlan {
  readonly route: DesktopCompatRecoveryRoute;
  readonly rcCandidateVersion: string | null;
  readonly stagedVersion: string | null;
}
