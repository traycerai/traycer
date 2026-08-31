/**
 * The vocabulary the epic adapters decode INTO and the epic replicas apply.
 *
 * This is the seam the `openStreamClient` callback block used to have none of.
 * Each of its thirty-odd callbacks applied bytes, sent a wire response, mutated
 * closure transport flags AND wrote UI state - including modal and
 * editor-rebind signals - in one function body. Untangling that into
 * decode-then-emit is what makes a captured frame log replayable through the
 * real replicas with no host attached, and it is what lets the `@1` legacy arm
 * and the decomposed lane adapters be indistinguishable to the projection layer
 * on identical epic content.
 *
 * ## Why these are not `replica-events.ts`'s envelopes verbatim
 *
 * They mirror the shapes of the shared envelopes without instantiating
 * them. Four members of the `@1` contract do not fit and are modelled here
 * rather than forced:
 *
 *  - **No doc guid.** `DocSnapshotEvent` requires `docGuid`, the authority's
 *    identity for a doc instance, so a deleted-and-recreated artifact reseeds
 *    instead of splicing two histories. `epic.subscribe@1` carries no such id
 *    on either the root or an artifact-room frame. Fabricating one would make a
 *    guard that cannot fire look like a guard that passed.
 *  - **Room state vectors are required, not nullable.** Every `@1` room frame
 *    carries `hostArtifactRoomStateVectorBase64`, and the whole per-room dirty
 *    watermark rests on it. Widening it to `string | null` here would push a
 *    null check into arithmetic that has never had to make one.
 *  - **The root frame carries `SnapshotMetaEpic`.** Permission role, room id
 *    and `seededFromOffer` ride the snapshot on this line; they are not a
 *    record row and not a cursor.
 *  - **No authority epoch on anything.** The shared doc events address every
 *    frame by `authorityEpoch`, which is replica identity. `@1` has no epoch,
 *    so there is nothing truthful to address with.
 *
 * When `epic.state.subscribe` lands, its adapter decodes into
 * `RecordSnapshotEvent` / `RecordTransactionEvent` proper and this union gains
 * nothing - the replicas are what stay.
 */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicCloudSyncStatus,
  EpicMigrationPhase,
} from "@traycer/protocol/host/epic/subscribe";
import type {
  EarlyMetaEpic,
  SnapshotMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  EpicArtifactRoomDirtySnapshot,
  EpicDeletedAttribution,
} from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { DocSeedMode } from "@traycer-clients/shared/replica-runtime";
import type { EpicArtifactRoomAvailability } from "../types";

// ─── Root plane ───────────────────────────────────────────────────────────

/**
 * The root epic replica's inbound events.
 *
 * Class `"records"` in the taxonomy even though the `@1` arm delivers them as
 * CRDT bytes: what the projector builds out of this doc is the artifact index,
 * the chat and terminal rows, the role claims and the epic header - server
 * arbitrated rows, every one. The doc is the transport for them on this line,
 * not the application state model, which is exactly why it can become an
 * adapter-internal detail later without the projection layer noticing.
 */
export type EpicRootEvent =
  | {
      readonly kind: "root-snapshot";
      /**
       * `meta.seededFromOffer === true` means {@link update} is a DELTA against
       * the state vector this client offered, not a self-sufficient snapshot.
       * Both apply with the same `Y.applyUpdate`, so the distinction constrains
       * WHICH DOC, never how - see the replica's host-coverage handling.
       */
      readonly meta: SnapshotMetaEpic;
      readonly update: Uint8Array;
    }
  | { readonly kind: "root-update"; readonly update: Uint8Array }
  /**
   * Root presence. Ephemeral by class: never cursored, never replayed. The
   * root `Awareness` never leaves the store today and collaboration carets bind
   * the artifact-room awareness instead, so this arm exists to keep the
   * existing channel intact, not because anything renders from it.
   */
  | { readonly kind: "root-awareness"; readonly frame: Uint8Array };

// ─── Artifact-body doc plane ──────────────────────────────────────────────

/**
 * One artifact room's inbound events, addressed by `artifactRoomId`.
 *
 * Doc class proper: payloads are opaque encoded bytes, and the live `Y.Doc`
 * behind them is materialised only under a lease. Tiptap/y-prosemirror binds
 * `Y.Doc` / `XmlFragment` / `Awareness` by reference, synchronously, so a room
 * with a bound editor stays on the main thread and the lease is that boundary.
 */
