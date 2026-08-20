import type {
  EpicCloudFreshness,
  EpicCloudSyncStatus,
  EpicDurabilityStatusV15,
  EpicLocalProtection,
} from "@traycer/protocol/host/epic/subscribe";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

/**
 * What the Epic header's sync pill is allowed to claim.
 *
 * `synced` and `offlineChangesSavedLocally` are durability claims. The other
 * states deliberately claim nothing about durability: before the host has
 * confirmed an edit, or while the host-durability snapshot is unknown, this
 * window may be the only place that knows about it.
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
   * The only state that claims local durability, and it is true because the
   * host persists root-doc and artifact-room updates to SQLite while its cloud
   * link is down and replays them on reconnect.
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
   * This session has NO local WAL, and the cloud link is not currently
   * carrying the work either.
   *
   * The one pill state that reports a risk rather than a stage. An unarmed
   * session used to render identically to a protected one, and while
   * disconnected it is strictly less durable than pre-WAL builds: edits live
   * in the doc alone and die on crash AND on graceful quit. Never shown while
   * the cloud is connected - there the work IS reaching somewhere, and the
   * durability badge carries the protection warning instead.
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
 * The host's current cloud-durability knowledge for the root doc and every
 * artifact room. `unknown` is deliberately distinct from `clean`: a new GUI
 * connected to an older host, or a new subscription before its atomic
 * `dirtySnapshot`, has not established that no durable work exists.
 */
export type EpicHostDirtyState = "unknown" | "clean" | "dirty";

/**
 * The five independent legs the pill must weigh, plus the bootstrap qualifier
 * that decides "Connecting…" vs "Reconnecting…" copy.
 *
 * Deliberately NOT `OpenEpicState["connectionStatus"]`: that field is a lossy
 * *display* blend of {@link hostTransportStatus} and {@link cloudSyncStatus}
 * (see `deriveConnectionStatus` in the open-epic store), and collapsing the
 * two legs is exactly what makes it useless here - "host unreachable" and
 * "host reachable, cloud down" both read `reconnecting`, yet only the second
 * one may claim the work is saved anywhere.
 */
export interface EpicSyncPillInputs {
  /**
   * Input 1 - the renderer↔host stream. Raw, not the display blend. When this
   * is anything but `open`, unsent local edits sit in the renderer's in-memory
   * queue and nothing durable holds them.
   */
  readonly hostTransportStatus: StreamConnectionStatus;
  /**
   * Input 2 - the host↔cloud link for this Epic, as the host observes it.
   */
  readonly cloudSyncStatus: EpicCloudSyncStatus;
  /**
   * Input 3 - `true` only after a genuine `cloudSyncStatus` frame in this
   * stream cycle. A display default is never proof that the cloud is connected.
   */
  readonly hasFreshCloudSyncStatus: boolean;
  /**
   * Input 4 - cloud-durability state from `epic.subscribe@1.1`'s atomic
   * `dirtySnapshot` and its subsequent `rootDirty` / `artifactRoomDirty`
   * deltas. Old hosts and a new cycle before that snapshot both remain
   * `unknown`; neither may be treated as clean.
   */
  readonly hostDirtyState: EpicHostDirtyState;
  /**
   * Input 5 - the renderer's own replicas (root doc + artifact-room replicas)
   * diverging from what the host has confirmed. Subsumes the store's
   * `hasDirtyArtifactRoomReplicas()`, which is folded into `isDirty` by
   * `resolvePublicDirtyState`.
   */
  readonly hasUnsyncedLocalChanges: boolean;
  /**
   * Presentation qualifier on input 1, not a sixth leg: latched by the first
   * genuine cloud `connected` frame so a first-time bootstrap reads
   * "Connecting…" while a drop after a real connect reads "Reconnecting…".
   */
  readonly hasConnectedOnce: boolean;
  /**
   * Input 7 - where the host says the epic is durable (`epic.subscribe@1.5`).
   *
   * `undefined` is NOT "fine". At `@1.4` an absent key means unknown, and the
   * pill's calm claim has to be licensed by a positive statement - see
   * {@link syncedClaimIsHonest}.
   */
  readonly durability: EpicDurabilityStatusV15 | undefined;
  /**
   * Input 8 - whether this session has local WAL protection (`@1.4`).
   *
   * Doubles as the MINOR PROBE, deliberately and by construction: a `@1.4`
   * host emits this key on every `cloudSyncStatus` frame unconditionally, so
   * `undefined` identifies a peer on an older minor that cannot express any of
   * this. Such a peer keeps exactly its current rendering rather than being
   * degraded to unknown, which is what makes the whole minor additive.
   */
  readonly localProtection: EpicLocalProtection | undefined;
  /**
   * Whether the session's negotiated `epic.subscribe` minor speaks the
   * `@1.4` durability legs. The probe-by-presence above identifies a peer
   * that SENT the key; this identifies one that COULD have. The schema marks
   * every `@1.4` leg optional and an absent one means UNKNOWN, so an omission
   * from a negotiated-`@1.4` peer must stay indeterminate rather than taking
   * the legacy calm arm - the same handshake-over-frame-shape rule
   * `deriveEpicDurabilityView` applies.
   */
  readonly durabilityLegsNegotiated: boolean;
  /**
   * Input 9 - how the served document stands relative to the cloud (`@1.4`,
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
   * record of - and a pre-`@1.4` peer cannot send it at all.
   */
  readonly cloudFreshness: EpicCloudFreshness | undefined;
}

