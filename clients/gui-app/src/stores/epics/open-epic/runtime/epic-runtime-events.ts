/** The vocabulary the epic adapters decode INTO and the epic replicas apply. */
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

/** The root epic replica's inbound events. */
export type EpicRootEvent =
  | {
      readonly kind: "root-snapshot";
      /**
       * `meta.seededFromOffer === true` means {@link update} is a DELTA against the state vector this
       * client offered, not a self-sufficient snapshot.
       */
      readonly meta: SnapshotMetaEpic;
      readonly update: Uint8Array;
    }
  | { readonly kind: "root-update"; readonly update: Uint8Array }
  /** Root presence. Ephemeral by class: never cursored, never replayed. */
  | { readonly kind: "root-awareness"; readonly frame: Uint8Array };

// ─── Artifact-body doc plane ──────────────────────────────────────────────

/**
 * One artifact room's inbound events, addressed by `artifactRoomId`. Doc class proper: payloads
 * are opaque encoded bytes, and the live `Y.Doc` behind them is materialised only under a lease.
 */
export type EpicRoomEvent =
  /**
   * A whole body, with the arm's own account of what it is. `seed` and `docGuid` are stated by the
   * ARM rather than defaulted here, which is what lets one rooms replica serve both.
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
       * The host-side room state AFTER applying {@link update}, or `null` on an arm that does not state
       * one. `@1` rides this on every update, which is how that arm retires local divergence.
       */
      readonly hostStateVectorBase64: string | null;
      /** The doc identity these bytes describe, or `null` on an arm that states none. */
      readonly docGuid: string | null;
    }
  /** How much of what THIS client pushed the authority now holds. */
  | {
      readonly kind: "room-coverage";
      readonly artifactRoomId: string;
      readonly coverageStateVectorBase64: string;
      /** The doc identity this coverage answers for, or `null` on an arm that states none. */
      readonly docGuid: string | null;
    }
  | {
      readonly kind: "room-awareness";
      readonly artifactRoomId: string;
      readonly frame: Uint8Array;
    }
  /**
   * A room's availability transition, as ONE tri-state value. The protocol's own type rather than
   * the shared seam's doc events, and the reason is the same one the rest of this file is built on.
   */
  | {
      readonly kind: "room-availability";
      readonly artifactRoomId: string;
      readonly availability: EpicArtifactRoomAvailability;
    };

// ─── Control plane ────────────────────────────────────────────────────────

/** Migration phases as the `@1` line reports them. */
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

/** Control-plane facts. */
export type EpicControlEvent =
  /**
   * The metadata-only frame that lands before the snapshot. Populates workspace-derived UI at ~200
   * ms.
   */
  | { readonly kind: "early-meta"; readonly meta: EarlyMetaEpic }
  | {
      readonly kind: "permission-changed";
      readonly role: PermissionRole | null;
    }
  /**
   * The lane arm's counterpart of `applyRootSnapshot`'s role adoption: this subscription cycle now
   * holds a complete, authoritative control answer.
   */
  | {
      readonly kind: "control-snapshot";
      readonly role: PermissionRole | null;
    }
  | { readonly kind: "cloud-sync-status"; readonly status: EpicCloudSyncStatus }
  /**
   * The atomic `@1.1` baseline for this subscription cycle. Its ARRIVAL, not the order of individual
   * deltas, is what makes host dirtiness known: pre-snapshot silence means unknown, never clean.
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
  /** The transport moved. */
  | {
      readonly kind: "transport-status";
      readonly status: StreamConnectionStatus;
      readonly reason: StreamCloseReason | null;
      /**
       * Whether this transition opens and closes the CONTROL SNAPSHOT CYCLE - true for every socket that
       * carries the control snapshot itself, false for a lane that merely rides alongside one.
       */
      readonly ownsControlCycle: boolean;
      /** Whether the socket reporting this transition is the one that DELIVERS RECORD ROWS. */
      readonly carriesRecords: boolean;
    };

// ─── The adapter's emit type ──────────────────────────────────────────────

/** One decoded frame, tagged with the plane that owns it. */
export type EpicRuntimeEvent =
  | { readonly plane: "root"; readonly event: EpicRootEvent }
  | { readonly plane: "rooms"; readonly event: EpicRoomEvent }
  | { readonly plane: "control"; readonly event: EpicControlEvent };

// ─── Outbound ─────────────────────────────────────────────────────────────

/** The outbound half of the `@1` lane. */
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
