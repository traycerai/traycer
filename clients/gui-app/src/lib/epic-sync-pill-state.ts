import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";

/**
 * What the Epic header's sync pill is allowed to claim about the LINK AND
 * DURABILITY class - inputs (i) through (iv) of wire-lane invariant 8.
 *
 * `synced` and `offlineChangesSavedLocally` are durability claims. The other
 * states deliberately claim nothing about durability: before the host has
 * confirmed an edit, or while the host-durability snapshot is unknown, this
 * window may be the only place that knows about it.
 *
 * The write-command class - input (v), plus the ambiguous arm of input (iv) -
 * is deliberately NOT a member of this union. See
 * {@link EpicWriteCommandAlert} for why the two are reported separately.
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
  /**
   * Host reachable and holding outstanding work durably, cloud link down.
   *
   * The only state that claims LOCAL durability - and it is deliberately
   * unreachable from {@link deriveEpicSyncPillState}, which is pinned by test.
   * The aggregate dirty bit says the host holds work its cloud link has not
   * acknowledged; it does not say the newest bytes reached the host's own
   * durable store, so the ladder resolves that case to `offlineWithHostPending`
   * instead. The member is kept because the distinction is real and a future
   * per-leg durability signal would make it honest; nothing may return it until
   * such a signal exists.
   */
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
 * The control lane's aggregate cloud-durability answer for this epic: the host
 * owns the root ∨ any-room aggregation and publishes one bit.
 *
 * `unknown` is deliberately distinct from `clean`. Pre-snapshot silence means
 * unknown, never clean (wire-lane invariant 8), and so does a legacy
 * connection whose host cannot produce the atomic snapshot at all.
 */
export type EpicHostDirtyState = "unknown" | "clean" | "dirty";

/**
 * The write-command class, counted PER OUTCOME rather than folded into a
 * boolean.
 *
 * Every count here comes from the same `CommandRecord[]` the runtime projects,
 * and the four are kept apart because they mean four different things to the
 * person reading the pill: work in flight, work whose fate is unknown, work
 * that was refused, and work another writer replaced.
 *
 * `committed` records are counted by NOTHING. A command the serving host
 * applied is not divergence and not a failure; it stays in the projected list
 * only until the user acknowledges it, and counting it as outstanding is what
 * pinned the old pill to "Saving changes" for the rest of the session.
 */
