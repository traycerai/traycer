/**
 * The `epic.status.subscribe@1.0` adapter - the control lane's decode half.
 *
 * The urgent-delivery sibling of the records adapter. It carries the facts that
 * change what a client is ALLOWED or ABLE to do, and it is the lane that stays
 * alive precisely when the epic does not - a failed migration is reported here
 * INSTEAD of a fatal close, so the retry the modal drives has a channel to
 * arrive on.
 *
 * ## No resume cursor, so the snapshot has to be complete
 *
 * There is no cursor at `@1.0` and no delta log behind this lane: the whole
 * control state fits in one `snapshot`, and a client that missed transitions
 * while disconnected converges by reading the next snapshot rather than by
 * replaying them. The contract keeps that honest by requiring every
 * non-`snapshot` frame kind to have a current-state projection on the snapshot,
 * and this adapter's snapshot handler is the client-side half of that rule:
 * every transition kind it can emit, it also emits from a snapshot.
 *
 * The one asymmetry, and it is deliberate - the snapshot's `dirty` is
 * `boolean | null` while the transition's is a plain `boolean`. `null` means
 * the host has NOT ESTABLISHED dirtiness (a snapshot emitted before the epic is
 * open, where nothing on disk can distinguish a seed carrying unsynced offline
 * edits from a reconciled one). The seam's `aggregate-dirty` event carries a
 * boolean and has no third state, so a `null` snapshot emits NO dirty event at
 * all: pre-snapshot silence and an in-band "not established" both map onto the
 * consumer's `unknown`, and the first `dirtyChanged` after a null snapshot is
 * what ESTABLISHES the fact. Synthesising `false` here would be the false-clean
 * claim the lane exists to forbid - "all changes synced" over work the cloud
 * has never seen.
 *
 * ## The two replacement reasons only this lane can name
 *
 * The records lane learns of a replica replacement from its snapshot `basis`.
 * This lane learns of it from the epoch stamp, and it knows one thing the
 * records lane does not: whether a migration was running when the epoch moved.
 * Completion is not an event on this lane - there is deliberately no
 * `completed` migration state, because a finished migration leaves the epic in
 * its ordinary condition under a NEW `authorityEpoch` - so
 * `"migration-completed"` is only expressible by remembering what the previous
 * epoch was doing. That is what this adapter remembers, and it is the whole of
 * its state.
 */
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  ControlEvent,
  LaneAdapter,
  MigrationStatus,
  ResumeOffer,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  authorityEpochTransition,
  createGenerationGuard,
  securityEpochTransition,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
  EpicStatusTransitionFrame,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicMigrationStatus } from "@traycer/protocol/host/epic/status-subscribe";
import { isWritablePermissionRole } from "@traycer-clients/shared/epic/permission-role";
import { EPIC_STATUS_LANE_ID } from "./lane-events";

/** The subset of the control lane's stream client this adapter drives. */
export interface EpicStatusLaneStreamClient {
  close(): void;
}

export type EpicStatusStreamClientFactory = (
  epicId: string,
  callbacks: EpicStatusStreamCallbacks,
) => EpicStatusLaneStreamClient;

const EPIC_STATUS_DESCRIPTOR: AdapterDescriptor = {
  laneId: EPIC_STATUS_LANE_ID,
  kind: "lane",
  label: "epic.status.subscribe@1.0 (control lane)",
};

export interface EpicStatusLaneAdapterSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: EpicStatusStreamClientFactory;
  readonly isDisposed: () => boolean;
}

export interface EpicStatusLaneAdapter extends LaneAdapter<ControlEvent> {
  /** See the records adapter: close before a local reseed, open after. */
  closeTransport(): void;
  openTransport(): void;
  /**
   * The epoch this lane is currently stamped with, or `null` before the first
   * snapshot.
   *
   * Read by the composition when it opens a body lane: `artifact.subscribe`
   * requires a non-null `authorityEpoch` on its open request, and an attach
   * made under an epoch the host is not serving is refused. Exposed here rather
   * than derived from the records lane's cursor because a body may legitimately
   * be attached before the records lane has produced any position at all.
   */
  observedAuthorityEpoch(): string | null;
}

/**
 * Translate the wire's migration status into the seam's.
 *
 * The two vocabularies are deliberately different words for different things:
 * the wire's `phase` is the STAGE inside a running migration (prepare, upload,
 * finalize) while the seam's `status` is the LIFECYCLE. Calling both `phase`
 * would give one word two meanings across exactly the boundary this function
 * is.
 *
 * A `running` status with no progress is `"started"` rather than a progress
 * event at `0 / 1`: the window between `migrationStarted` and the first
 * `migrationProgress` is real and a reconnect can land in it, and reporting a
 * determinate fraction the host has not measured is a claim nothing supports.
 */
function migrationStatusOf(wire: EpicMigrationStatus): MigrationStatus {
  switch (wire.state) {
    case "running": {
      const progress = wire.progress;
      if (progress === null) return { status: "started" };
      return {
        status: "progress",
        stage: progress.phase,
        chunksDone: progress.chunksDone,
        chunksTotal: progress.chunksTotal,
      };
    }
    case "failed":
      return { status: "failed", reason: wire.reason };
    case "notAllowed":
      return { status: "not-allowed" };
  }
}

