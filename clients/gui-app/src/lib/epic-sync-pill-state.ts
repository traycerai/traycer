import type {
  EpicCloudFreshness,
  EpicCloudSyncStatus,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
} from "@traycer/protocol/host/epic/subscribe";
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
  /**
   * The epic is not in the cloud at all, and everything known is on disk here.
   *
   * Exists because `synced` was rendering beside the durability badge's
   * "Stored locally" - the pill read a `LocalRoomConnection` as
   * connected/clean and concluded "All changes synced" about an epic no cloud
   * has ever seen. That is the normal settled free-tier session, not a corner
   * case. This says the true thing instead of the reassuring one.
   */
  | "storedLocally"
  /**
   * This session has NO local WAL, and nothing is carrying the work durably.
   *
   * The one pill state that reports a risk rather than a stage. An unarmed
   * session used to render identically to a protected one; edits live in the
   * doc alone and die on crash AND on graceful quit. Reachable while
   * `cloudSyncStatus === "connected"`: a `LocalRoomConnection` satisfies that
   * status without saying the bytes are anywhere but this process, so
   * `cloudUpState` returns this when `localProtection === "unavailable"`.
   * Disconnected, the same unarmed session lands here from `cloudDownState`.
   */
  | "unprotected"
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
  /**
   * Input 7 - where the host says the epic is durable (`epic.subscribe@1.6`).
   *
   * `undefined` is NOT "fine". At `@1.6` an absent key means unknown, and the
   * pill's calm claim has to be licensed by a positive statement - see
   * {@link syncedClaimIsHonest}.
   */
  readonly durability: EpicDurabilityStatusV15 | undefined;
  /**
   * Input 8 - whether this session has local WAL protection (`@1.6`).
   *
   * Doubles as the MINOR PROBE, deliberately and by construction: a `@1.6`
   * host emits this key on every `cloudSyncStatus` frame unconditionally, so
   * `undefined` identifies a peer on an older minor that cannot express any of
   * this. Such a peer keeps exactly its current rendering rather than being
   * degraded to unknown, which is what makes the whole minor additive.
   */
  readonly localProtection: EpicLocalProtection | undefined;
  /**
   * Whether the session's negotiated `epic.subscribe` minor speaks the
   * `@1.6` durability legs. The probe-by-presence above identifies a peer
   * that SENT the key; this identifies one that COULD have. The schema marks
   * every `@1.6` leg optional and an absent one means UNKNOWN, so an omission
   * from a negotiated-`@1.6` peer must stay indeterminate rather than taking
   * the legacy calm arm - the same handshake-over-frame-shape rule
   * `deriveEpicDurabilityView` applies.
   */
  readonly durabilityLegsNegotiated: boolean;
  /**
   * Input 9 - how the served document stands relative to the cloud (`@1.6`,
   * `s5-mirror-first-serving`).
   *
   * The pill's other eight legs are all about where WORK is going. This one is
   * about what the reader is LOOKING at, and mirror-first serving is what made
   * the two separable: the host now paints a WAL-backed document before it has
   * reconciled, so an epic can have a live cloud link and nothing outstanding
   * while what is on screen is still a local copy.
   *
   * `undefined` keeps today's behaviour exactly. The host omits this key where
   * the question does not apply - a local-homed epic, a cloud row it has no
   * record of - and a pre-`@1.6` peer cannot send it at all.
   */
  readonly cloudFreshness: EpicCloudFreshness | undefined;
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
  return inputs.cloudSyncStatus === "connected"
    ? cloudUpState(inputs)
    : cloudDownState(inputs);
}

/**
 * Rule 4's tail, reached with the link up, the cloud up, a fresh snapshot and
 * no renderer-only divergence. Split out of {@link deriveEpicSyncPillState}
 * only to keep that function under the complexity ceiling - the ordering here
 * is a continuation of the contract stated there, not a separate policy.
 */