export type EpicRoomEvent =
  /**
   * A whole body, with the arm's own account of what it is.
   *
   * `seed` and `docGuid` are stated by the ARM rather than defaulted here,
   * which is what lets one rooms replica serve both. The `@1` line has no
   * offer protocol and no doc identity, so it says `"full"` and `null` - and
   * saying so explicitly is the point: the tier's replace rule then reads a
   * value the adapter asserted, not one this type invented on its behalf.
   *
   * `hostStateVectorBase64` is nullable for the same reason it is on the seam:
   * a body can arrive without a watermark, and that is a fact to represent
   * rather than a field to fill in with `""`.
   */
  | {
      readonly kind: "room-snapshot";
      readonly artifactRoomId: string;
      readonly update: Uint8Array;
      readonly hostStateVectorBase64: string | null;
      readonly seed: DocSeedMode;
      readonly docGuid: string | null;
    }
  | {
      readonly kind: "room-update";
      readonly artifactRoomId: string;
      readonly update: Uint8Array;
      /**
       * The host-side room state AFTER applying {@link update}, or `null` on an
       * arm that does not state one.
       *
       * `@1` rides this on every update, which is how that arm retires local
       * divergence. The body lane does not: `doc-update` describes what OTHERS
       * wrote and carries no vector, and what this client pushed is answered
       * separately by `room-coverage`. Defaulting this to `""` for the lane
       * would read as "the host has nothing", which is the one claim that
       * silently un-retires a body's dirty mark.
       */
      readonly hostStateVectorBase64: string | null;
    }
  /**
   * How much of what THIS client pushed the authority now holds.
   *
   * Only the body lane emits it - `@1` folds the same fact into every update's
   * post-apply vector - and it exists because without it a lane-served body
   * would read as permanently unsynced after a successful push: there would be
   * no event on which its divergence could ever be retired.
   */
  | {
      readonly kind: "room-coverage";
      readonly artifactRoomId: string;
      readonly coverageStateVectorBase64: string;
    }
  | {
      readonly kind: "room-awareness";
      readonly artifactRoomId: string;
      readonly frame: Uint8Array;
    }
  /**
   * A room's availability transition, as ONE tri-state value.
   *
   * The protocol's own type rather than the shared seam's doc events, and the
   * reason is the same one the rest of this file is built on. The seam models
   * availability as two separate events (ready / unavailable-with-a-code), each
   * addressed by `authorityEpoch` and `docGuid`. `epic.subscribe@1` has none of
   * those: it emits one frame carrying one of three values, on first
   * observation and on every transition, and the projection stores exactly that
   * value. Restating it as two events would invent a distinction the wire does
   * not draw, and both would then have to carry an epoch this line has no
   * concept of.
   */
  | {
      readonly kind: "room-availability";
      readonly artifactRoomId: string;
      readonly availability: EpicArtifactRoomAvailability;
    };

// ─── Control plane ────────────────────────────────────────────────────────

/**
 * Migration phases as the `@1` line reports them.
 *
 * Deliberately NOT the shared `MigrationPhase`: that one's `completed` arm
 * carries the `authorityEpoch` both lanes resume from, and `@1` has no epoch to
 * carry. On this line a migration completes by the snapshot simply landing,
 * which is why `"idle"` is what the snapshot handler returns the slice to
 * rather than a frame of its own.
 */
export type EpicMigrationEvent =
  | { readonly phase: "started" }
  | {
      readonly phase: "progress";
      readonly step: EpicMigrationPhase;
      readonly chunksDone: number;
      readonly chunksTotal: number;
    }
  | { readonly phase: "failed"; readonly reason: string }
  | { readonly phase: "not-allowed" };

/**
 * Control-plane facts. Records with barrier semantics on an urgent lane, kept
 * as their own union because their consumers - the session shell, the sync
 * indicator, the mutation gate - are not the consumers of the record planes.
 */
