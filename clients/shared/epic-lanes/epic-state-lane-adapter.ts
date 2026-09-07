/**
 * Resume cursor is the furthest applied point, never received. Strip `lane` on the wire resume and stamp it back on ingested cursors.
 * Do not enforce epoch here; the replica answers requires-replacement. Adapter acts only on snapshot basis and transport status.
 */
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  LaneAdapter,
  LaneCursor,
  RecordChange,
  RecordRow,
  ResumeOffer,
  SeedTrust,
} from "@traycer-clients/shared/replica-runtime";
import {
  authorityEpochTransition,
  createGenerationGuard,
  resumeTooOldTransition,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStateDeltaFrame,
  EpicStateResumedFrame,
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
  EpicStateTrustChangedFrame,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import {
  ARTIFACT_TOMBSTONE_REMOVE_REASON,
  COMMENT_THREAD_REMOVE_REASON,
  EPIC_META_ROW_ID,
  ROLE_CLAIMS_ROW_ID,
  artifactRowId,
  artifactTombstoneRowId,
  commentThreadRowId,
  type EpicStateRow,
} from "./epic-state-rows";
import { EPIC_STATE_LANE_ID, type EpicStateLaneEvent } from "./lane-events";

export interface EpicStateLaneStreamClient {
  close(): void;
}

export type EpicStateStreamClientFactory = (
  epicId: string,
  callbacks: EpicStateStreamCallbacks,
  /** Live read before every subscribe, including reconnect re-declare; never a captured value. */
  resumeProvider: () => EpicLaneCursor | null,
) => EpicStateLaneStreamClient;

const EPIC_STATE_DESCRIPTOR: AdapterDescriptor = {
  laneId: EPIC_STATE_LANE_ID,
  kind: "lane",
  label: "epic.state.subscribe@1.0 (records lane)",
};

export interface EpicStateLaneAdapterSources {
  readonly epicId: string;
  readonly streamClientFactory: EpicStateStreamClientFactory;
  /** Furthest applied point, or null. Pure and synchronous; invoked immediately before every wire subscribe. */
  readonly readAppliedCursor: () => LaneCursor | null;
  readonly isDisposed: () => boolean;
}

export interface EpicStateLaneAdapter extends LaneAdapter<EpicStateLaneEvent> {
  /** Close the socket and keep the host binding. Close before discard and open after so resume does not name discarded state. */
  closeTransport(): void;
  openTransport(): void;
}

export function createEpicStateLaneAdapter(
  sources: EpicStateLaneAdapterSources,
): EpicStateLaneAdapter {
  const { epicId, streamClientFactory, readAppliedCursor, isDisposed } =
    sources;

  const guard = createGenerationGuard();
  let host: AdapterHost<EpicStateLaneEvent> | null = null;
  let client: EpicStateLaneStreamClient | null = null;
  let leadDelivered = false;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  /** One generation guard; a superseded socket must not write into the live replica. */
  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  function cursorAt(authorityEpoch: string, position: number): LaneCursor {
    return { authorityEpoch, lane: EPIC_STATE_LANE_ID, position };
  }

  /** `false` is seed-ahead-of-cloud, not an error. Named state so `null` (cannot tell) is not collapsed into a boolean. */
  function trustOf(reconciledWithCloud: boolean): SeedTrust {
    return reconciledWithCloud ? "reconciled-with-cloud" : "seed-only";
  }

  function currentOffer(): ResumeOffer {
    const cursor = readAppliedCursor();
    if (cursor === null) return null;
    if (cursor.lane !== EPIC_STATE_LANE_ID) {
      // Wrong-lane cursor: offer nothing rather than resume from another cursor domain.
      return null;
    }
    return { kind: "cursor", cursor };
  }

  function wireResume(): EpicLaneCursor | null {
    const offer = currentOffer();
    if (offer === null || offer.kind !== "cursor") return null;
    return {
      authorityEpoch: offer.cursor.authorityEpoch,
      position: offer.cursor.position,
    };
  }

  function snapshotRows(
    frame: EpicStateSnapshotFrame,
  ): readonly RecordRow<EpicStateRow>[] {
    const rows: RecordRow<EpicStateRow>[] = [];
    for (const record of frame.artifactRecords) {
      rows.push({
        rowId: artifactRowId(record.id),
        revision: record.revision,
        row: { kind: "artifact", record },
      });
    }
    for (const record of frame.deletedArtifacts) {
      rows.push({
        rowId: artifactTombstoneRowId(record.id),
        revision: record.revision,
        row: { kind: "artifact-tombstone", record },
      });
    }
    for (const record of frame.commentThreads) {
      rows.push({
        rowId: commentThreadRowId(record.artifactId, record.threadId),
        revision: record.revision,
        row: { kind: "comment-thread", record },
      });
    }
    // Always emit the claims row, even empty, so a replacement cannot leave a stale set renderable.
    rows.push({
      rowId: ROLE_CLAIMS_ROW_ID,
      revision: frame.roleClaims.revision,
      row: { kind: "role-claims", claims: frame.roleClaims.claims },
    });
    // Whole here, patch on a delta - see `EpicStateRow`.
    rows.push({
      rowId: EPIC_META_ROW_ID,
      revision: frame.epicMeta.revision,
      row: { kind: "epic-meta", meta: frame.epicMeta.meta },
    });
    return rows;
  }

  function deltaChanges(
    frame: EpicStateDeltaFrame,
  ): readonly RecordChange<EpicStateRow>[] {
    const changes: RecordChange<EpicStateRow>[] = [];
    for (const record of frame.artifactUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: artifactRowId(record.id),
          revision: record.revision,
          row: { kind: "artifact", record },
        },
      });
    }
    for (const record of frame.artifactTombstones) {
      // Both halves of one tombstone, in one envelope: the live row goes away terminally, and the deleted-artifact affordance keeps its payload.
      changes.push({
        kind: "remove",
        rowId: artifactRowId(record.id),
        revision: record.revision,
        reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
      });
      changes.push({
        kind: "upsert",
        row: {
          rowId: artifactTombstoneRowId(record.id),
          revision: record.revision,
          row: { kind: "artifact-tombstone", record },
        },
      });
    }
    for (const record of frame.commentThreadUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: commentThreadRowId(record.artifactId, record.threadId),
          revision: record.revision,
          row: { kind: "comment-thread", record },
        },
      });
    }
    for (const removal of frame.commentThreadRemovals) {
      changes.push({
        kind: "remove",
        rowId: commentThreadRowId(removal.artifactId, removal.threadId),
        revision: removal.revision,
        reason: COMMENT_THREAD_REMOVE_REASON,
      });
    }
    const roleClaims = frame.roleClaims;
    if (roleClaims !== null) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: ROLE_CLAIMS_ROW_ID,
          revision: roleClaims.revision,
          row: { kind: "role-claims", claims: roleClaims.claims },
        },
      });
    }
    const epicMeta = frame.epicMeta;
    if (epicMeta !== null) {
      // A patch row, not a whole one: `meta` here carries only the fields this commit changed, and a consumer that replaced with it would drop the field the host deliberately did not restate.
      changes.push({
        kind: "upsert",
        row: {
          rowId: EPIC_META_ROW_ID,
          revision: epicMeta.revision,
          row: { kind: "epic-meta-patch", meta: epicMeta.meta },
        },
      });
    }
    return changes;
  }

  function buildCallbacks(generation: number): EpicStateStreamCallbacks {
    const emit = (event: EpicStateLaneEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onSnapshot: (frame: EpicStateSnapshotFrame) => {
        if (!accepts(generation)) return;
        const watermark = cursorAt(frame.authorityEpoch, frame.position);
        // Report resume before rows: a reseeded outcome must be visible even if the snapshot is byte-identical.
        host?.reportResume({
          kind: "reseeded",
          reason:
            frame.basis === "cold"
              ? "no-offer"
              : frame.basis === "resumeTooOld"
                ? "resume-too-old"
                : "epoch-changed",
          // High-water mark is on the snapshot; a quiet epic may never send a delta.
          watermark,
        });
        // Only failure bases rebuild. `resumeTooOld` keeps identity; `authorityEpochChanged` voids bodies too. `cold` asks for nothing.
        if (frame.basis === "resumeTooOld") {
          host?.requestReplacement(
            "resume-too-old",
            resumeTooOldTransition(`${frame.authorityEpoch}/${frame.position}`),
          );
        } else if (frame.basis === "authorityEpochChanged") {
          // The epoch this lane is now serving, which is the same string the status lane folds for the same transition - so the runtime sees one occurrence reported twice rather than two.
          host?.requestReplacement(
            "authority-epoch-changed",
            authorityEpochTransition(frame.authorityEpoch),
          );
        }
        emit({
          kind: "record-snapshot",
          watermark,
          rows: snapshotRows(frame),
          trust: trustOf(frame.reconciledWithCloud),
          cause: leadDelivered ? "reseed" : "initial",
        });
        leadDelivered = true;
      },
      onResumed: (frame: EpicStateResumedFrame) => {
        if (!accepts(generation)) return;
        // The acknowledgement exists so that "your cursor was accepted and nothing has happened since" is a statement rather than an absence.
        host?.reportResume({
          kind: "resumed",
          from: cursorAt(frame.authorityEpoch, frame.position),
        });
        // Trust is not carried across resume; it describes the serving host's replica, which may have restarted seed-only.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
        leadDelivered = true;
      },
      onDelta: (frame: EpicStateDeltaFrame) => {
        if (!accepts(generation)) return;
        // Contract refuses an empty delta; every change field maps to a row here.
        emit({
          kind: "record-transaction",
          cursor: cursorAt(frame.authorityEpoch, frame.seq),
          changes: deltaChanges(frame),
          // Cross-lane atomicity is exceptional and must be named.
          barrier: null,
        });
      },
      onTrustChanged: (frame: EpicStateTrustChangedFrame) => {
        // Empty reconcile still exists so a seed-served client does not stay labeled stale.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
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
    client = streamClientFactory(
      epicId,
      buildCallbacks(generation),
      wireResume,
    );
  }

  return {
    descriptor: EPIC_STATE_DESCRIPTOR,

    attach(nextHost: AdapterHost<EpicStateLaneEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    resumeOffer: currentOffer,

    detach(_reason: AdapterDetachReason): void {
      // Retire the generation first: `close()` can synchronously deliver a final status frame, and a frame stamped with a generation the guard has already moved past is inert by construction rather than by luck.
      guard.next();
      host = null;
      leadDelivered = false;
      closeStreamClient();
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
