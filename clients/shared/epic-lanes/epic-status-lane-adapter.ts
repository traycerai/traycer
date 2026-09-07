/**
 * The `epic.status.subscribe@1.0` adapter - the control lane's decode half.
 * `null` means the host has not established dirtiness (a snapshot emitted before the epic is open, where nothing on disk can distinguish a seed carrying unsynced offline edits from a reconciled one).
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
   * The epoch this lane is currently stamped with, or `null` before the first snapshot.
   * Exposed here rather than derived from the records lane's cursor because a body may legitimately be attached before the records lane has produced any position at all.
   */
  observedAuthorityEpoch(): string | null;
}

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
   * The one fact that lets an epoch change be reported as `"migration-completed"` rather than as a bare `"authority-epoch-changed"`.
   */
  let migrationInFlight = false;
  /**
   * The security epoch observed under the current authority epoch, or `null` before the first frame that carried one.
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
   * Fold a `securityEpoch` observation, asking for a rebuild only on a genuine increase within one authority epoch.
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

  function foldAuthorityEpoch(authorityEpoch: string): void {
    const previous = observedEpoch;
    if (previous === authorityEpoch) return;
    observedEpoch = authorityEpoch;
    if (previous === null) return;
    // A replacement, and this lane is the only one that can say which kind.
    // The reason differs from what the records lane will call the very same transition - only this lane knows a migration was running - so the epoch is what identifies the occurrence to the runtime.
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
        // Both folds before any emit, and the second one used to sit in the middle of them.
        foldSecurityEpoch(frame.securityEpoch);
        // The boundary first, because it is what makes this cycle's answer authoritative and the facts below are that answer's contents.
        // The legacy arm never had to say it separately because one function (`applyRootSnapshot`) both landed the snapshot and adopted its role, so the boundary was implicit in the call.
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
        // Emitted only when established - see the module doc. `null` is the
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
        // The current-state projection of `epicDeleted`.
        // Without it a client reconnecting after a deletion - a persisted tab list, or a reconnect that raced the delete - would read a healthy session for an epic that no longer exists.
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
            // Before the emit, for the reason spelled out in `onSnapshot` - and this path is the worse half of that bug, not a second instance of it.
            foldSecurityEpoch(frame.securityEpoch);
            emit({
              kind: "permission-changed",
              role: frame.permissionRole,
              canWrite: isWritablePermissionRole(frame.permissionRole),
              securityEpoch: frame.securityEpoch,
            });
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
            // A plain boolean, and the first one after a null snapshot is what establishes the fact: a consumer sitting on `unknown` leaves that state here, not by timeout and not by assumption.
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
            // Terminal for the attempt, not for the lane.
            // The session stays alive so `epic.retryMigration` can reuse it, and the attempt is no longer in flight - so an epoch change after this one is an ordinary replacement rather than a completion.
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

    /** Always `null`. */
    resumeOffer(): ResumeOffer {
      return null;
    },

    observedAuthorityEpoch: () => observedEpoch,

    detach(_reason: AdapterDetachReason): void {
      guard.next();
      host = null;
      closeStreamClient();
      // Deliberately not cleared: `observedAuthorityEpoch` is what a body lane attaches under, and a detach that forgot it would make every reattach wait for a fresh snapshot before it could name a generation.
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
