import type {
  MutationKind,
  MutationLaneStatus,
  MutationProgress,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * THE host-progress copy table (F19).
 * One wording per event, shared by the window narrator and Settings ▸ Host.
 */

export interface HostProgressView {
  /** The sentence a user reads. Same string on both surfaces. */
  readonly heading: string;
  /** Short form for tight spots (a progress bar's own label). */
  readonly shortLabel: string;
  /** The lane's own message line, when it sent one. */
  readonly detail: string | null;
  /** The raw stage token, kept for the diagnostic line Settings renders. */
  readonly stage: string | null;
  /** Clamped to 0-100, or null when the lane reports no percentage. */
  readonly percent: number | null;
  /** e.g. "12.3 MB of 48 MB", or null when the lane reports no bytes. */
  readonly transferLabel: string | null;
}

/** The stage that overrides the kind. */
const DOWNLOAD_STAGE = "download";

/** What a local-boot surface says when NO lane is running. */
export const HOST_PROGRESS_IDLE_HEADING = "Starting Traycer…";

export function hostProgressHeading(
  kind: MutationKind,
  stage: string | null,
): string {
  if (stage === DOWNLOAD_STAGE) return "Downloading Traycer Host…";
  switch (kind) {
    case "ensure":
      return "Setting up Traycer Host…";
    case "apply":
      return "Applying the host update…";
    case "activate":
      return "Activating Traycer Host…";
    case "install":
      return "Installing Traycer Host…";
    case "register":
      return "Registering the host service…";
    case "deregister":
      return "Removing the host service…";
    case "respawn":
      return "Restarting Traycer Host…";
    case "recoverIfDown":
      return "Recovering Traycer Host…";
    case "freePortAndRestart":
      return "Freeing the host port…";
    case "uninstallHost":
      return "Uninstalling Traycer Host…";
    case "removeTraycer":
      return "Removing Traycer…";
  }
}

/**
 * The heading's short twin, for a progress bar's inline label where the full sentence would wrap.
 * Same two-way split, no second table: it reads the heading's own download rule so the pair can never disagree about which phase is running.
 */
export function hostProgressShortLabel(
  kind: MutationKind,
  stage: string | null,
): string {
  if (stage === DOWNLOAD_STAGE) return "Downloading…";
  return kind === "ensure" ? "Setting up…" : "Working…";
}

/** User-facing byte sizes (F19's unit half). */
export function formatHostProgressBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) {
    // Whole megabytes past 10: a download counting "43.7 MB" to "43.8 MB"
    // churns a digit nobody reads.
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatHostTransfer(
  bytes: number | null,
  totalBytes: number | null,
): string | null {
  if (bytes !== null && totalBytes !== null && totalBytes > 0) {
    return `${formatHostProgressBytes(bytes)} of ${formatHostProgressBytes(totalBytes)}`;
  }
  if (bytes !== null) return formatHostProgressBytes(bytes);
  if (totalBytes !== null) return formatHostProgressBytes(totalBytes);
  return null;
}

export function clampHostProgressPercent(
  percent: number | null,
): number | null {
  if (percent === null) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** The whole view for one lane, or null when no lane is running. */
export function buildHostProgressView(
  lane: MutationLaneStatus | null,
): HostProgressView | null {
  if (lane === null) return null;
  const progress: MutationProgress | null = lane.progress;
  const stage = progress?.stage ?? null;
  return {
    heading: hostProgressHeading(lane.kind, stage),
    shortLabel: hostProgressShortLabel(lane.kind, stage),
    detail: progress?.message ?? null,
    stage,
    percent: clampHostProgressPercent(progress?.percent ?? null),
    transferLabel: formatHostTransfer(
      progress?.bytes ?? null,
      progress?.totalBytes ?? null,
    ),
  };
}