export type EpicControlEvent =
  /**
   * The metadata-only frame that lands before the snapshot. Populates
   * workspace-derived UI at ~200 ms. Deliberately does NOT establish the
   * write-gating role: the early `permissionRole` is the host's projection of
   * cloud `epic.permission.role` and can disagree with the snapshot-derived one
   * (which factors in team memberships), so letting it flip the gate would fail
   * closed for a team-derived owner and fail open for a stale-cached editor.
   */
  | { readonly kind: "early-meta"; readonly meta: EarlyMetaEpic }
  | {
      readonly kind: "permission-changed";
      readonly role: PermissionRole | null;
    }
  /**
   * The lane arm's counterpart of `applyRootSnapshot`'s role adoption: this
   * subscription cycle now holds a complete, authoritative control answer.
   *
   * `@1` needs no such event because its root snapshot IS a frame the runtime
   * routes, so one function adopts the role and lands the snapshot together.
   * The lanes flatten their snapshot into ordinary facts, so the boundary has
   * to travel as its own event or the freshness latch never closes.
   */
  | {
      readonly kind: "control-snapshot";
      readonly role: PermissionRole | null;
    }
  | { readonly kind: "cloud-sync-status"; readonly status: EpicCloudSyncStatus }
  /**
   * The atomic `@1.1` baseline for this subscription cycle. Its ARRIVAL, not
   * the order of individual deltas, is what makes host dirtiness known:
   * pre-snapshot silence means unknown, never clean.
   */
  | {
      readonly kind: "dirty-snapshot";
      readonly rootDirty: boolean;
      readonly rooms: readonly EpicArtifactRoomDirtySnapshot[];
    }
  | { readonly kind: "root-dirty"; readonly dirty: boolean }
  | {
      readonly kind: "room-dirty";
      readonly artifactRoomId: string;
      readonly dirty: boolean;
    }
  | {
      readonly kind: "epic-deleted";
      readonly attribution: EpicDeletedAttribution;
    }
  | { readonly kind: "migration"; readonly migration: EpicMigrationEvent }
  /**
   * The transport moved. Reported by the adapter through
   * `AdapterHost.reportStatus` and routed here by the runtime, because what
   * follows a close is a policy decision (migration-error modal vs snapshot
   * error vs auth recovery) and policy belongs to the replica, not to the
   * component that noticed the socket.
   */
  | {
      readonly kind: "transport-status";
      readonly status: StreamConnectionStatus;
      readonly reason: StreamCloseReason | null;
      /**
       * Whether this transition opens and closes the CONTROL SNAPSHOT CYCLE -
       * true for every socket that carries the control snapshot itself, false
       * for a lane that merely rides alongside one.
       *
       * `@1` has one socket and answers `true`. The lane arm has two that open
       * independently, and only the status lane serves `control-snapshot`; the
       * records lane forwards its status here as well, because the close
       * POLICY above is genuinely shared. Without this discriminator that
       * forwarding also cleared `hasFreshRootSnapshotForOpenCycle`, whose only
       * writer to `true` is a control snapshot - so a records lane that opened
       * late or reconnected alone closed the write gate with nothing left that
       * would ever reopen it, and every queued write was refused for the rest
       * of the connection.
       */
      readonly ownsControlCycle: boolean;
    };

// ─── The adapter's emit type ──────────────────────────────────────────────

/**
 * One decoded frame, tagged with the plane that owns it.
 *
 * An adapter emits into a single-typed `emit`, and the epic's `@1` line feeds
 * three planes from one socket, so the plane tag IS the routing decision - made
 * once by the component that knows the wire, rather than re-derived by every
 * consumer from the event's shape. When the lanes decompose, each lane adapter
 * emits one arm of this and the tag becomes redundant rather than wrong.
 */
export type EpicRuntimeEvent =
  | { readonly plane: "root"; readonly event: EpicRootEvent }
  | { readonly plane: "rooms"; readonly event: EpicRoomEvent }
  | { readonly plane: "control"; readonly event: EpicControlEvent };

// ─── Outbound ─────────────────────────────────────────────────────────────

/**
 * The outbound half of the `@1` lane.
 *
 * Split from the adapter's inbound decode for the reason the shared
 * `LaneRequester` is split from `LaneAdapter`: read-only lanes are the
 * majority, and a `send` they must stub is a method someone will eventually
 * call.
 *
 * The QUEUEING decision is deliberately not here. A plane knows whether its own
 * unsent bytes must be retained (root updates and room body edits) or may be
 * dropped (awareness, which is fire-and-forget and whose loss CRDT convergence
 * absorbs), and it decides before it calls `send`. The outcome reports what the
 * transport did with a frame the plane already decided to hand over.
 */
export type EpicOutboundRequest =
  | { readonly kind: "root-update"; readonly update: Uint8Array }
  | { readonly kind: "root-awareness"; readonly frame: Uint8Array }
  | {
      readonly kind: "room-update";
      readonly artifactRoomId: string;
      readonly update: Uint8Array;
    }
  | {
      readonly kind: "room-awareness";
      readonly artifactRoomId: string;
      readonly frame: Uint8Array;
    }
  | { readonly kind: "retry-migration" };
