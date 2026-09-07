import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";

/**
 * What the Epic header's sync pill is allowed to claim about the LINK AND DURABILITY class - inputs (i) through (iv) of wire-lane invariant 8.
 */
export type EpicSyncPillState =
  /** Every leg of the chain has acknowledged everything we know about. */
  | "synced"
  /** Work has not yet been acknowledged by the host. */
  | "syncing"
  /** The host reports pending work without asserting its durability stage. */
  | "hostPending"
  /** Cloud is down while renderer-only work still awaits host acknowledgement. */
  | "offlineWithUnsavedChanges"
  /** Cloud is down and the host reports pending work with unknown durability. */
  | "offlineWithHostPending"
  /** Host reachable and holding outstanding work durably, cloud link down. */
  | "offlineChangesSavedLocally"
  /** GUI↔host is open, but cloud or host-durability state is still unknown. */
  | "connected"
  /** GUI↔host link coming up for the first time on this subscription. */
  | "connecting"
  /** GUI↔host link re-establishing after a prior successful connect. */
  | "reconnecting"
  /** GUI↔host link closed. */
  | "offline";

/**
 * The control lane's aggregate cloud-durability answer for this epic: the host owns the root ∨ any-room aggregation and publishes one bit.
 */
export type EpicHostDirtyState = "unknown" | "clean" | "dirty";

/** The write-command class, counted PER OUTCOME rather than folded into a boolean. */
export interface EpicWriteCommandSummary {
  /** Issued, unanswered, and still being delivered normally. */
  readonly pendingCount: number;
  /**
   * Delivered into ambiguity: the request may have reached an unnegotiated host.
   * Never auto-retried, so this is NOT "saving" - the write may simply never have been applied.
   */
  readonly unknownOutcomeCount: number;
  /** The authority refused the write. Terminal; the intent is retained. */
  readonly rejectedCount: number;
  /** Another writer's change won. Terminal; the intent is retained. */
  readonly supersededCount: number;
}

export const NO_OUTSTANDING_WRITE_COMMANDS: EpicWriteCommandSummary =
  Object.freeze({
    pendingCount: 0,
    unknownOutcomeCount: 0,
    rejectedCount: 0,
    supersededCount: 0,
  });

/** Counts a projected command list into {@link EpicWriteCommandSummary}. */
export function summarizeEpicWriteCommands<TIntent>(
  commands: readonly CommandRecord<TIntent>[],
): EpicWriteCommandSummary {
  let pendingCount = 0;
  let unknownOutcomeCount = 0;
  let rejectedCount = 0;
  let supersededCount = 0;
  for (const command of commands) {
    if (command.delivery === "unknown-outcome") {
      unknownOutcomeCount += 1;
      continue;
    }
    switch (command.state) {
      case "pending":
        pendingCount += 1;
        break;
      case "rejected":
        rejectedCount += 1;
        break;
      case "superseded":
        supersededCount += 1;
        break;
      case "committed":
        break;
    }
  }
  return {
    pendingCount,
    unknownOutcomeCount,
    rejectedCount,
    supersededCount,
  };
}

/** Input (v), and the ambiguous arm of input (iv), as their own verdict. */
export type EpicWriteCommandAlert =
  /** A write was refused. Terminal, and no reconnect will resolve it. */
  | "rejected"
  /** A remote host's concurrent write replaced ours. Terminal. */
  | "superseded"
  /** A write was delivered into ambiguity and may never have been applied. */
  | "outcomeUnknown";

/** The most severe outstanding write-command outcome, or `null` when the write path has nothing to report. */
export function deriveEpicWriteCommandAlert(
  summary: EpicWriteCommandSummary,
): EpicWriteCommandAlert | null {
  if (summary.rejectedCount > 0) return "rejected";
  if (summary.supersededCount > 0) return "superseded";
  if (summary.unknownOutcomeCount > 0) return "outcomeUnknown";
  return null;
}

/** The five inputs of wire-lane invariant 8, unblended. */
export interface EpicSyncPillInputs {
  /**
   * Input (i) - the GUI↔host transport.
   * Raw, not the display blend.
   */
  readonly hostTransportStatus: StreamConnectionStatus;
  /** Input (ii) - the control lane's `cloudSyncStatus`: the host↔cloud link for this Epic, as the host observes it. */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Input (ii), freshness half - `true` only after a genuine control-lane cloud-status frame in this open cycle.
   * The projection's `connected` default is a DISPLAY default that keeps functional connection gates open; it is never sync proof, and this bit is what keeps the two apart.
   */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Input (iii) - the control lane's aggregate dirty bit.
   * Pre-snapshot silence and a legacy connection both remain `unknown`; neither may be read as clean.
   */
  readonly hostDirtyState: EpicHostDirtyState;
  /** Input (iv), doc-class arm - this replica holds root or body bytes the host has not acknowledged. */
  readonly hasUnsyncedDocClassChanges: boolean;
  /** Input (iv), command arm, and input (v). */
  readonly writeCommands: EpicWriteCommandSummary;
  /**
   * Presentation qualifier on input (i), not a sixth leg: latched by the first genuine cloud `connected` frame so a first-time bootstrap reads "Connecting…" while a drop after a real connect reads "Reconnecting…".
   */
  readonly hasConnectedOnce: boolean;
}

/** The pill's link/durability claim. */
export function deriveEpicSyncPillState(
  inputs: EpicSyncPillInputs,
): EpicSyncPillState {
  if (inputs.hostTransportStatus === "closed") return "offline";
  if (inputs.hostTransportStatus !== "open") {
    return linkComingUpState(inputs.hasConnectedOnce);
  }
  if (hasRuntimeDivergence(inputs)) {
    if (
      inputs.hasFreshCloudSyncStatus &&
      inputs.cloudSyncStatus !== "connected"
    ) {
      return "offlineWithUnsavedChanges";
    }
    return "syncing";
  }
  if (!inputs.hasFreshCloudSyncStatus || inputs.hostDirtyState === "unknown") {
    return "connected";
  }
  if (inputs.cloudSyncStatus === "connected") {
    if (inputs.hostDirtyState === "dirty") return "hostPending";
    return deriveEpicWriteCommandAlert(inputs.writeCommands) === null
      ? "synced"
      : "connected";
  }
  return inputs.hostDirtyState === "dirty"
    ? "offlineWithHostPending"
    : linkComingUpState(inputs.hasConnectedOnce);
}

/** Leg (iv) of invariant 8: unacked commands ∨ doc-class unsynced edits. */
function hasRuntimeDivergence(inputs: EpicSyncPillInputs): boolean {
  return (
    inputs.hasUnsyncedDocClassChanges ||
    inputs.writeCommands.pendingCount > 0 ||
    inputs.writeCommands.unknownOutcomeCount > 0
  );
}

function linkComingUpState(
  hasConnectedOnce: boolean,
): Extract<EpicSyncPillState, "connecting" | "reconnecting"> {
  return hasConnectedOnce ? "reconnecting" : "connecting";
}