/**
 * Single source of the sync pill's claim.
 *
 * The ordering below is the honesty contract, and every ambiguous case
 * resolves toward no durability assertion:
 *
 * 1. GUI↔host link down wins over everything. We cannot see the host's cloud
 *    state, and any local edit is renderer-memory-only.
 * 2. Renderer-only work is `syncing`, never "saved locally". An `open`
 *    WebSocket proves neither that the host received the frame nor that it
 *    persisted it.
 * 3. An unknown cloud status or host-durability snapshot yields neutral
 *    `connected`, never `synced`.
 * 4. Link up + cloud up: `synced` requires a clean host snapshot and no local
 *    divergence. Host-reported pending work stays quiet as `hostPending`; the
 *    aggregate dirty bit does not prove whether the newest bytes are durable.
 * 5. Link up + cloud down: only known host-durable work with no renderer-only
 *    divergence may read "saved locally". With nothing outstanding the pill
 *    falls back to reporting the link.
 */
export function deriveEpicSyncPillState(
  inputs: EpicSyncPillInputs,
): EpicSyncPillState {
  if (inputs.hostTransportStatus === "closed") return "offline";
  if (inputs.hostTransportStatus !== "open") {
    return linkComingUpState(inputs.hasConnectedOnce);
  }
  if (inputs.hasUnsyncedLocalChanges) {
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
  if (syncedClaimIsHonest(inputs)) return "synced";
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
  // `@1.4` peer that omitted it is stating UNKNOWN per the schema's own
  // absence rule, and `storedLocally` is every bit as positive a claim as
  // `synced` - it tells the reader the bytes are on this disk.
  //
  // The negotiated check is what makes the rule uniform rather than what makes
  // it reachable: only a `@1.4` peer can send the `local` / `promoting`
  // durability this arm requires, so a pre-`@1.4` frame never arrives here at
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
 * - No `localProtection` at all means a pre-`@1.4` peer, which cannot express
 *   any of this. It keeps its exact current behaviour; degrading it to unknown
 *   would make this minor a breaking change for every older host.
 * - `durability: "cloud"` is the POSITIVE cloud-durable statement the `@1.4`
 *   enum now carries, and it is the ONLY durability value that licenses calm.
 *   An absent `durability` from a `@1.4` peer means UNKNOWN - the frame's own
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
    // A genuinely pre-`@1.4` peer keeps its legacy rendering. A negotiated
    // `@1.4` peer omitting the optional key falls through: absence is the
    // wire contract's UNKNOWN and cannot license the calm claim.
    return true;
  }
  return inputs.durability === "cloud";
}

function linkComingUpState(
  hasConnectedOnce: boolean,
): Extract<EpicSyncPillState, "connecting" | "reconnecting"> {
  return hasConnectedOnce ? "reconnecting" : "connecting";
}
