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
  readonly errorMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckIntent: DesktopAppUpdateCheckIntent | null;
}
