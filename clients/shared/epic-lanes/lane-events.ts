/**
 * The lane ids and the two event arms the shared seam's envelopes could not
 * express, for the three adapters that replace `epic.subscribe`.
 *
 * ## Why there is no plane-tagged union here
 *
 * The `@1` legacy adapter emits a plane-tagged union (`{plane, event}`) because
 * ONE socket feeds three planes and the tag is the routing decision, made once
 * by the component that knows the wire. The lanes have no such problem: each is
 * its own subscription with its own adapter, its own cursor domain and its own
 * event type, so a tag would be a constant field every consumer would have to
 * switch on and never branch differently for. The decomposition IS the tag.
 *
 * ## Lane ids, and why `lane` never reaches the wire
 *
 * The cursor model is `(authorityEpoch, lane, position)`, but `lane` is NOT a
 * wire field: the lane is the METHOD, and each method is its own cursor domain,
 * so there is nothing on the wire a consumer could be tempted to compare across
 * lanes. The client-side `LaneCursor` carries `lane` anyway because the runtime
 * holds several lanes' cursors in one structure and needs to tell them apart.
 *
 * The adapters therefore STRIP `lane` when offering a resume cursor and STAMP
 * it back on ingest. Both halves live in the state adapter, which is the only
 * lane with a positional cursor at `@1.0`.
 */
import type {
  LaneId,
  RecordReplicaEvent,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicStateRow } from "./epic-state-rows";

/**
 * The records lane's id. The wire method name verbatim, including its major:
 * a client that ever spoke two majors of this method would be holding two
 * cursor domains, and the id is what keeps them apart in one structure.
 */
export const EPIC_STATE_LANE_ID: LaneId = "epic.state.subscribe@1";

/** The control lane's id. Cursor-less at `@1.0`; the id still addresses it. */
export const EPIC_STATUS_LANE_ID: LaneId = "epic.status.subscribe@1";

/**
 * A body lane's id - one per ATTACHED ARTIFACT, not one per method.
 *
 * `artifact.subscribe` is opened per open tile, so a single session holds as
 * many of these as it has tiles open, and a lane id shared across them would
 * make two bodies' events indistinguishable in a log or a replay capture.
 */
export function artifactLaneId(artifactId: string): LaneId {
  return `artifact.subscribe@1:${artifactId}`;
}

/**
 * Everything the records-lane adapter emits: the shared record envelopes,
 * instantiated with this lane's row union and nothing else.
 *
 * All four populations the lane carries - artifacts and their tombstones,
 * comment threads, the role-claim set, and the epic's own metadata - are
 * revisioned rows, so every one of them fits `RecordRow` and none of them needs
 * an arm of its own. That was not true of an earlier cut of this contract,
 * where `epicMeta` travelled without a revision and had to ride a separate
 * event rather than be given a synthesised one; the wire now carries the
 * revision the host was already minting, and the special case is gone.
 *
 * `RecordPollAnswerEvent` is part of the shared union and is deliberately never
 * emitted BY THIS ADAPTER - a poll answer comes from a unary, not from the
 * lane - but it stays in the type because the replica this feeds is the same
 * one `epic.listCommentThreads` answers into, and splitting the union would
 * force that replica to accept two.
 */
export type EpicStateLaneEvent = RecordReplicaEvent<EpicStateRow>;

/**
 * The outbound half of a body lane.
 *
 * Split from the inbound decode for the reason the shared `LaneRequester` is
 * split from `LaneAdapter`: the two record lanes are read-only on the wire
 * (mutations ride the existing unaries with command ids), and a `send` they
 * must stub is a method someone will eventually call.
 *
 * The QUEUEING decision is deliberately not here. The plane knows whether its
 * own unsent bytes must be retained (a body edit) or may be dropped (awareness,
 * which is fire-and-forget and whose loss CRDT convergence absorbs), and it
 * decides before it calls `send`.
 */
export type ArtifactLaneRequest =
  | {
      readonly kind: "apply-update";
      /**
       * The generation guard on the WRITE path. A host that has reseeded this
       * body drops an update naming the old guid rather than merging it, so a
       * stale replica cannot resurrect content the reseed replaced.
       */
      readonly docGuid: string;
      readonly update: Uint8Array;
    }
  | { readonly kind: "awareness"; readonly frame: Uint8Array };
