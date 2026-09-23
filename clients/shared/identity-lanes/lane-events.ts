/**
 * The lane ids, the one event arm the shared seam's envelopes could not express,
 * and the body lane's outbound request type, for the two adapters that decode
 * the `agentIdentity.*` streams.
 *
 * ## Why there is no plane-tagged union here
 *
 * Same answer `epic-lanes/lane-events.ts` gives: each lane is its own
 * subscription with its own adapter, its own cursor domain and its own event
 * type, so a tag would be a constant field every consumer would switch on and
 * never branch differently for. The decomposition IS the tag.
 *
 * ## Lane ids carry the identity, and `lane` never reaches the wire
 *
 * The cursor model is `(authorityEpoch, lane, position)`, but `lane` is NOT a
 * wire field: the lane is the METHOD, and each method is its own cursor domain.
 * The client-side `LaneCursor` carries `lane` anyway because the runtime holds
 * several lanes' cursors in one structure and needs to tell them apart - and a
 * session may hold two identities open at once, so the id has to name the
 * identity and not merely the method. The adapters STRIP `lane` when offering a
 * resume cursor and STAMP it back on ingest; both halves live in the index
 * adapter, which is the only identity lane with a positional cursor at `@1.0`.
 */
import type {
  LaneId,
  RecordReplicaEvent,
} from "@traycer-clients/shared/replica-runtime";
import type { AgentIdentityShardAvailability } from "@traycer/protocol/host/agent-identity/state-subscribe";
import type { IdentityStateRow } from "./identity-state-rows";

/**
 * The index lane's id - one per OPEN IDENTITY, not one per method.
 *
 * The wire method name verbatim including its major, then the identity. The
 * major is there for the reason the epic lane ids carry theirs: a client that
 * ever spoke two majors of this method would be holding two cursor domains, and
 * the id is what keeps them apart in one structure.
 */
export function identityStateLaneId(identityId: string): LaneId {
  return `agentIdentity.state.subscribe@1:${identityId}`;
}

/**
 * A body lane's id - one per OPEN FILE.
 *
 * JSON-encoded rather than `:`-joined, because this key is a PAIR of free-form
 * strings and a join is what aliases: an identity id and a path are both
 * `z.string()` on the wire, so `("a:b","c")` and `("a","b:c")` would collapse
 * onto one lane id. Two bodies sharing a lane id are indistinguishable in a log,
 * a replay capture or the runtime's own cursor structure. Only ever constructed
 * and compared, never parsed, so the encoding is free to change.
 */
export function identityFileLaneId(identityId: string, path: string): LaneId {
  return `agentIdentity.file.subscribe@1:${JSON.stringify([identityId, path])}`;
}

/**
 * Which of the identity's shard rooms the host can currently serve.
 *
 * A LANE-LOCAL arm, and the one fact on this lane the shared record envelopes
 * cannot carry. It is not a row: availability is a property of the host's
 * current connection state rather than of anything the identity holds, the wire
 * replaces the whole set on every change, and the frame that announces a change
 * carries no `seq` - so it can be neither a `record-transaction` (which requires
 * a cursor, and inventing one would advance a resume point past work no commit
 * did) nor part of a `record-snapshot`'s rows (which would make a shard flip
 * indistinguishable from a reseed).
 *
 * `record-trust` is the closest existing arm and is deliberately NOT reused:
 * trust says how much the host believes its own ROWS, and a shard being down
 * says nothing about the rows - it says a BODY cannot be opened. A client that
 * folded them would mark an identity's index stale because one skill's room is
 * reconnecting.
 *
 * Addressed by epoch so a consumer can drop one that arrives for a replica it
 * has already replaced, and cursored by nothing, for the reason `RecordTrustEvent`
 * gives at length.
 *
 * The consumer's obligation: a file whose shard is not `ready` opens READ-ONLY
 * and keeps the last bytes it wrote. An empty editor is the wrong render, because
 * it is the one a user will save over.
 */
export interface IdentityShardAvailabilityEvent {
  readonly kind: "identity-shard-availability";
  readonly authorityEpoch: string;
  /** The WHOLE set, always. Replace what is held; never merge. */
  readonly shards: readonly AgentIdentityShardAvailability[];
}

/**
 * Everything the index-lane adapter emits: the shared record envelopes
 * instantiated with this lane's row union, plus the shard arm above.
 *
 * `RecordPollAnswerEvent` is part of the shared union and is never emitted by
 * this adapter - `agentIdentity.list` answers a different question, about
 * identities rather than about one identity's rows - but it stays in the type
 * because splitting the union would force the replica this feeds to accept two.
 */
export type IdentityStateLaneEvent =
  | RecordReplicaEvent<IdentityStateRow>
  | IdentityShardAvailabilityEvent;

/**
 * The outbound half of an identity body lane.
 *
 * Structurally identical to `ArtifactLaneRequest` and deliberately NOT the same
 * type. The two body lanes are versioned separately and forever - that is the
 * wire contract's own wording - so a shared request type would make a change to
 * one lane's write surface compile against the other, which is precisely the
 * coupling the contracts refuse. The cost is one duplicated two-arm union; the
 * alternative costs a silent cross-family write.
 *
 * The QUEUEING decision is deliberately not here, for the reason the epic body
 * lane states: the plane knows whether its own unsent bytes must be retained (a
 * body edit) or may be dropped (awareness, which is fire-and-forget and whose
 * loss CRDT convergence absorbs), and it decides before it calls `send`.
 */
export type IdentityFileLaneRequest =
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
