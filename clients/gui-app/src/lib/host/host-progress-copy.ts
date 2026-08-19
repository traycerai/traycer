import type {
  MutationKind,
  MutationLaneStatus,
  MutationProgress,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * THE host-progress copy table (F19). One wording per event, shared by the
 * window narrator and Settings ▸ Host.
 *
 * These two surfaces described the same mutation lane in two different
 * vocabularies: the boot overlay derived its heading from the progress STAGE
 * ("Downloading Traycer Host…" / "Setting up Traycer Host…") while Settings
 * derived it from the mutation KIND ("Setting up host", "Installing version"),
 * and the two even disagreed on units - MB against MiB - so the same install
 * read as two different sizes depending on which screen you watched it from.
 * Neither was wrong; there were simply two tables. This is the one table.
 *
 * Keyed on `(kind, stage)` and TOTAL over `MutationKind`: a new lane kind
 * fails to compile here naming its missing arm, rather than falling through to
 * a generic label on both surfaces at once. That is the same shape the
 * activate-refusal copy uses, and for the same reason - a hand-written subset
 * of a union is how a new member arrives as a silent fallback instead of an
 * error.
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

/**
 * The stage that overrides the kind.
 *
 * A download is the one phase long enough, and distinct enough, that naming
 * the KIND instead would describe the wrong thing for minutes: "Setting up
 * Traycer Host…" beside a stalled progress bar reads as a hang, where
 * "Downloading Traycer Host…" reads as a slow network. Every other stage is an
 * implementation detail of its kind and keeps the kind's wording.
 */
const DOWNLOAD_STAGE = "download";

/**
 * What a local-boot surface says when NO lane is running.
 *
 * Part of this table rather than inlined at the one surface that renders it,
 * because it is the same event ("we are waiting on this machine's host") the
 * lane headings continue - and it is the string a user stares at longest on a
 * launch that goes wrong.
 *
 * DELIBERATELY IDENTICAL to what the two boot surfaces BEFORE this one say
 * (the runtime-binding fallback in `traycer-app.tsx` and the gate's attach
 * cover). Those three are different React trees that a launch crosses in
 * sequence, and while a lane is idle they are all reporting the same fact:
 * Traycer is starting. This used to read "Starting local Traycer Host…" while
 * its predecessor read "Initializing Traycer Host…", so a single uninterrupted
 * wait looked like one modal being replaced by another. The moment a lane DOES
 * report, the headings below take over and say something genuinely new.
 */
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
 * The heading's short twin, for a progress bar's inline label where the full
 * sentence would wrap. Same two-way split, no second table: it reads the
 * heading's own download rule so the pair can never disagree about which
 * phase is running.
 */
export function hostProgressShortLabel(
  kind: MutationKind,
  stage: string | null,
): string {
  if (stage === DOWNLOAD_STAGE) return "Downloading…";
  return kind === "ensure" ? "Setting up…" : "Working…";
}

/**
 * User-facing byte sizes (F19's unit half).
 *
 * MB/GB, not MiB/GiB: the divisor stays binary because that is what every
 * transfer actually counts, but the LABEL is the one people read on a download
 * elsewhere in the product. Settings previously said MiB, which is correct and
 * is not the register the rest of this app speaks in; one table means one
 * answer, and this is it.
 */
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

/**
 * The whole view for one lane, or null when no lane is running.
 *
 * `progress` being null is NOT the same as no lane: a lane that has been
 * accepted but has not pushed its first event yet still has a kind, and saying
 * "Setting up Traycer Host…" through that gap is the difference between a
 * launch that looks alive and one that looks frozen.
 */
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