function cloudUpState(inputs: EpicSyncPillInputs): EpicSyncPillState {
  if (inputs.hostDirtyState === "dirty") return "hostPending";
  if (syncedClaimIsHonest(inputs)) {
    // Rule 4's write-path leg (input v): a terminal verdict - refused or
    // superseded - drops the green claim to neutral `connected`. Only the
    // SYNCED claim is gated; the risk arms below (`unprotected`,
    // `storedLocally`) stay, because the alert is reported beside the pill
    // rather than allowed to mask a durability risk.
    return deriveEpicWriteCommandAlert(inputs.writeCommands) === null
      ? "synced"
      : "connected";
  }
  // Not synced anywhere in the cloud. Say which, when the host said which,
  // and otherwise claim nothing - `connected` is the neutral state that
  // exists for exactly this.
  if (inputs.durability !== "local" && inputs.durability !== "promoting") {
    return "connected";
  }
  // "Saved on this device" is a DURABILITY claim, and the local-room
  // connection satisfying `cloudSyncStatus === "connected"` says nothing
  // about it: with `localProtection: "unavailable"` the protocol is explicit
  // that edits live only in the document and are lost on process exit,
  // graceful quit included. The rule stated at `syncedClaimIsHonest` applies
  // here identically - a calm claim needs a POSITIVE statement behind it.
  if (inputs.localProtection === "unavailable") return "unprotected";
  if (inputs.localProtection === "unknown") return "connected";
  // An OMITTED key splits the same two ways `syncedClaimIsHonest` splits it,
  // and for the same reason: the probe-by-presence identifies a peer that
  // SENT the key, the handshake identifies one that COULD have. A negotiated
  // `@1.6` peer that omitted it is stating UNKNOWN per the schema's own
  // absence rule, and `storedLocally` is every bit as positive a claim as
  // `synced` - it tells the reader the bytes are on this disk.
  //
  // The negotiated check is what makes the rule uniform rather than what makes
  // it reachable: only a `@1.6` peer can send the `local` / `promoting`
  // durability this arm requires, so a pre-`@1.6` frame never arrives here at
  // all. Stated the same way as its sibling so neither can be read as
  // licensing an absence.
  if (inputs.localProtection === undefined && inputs.durabilityLegsNegotiated) {
    return "connected";
  }
  return "storedLocally";
}

/**
 * Rule 5's tail. The pill may not imply the work is being kept anywhere
 * unless something is keeping it - and an unarmed session is keeping it
 * nowhere.
 */
function cloudDownState(inputs: EpicSyncPillInputs): EpicSyncPillState {
  if (inputs.localProtection === "unavailable") return "unprotected";
  if (inputs.hostDirtyState === "dirty") {
    // `armed` is the POSITIVE statement this state's contract requires: the
    // host has the outstanding work in its WAL and will replay it. Without
    // this arm `offlineChangesSavedLocally` was unreachable - the union
    // member, its pill rendering, and its tests all existed for a state the
    // derivation could never return.
    return inputs.localProtection === "armed"
      ? "offlineChangesSavedLocally"
      : "offlineWithHostPending";
  }
  return linkComingUpState(inputs.hasConnectedOnce);
}

/**
 * Whether "All changes synced" is a true statement right now.
 *
 * `synced` is a CLOUD durability claim, and the pill used to make it off the
 * connection alone - which a `LocalRoomConnection` satisfies. So the settled
 * free-tier session rendered "All changes synced" inches from the durability
 * badge's "Stored locally", about an epic that has never been uploaded.
 *
 * The rule, stated once here rather than at each caller: a calm claim needs a
 * POSITIVE statement behind it, never an absence.
 *
 * - No `localProtection` at all means a pre-`@1.6` peer, which cannot express
 *   any of this. It keeps its exact current behaviour; degrading it to unknown
 *   would make this minor a breaking change for every older host.
 * - `durability: "cloud"` is the POSITIVE cloud-durable statement the `@1.6`
 *   enum now carries, and it is the ONLY durability value that licenses calm.
 *   An absent `durability` from a `@1.6` peer means UNKNOWN - the frame's own
 *   absence rule - and review found the earlier reading here (absence beside
 *   `armed` as the calm arm) resolving a schema-permitted omission into
 *   exactly the silence-as-reassurance this minor exists to break.
 * - Every OTHER stated durability value says the epic is not simply sitting
 *   durable in the cloud, `unknown` included.
 * - A STATED freshness other than `current` says the DOCUMENT is not known to
 *   match the cloud's, whatever the durability legs say about the bytes going
 *   the other way. "All changes synced" over a document the host is still
 *   revalidating is the same false calm as the original defect, arriving
 *   through the axis `s5-mirror-first-serving` opened up.
 */
function syncedClaimIsHonest(inputs: EpicSyncPillInputs): boolean {
  if (
    inputs.cloudFreshness !== undefined &&
    inputs.cloudFreshness.state !== "current"
  ) {
    return false;
  }
  if (
    inputs.localProtection === undefined &&
    !inputs.durabilityLegsNegotiated
  ) {
    // A genuinely pre-`@1.6` peer keeps its legacy rendering. A negotiated
    // `@1.6` peer omitting the optional key falls through: absence is the
    // wire contract's UNKNOWN and cannot license the calm claim.
    return true;
  }
  return inputs.durability === "cloud";
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