export function createEpicStatusLaneAdapter(
  sources: EpicStatusLaneAdapterSources,
): EpicStatusLaneAdapter {
  const { epicId, environment, streamClientFactory, isDisposed } = sources;

  const guard = createGenerationGuard();
  let host: AdapterHost<ControlEvent> | null = null;
  let client: EpicStatusLaneStreamClient | null = null;
  let observedEpoch: string | null = null;
  /**
   * Whether the epoch this lane last observed had a migration in flight.
   *
   * The one fact that lets an epoch change be reported as
   * `"migration-completed"` rather than as a bare `"authority-epoch-changed"`.
   * Set from the snapshot's `migration` projection and from the transition
   * frames alike, because a client that attached mid-migration never sees
   * `migrationStarted`.
   */
  let migrationInFlight = false;
  /**
   * The security epoch observed under the CURRENT authority epoch, or `null`
   * before the first frame that carried one. Reset on an authority-epoch
   * change: a new replica restates every field, and comparing across the
   * restatement would double-report one event.
   */
  let observedSecurityEpoch: number | null = null;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  /**
   * Fold a `securityEpoch` observation, asking for a rebuild only on a genuine
   * INCREASE within one authority epoch.
   *
   * The first observation establishes the value and asks for nothing - that is
   * the client learning where it stands, not authorization moving underneath
   * it. Requesting a replacement there would fire on every cold open, which is
   * both the most ordinary path and the one where a fabricated recovery request
   * is hardest to notice.
   */
  function foldSecurityEpoch(securityEpoch: number): void {
    const previous = observedSecurityEpoch;
    observedSecurityEpoch = securityEpoch;
    if (previous === null || securityEpoch <= previous) return;
    host?.requestReplacement(
      "security-epoch-changed",
      securityEpochTransition(securityEpoch),
    );
  }

  /**
   * Fold an epoch stamp, asking for a rebuild when the replica was replaced.
   *
   * Returns nothing: the caller goes on to emit the frame's own facts either
   * way, because the fresh snapshot that accompanies a replacement is exactly
   * what the rebuilt replica needs.
   */
  function foldAuthorityEpoch(authorityEpoch: string): void {
    const previous = observedEpoch;
    if (previous === authorityEpoch) return;
    observedEpoch = authorityEpoch;
    if (previous === null) return;
    // A replacement, and this lane is the only one that can say WHICH kind.
    // Completion is the epoch change; there is no completion event to read.
    //
    // The REASON differs from what the records lane will call the very same
    // transition - only this lane knows a migration was running - so the epoch
    // is what identifies the occurrence to the runtime. Keyed on the reason,
    // a completing migration could not be coalesced even in principle.
    host?.requestReplacement(
      migrationInFlight ? "migration-completed" : "authority-epoch-changed",
      authorityEpochTransition(authorityEpoch),
    );
    migrationInFlight = false;
    observedSecurityEpoch = null;
  }

  function buildCallbacks(generation: number): EpicStatusStreamCallbacks {
    const emit = (event: ControlEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onSnapshot: (frame: EpicStatusSnapshotFrame) => {
        if (!accepts(generation)) return;
        foldAuthorityEpoch(frame.authorityEpoch);
        // BOTH folds before any emit, and the second one used to sit in the
        // middle of them.
        //
        // A replacement request is synchronous and RESETS the runtime, so
        // whatever this handler has already emitted is erased by it. That is
        // harmless for the authority-epoch fold, which has always run first;
        // it was not harmless for the security-epoch one. A snapshot under an
        // unchanged authority epoch carrying a HIGHER `securityEpoch` emitted
        // `control-snapshot-complete` and the permission, then requested the
        // replacement - which cleared the very role and freshness gate those
        // two had just established. Nothing below re-emits either, so writes
        // were refused for the rest of the session, until some later status
        // snapshot happened to arrive.
        //
        // Ordered after `foldAuthorityEpoch`, not before: that fold clears
        // `observedSecurityEpoch` on an authority change, so running it first
        // is what makes the new epoch's first security value an ESTABLISHING
        // observation rather than a comparison against the old epoch's.
        foldSecurityEpoch(frame.securityEpoch);
        // The BOUNDARY first, because it is what makes this cycle's answer
        // authoritative and the facts below are that answer's contents.
        //
        // Flattening the snapshot into ordinary events - which the rest of this
        // handler does, deliberately - drops the fact that a snapshot happened
        // at all, and that fact is not recoverable downstream: a lane delta and
        // a lane snapshot arrive as the same event kinds. The legacy arm never
        // had to say it separately because ONE function
        // (`applyRootSnapshot`) both landed the snapshot and adopted its role,
        // so the boundary was implicit in the call. This lane has no such
        // function, and without this event the open cycle's freshness latch is
        // never set: every write is refused before dispatch and the reconnect
        // drain never runs, for the life of the session.
        emit({
          kind: "control-snapshot-complete",
          role: frame.permissionRole,
        });
        // Every field, restated, in the order a consumer needs them: the
        // permission verdict gates what the rest may do, so it lands first.
        emit({
          kind: "permission-changed",
          role: frame.permissionRole,
          canWrite: isWritablePermissionRole(frame.permissionRole),
          securityEpoch: frame.securityEpoch,
        });
        emit({
          kind: "cloud-sync-status",
          status: frame.cloudSyncStatus,
          observedAtMs: environment.clock.now(),
        });
        // Emitted only when ESTABLISHED - see the module doc. `null` is the
        // host stating it cannot answer yet, and there is no event for that.
        if (frame.dirty !== null) {
          emit({ kind: "aggregate-dirty", dirty: frame.dirty });
        }
        const migration = frame.migration;
        if (migration !== null) {
          migrationInFlight = migration.state === "running";
          emit({ kind: "migration", migration: migrationStatusOf(migration) });
        } else {
          migrationInFlight = false;
        }
        // The current-state projection of `epicDeleted`. Without it a client
        // reconnecting after a deletion - a persisted tab list, or a reconnect
        // that raced the delete - would read a healthy session for an epic
        // that no longer exists. `"unknown"` and `"none"` both emit nothing:
        // one is "cannot answer yet" and the other is established
        // not-deleted, and neither is an event.
        if (frame.deletion.state === "deleted") {
          emit({
            kind: "epic-deleted",
            deletedByDisplayName:
              frame.deletion.attribution.deletedByDisplayName,
            deletedByTraycerUserId:
              frame.deletion.attribution.deletedByTraycerUserId,
          });
        }
      },
      onTransition: (frame: EpicStatusTransitionFrame) => {
        if (!accepts(generation)) return;
        foldAuthorityEpoch(frame.authorityEpoch);
        switch (frame.kind) {
          case "permissionChanged": {
            emit({
              kind: "permission-changed",
              role: frame.permissionRole,
              canWrite: isWritablePermissionRole(frame.permissionRole),
              securityEpoch: frame.securityEpoch,
            });
            foldSecurityEpoch(frame.securityEpoch);
            return;
          }
          case "cloudSyncStatus": {
            emit({
              kind: "cloud-sync-status",
              status: frame.status,
              observedAtMs: environment.clock.now(),
            });
            return;
          }
          case "dirtyChanged": {
            // A plain boolean, and the first one after a null snapshot is what
            // establishes the fact: a consumer sitting on `unknown` leaves that
            // state here, not by timeout and not by assumption.
            emit({ kind: "aggregate-dirty", dirty: frame.dirty });
            return;
          }
          case "epicDeleted": {
            emit({
              kind: "epic-deleted",
              deletedByDisplayName: frame.attribution.deletedByDisplayName,
              deletedByTraycerUserId: frame.attribution.deletedByTraycerUserId,
            });
            return;
          }
          case "migrationStarted": {
            migrationInFlight = true;
            emit({ kind: "migration", migration: { status: "started" } });
            return;
          }
          case "migrationProgress": {
            migrationInFlight = true;
            emit({
              kind: "migration",
              migration: {
                status: "progress",
                stage: frame.phase,
                chunksDone: frame.chunksDone,
                chunksTotal: frame.chunksTotal,
              },
            });
            return;
          }
          case "migrationFailed": {
            // Terminal for the ATTEMPT, not for the lane. The session stays
            // alive so `epic.retryMigration` can reuse it, and the attempt is
            // no longer in flight - so an epoch change after this one is an
            // ordinary replacement rather than a completion.
            migrationInFlight = false;
            emit({
              kind: "migration",
              migration: { status: "failed", reason: frame.reason },
            });
            return;
          }
          case "migrationNotAllowed": {
            migrationInFlight = false;
            emit({
              kind: "migration",
              migration: { status: "not-allowed" },
            });
            return;
          }
        }
      },
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        host?.reportStatus({
          connection: status,
          closeReason: status === "closed" ? reason : null,
        });
      },
    };
  }

  function openStreamClient(): void {
    const generation = guard.next();
    client = streamClientFactory(epicId, buildCallbacks(generation));
  }

  return {
    descriptor: EPIC_STATUS_DESCRIPTOR,

    attach(nextHost: AdapterHost<ControlEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    /**
     * Always `null`. The lane has no cursor at `@1.0` and the honest answer is
     * the one that says so: its whole state is one snapshot frame, and a cursor
     * would promise a delta history no journal backs. A later additive minor
     * can add one once there is something to seek in.
     */
    resumeOffer(): ResumeOffer {
      return null;
    },

    observedAuthorityEpoch: () => observedEpoch,

    detach(_reason: AdapterDetachReason): void {
      guard.next();
      host = null;
      closeStreamClient();
      // Deliberately NOT cleared: `observedAuthorityEpoch` is what a body lane
      // attaches under, and a detach that forgot it would make every reattach
      // wait for a fresh snapshot before it could name a generation. The epoch
      // is a fact about the host's replica, not about this socket.
    },

    closeTransport(): void {
      guard.next();
      closeStreamClient();
    },

    openTransport(): void {
      openStreamClient();
    },
  };
}