export interface EpicWriteCommandSummary {
  /** Issued, unanswered, and still being delivered normally. */
  readonly pendingCount: number;
  /**
   * Delivered into ambiguity: the request may have reached an unnegotiated
   * host. Never auto-retried, so this is NOT "saving" - the write may simply
   * never have been applied.
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

/**
 * Counts a projected command list into {@link EpicWriteCommandSummary}.
 *
 * Generic in the intent so this module stays free of the epic write-path's
 * types: the pill weighs a command's OUTCOME, never what it was trying to do.
 */
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

/**
 * Input (v), and the ambiguous arm of input (iv), as their own verdict.
 *
 * Reported BESIDE {@link EpicSyncPillState} rather than folded into it,
 * because they are a different class and `replica-runtime/freshness.ts`
 * forbids blending classes: an aggregate hides per-class state, and the class
 * it hides first is exactly this one - "a green indicator must never hide a
 * rejected write". Keeping the two verdicts separate is what lets the pill
 * report a refused write and a down link at the same time instead of choosing
 * between them.
 */
export type EpicWriteCommandAlert =
  /** A write was refused. Terminal, and no reconnect will resolve it. */
  | "rejected"
  /** A remote host's concurrent write replaced ours. Terminal. */
  | "superseded"
  /** A write was delivered into ambiguity and may never have been applied. */
  | "outcomeUnknown";

/**
 * The most severe outstanding write-command outcome, or `null` when the write
 * path has nothing to report.
 *
 * A refused write outranks a replaced one (the user has to correct it, not
 * just reapply it), and both outrank an ambiguous delivery, which may still
 * resolve itself.
 */
export function deriveEpicWriteCommandAlert(
  summary: EpicWriteCommandSummary,
): EpicWriteCommandAlert | null {
  if (summary.rejectedCount > 0) return "rejected";
  if (summary.supersededCount > 0) return "superseded";
  if (summary.unknownOutcomeCount > 0) return "outcomeUnknown";
  return null;
}

/**
 * The five inputs of wire-lane invariant 8, unblended.
 *
 * Each field names the lane it comes from, and none of them is a display
 * blend. In particular this is deliberately NOT `OpenEpicState`'s
 * `connectionStatus`: that field is a lossy blend of
 * {@link hostTransportStatus} and {@link cloudSyncStatus} (see
 * `deriveConnectionStatus` in the open-epic store), and collapsing the two
 * legs is exactly what makes it useless here - "host unreachable" and "host
 * reachable, cloud down" both read `reconnecting`, yet only the second one may
 * claim the work is saved anywhere.
 */
export interface EpicSyncPillInputs {
  /**
   * Input (i) - the GUI↔host transport. Raw, not the display blend. When this
   * is anything but `open`, unsent local edits sit in the renderer's in-memory
   * queue and nothing durable holds them.
   */
  readonly hostTransportStatus: StreamConnectionStatus;
  /**
   * Input (ii) - the control lane's `cloudSyncStatus`: the host↔cloud link for
   * this Epic, as the host observes it.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Input (ii), freshness half - `true` only after a genuine control-lane
   * cloud-status frame in this open cycle. The projection's `connected`
   * default is a DISPLAY default that keeps functional connection gates open;
   * it is never sync proof, and this bit is what keeps the two apart.
   */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Input (iii) - the control lane's aggregate dirty bit. Pre-snapshot silence
   * and a legacy connection both remain `unknown`; neither may be read as
   * clean.
   */
  readonly hostDirtyState: EpicHostDirtyState;
  /**
   * Input (iv), doc-class arm - this replica holds root or body bytes the host
   * has not acknowledged.
   */
  readonly hasUnsyncedDocClassChanges: boolean;
  /**
   * Input (iv), command arm, and input (v).
   *
   * Invariant 8 defines leg (iv) as "unacked commands PLUS doc-class unsynced
   * edits", so the pending and ambiguous counts join
   * {@link hasUnsyncedDocClassChanges} as one divergence question - that is
   * aggregation WITHIN the runtime-divergence class, which the freshness
   * contract explicitly permits. The terminal counts are input (v) and are
   * never folded in; they gate the green claim here and are reported on their
   * own through {@link deriveEpicWriteCommandAlert}.
   */
  readonly writeCommands: EpicWriteCommandSummary;
  /**
   * Presentation qualifier on input (i), not a sixth leg: latched by the first
   * genuine cloud `connected` frame so a first-time bootstrap reads
   * "Connecting…" while a drop after a real connect reads "Reconnecting…".
   */
  readonly hasConnectedOnce: boolean;
}

/**
 * The pill's link/durability claim.
 *
 * The ordering below is the honesty contract, and every ambiguous case
 * resolves toward no durability assertion:
 *
 * 1. GUI↔host link down wins over everything in THIS class. We cannot see the
 *    host's cloud state, and any local edit is renderer-memory-only. It does
 *    not silence the write-command class, which is reported separately and
 *    stays visible beside a down link.
 * 2. Renderer-only work is `syncing`, never "saved locally". An `open`
 *    transport proves neither that the host received the frame nor that it
 *    persisted it. A command whose outcome is unknown counts as divergence
 *    too: it is unacknowledged work, and pretending otherwise is the
 *    over-claim this ladder exists to prevent.
 * 3. An unknown cloud status or aggregate dirty bit yields neutral
 *    `connected`, never `synced`.
 * 4. Link up + cloud up: `synced` requires a clean aggregate, no local
 *    divergence, AND nothing outstanding on the write path - a refused or
 *    superseded write drops the claim to the neutral `connected`, because a
 *    green pill that hides a rejected write is the single failure the
 *    freshness contract names. Host-reported pending work stays quiet as
 *    `hostPending`; the aggregate dirty bit does not prove whether the newest
 *    bytes are durable.
 * 5. Link up + cloud down: with nothing outstanding the pill falls back to
 *    reporting the link.
 */
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
