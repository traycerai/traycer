/**
 * Unrecognised permission roles become null, not a writable role.
 * aggregate-dirty maps onto the atomic snapshot with an empty rooms map.
 */
import { LatestPermissionRoleSchema } from "@traycer/protocol/host/epic/unary-schemas";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type {
  ControlEvent,
  MigrationStatus,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicControlEvent,
  EpicMigrationEvent,
} from "./epic-runtime-events";

/** The wire's role, or `null` when it is not one this build recognises. Parsed rather than cast. */
function narrowPermissionRole(role: string | null): PermissionRole | null {
  if (role === null) return null;
  const parsed = LatestPermissionRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}

/** The wire's cloud-sync status, or the honest fallback. */
function narrowCloudSyncStatus(status: string): EpicCloudSyncStatus {
  if (status === "connected" || status === "reconnecting") return status;
  return "disconnected";
}

/** The seam's migration lifecycle in the `@1` line's words. */
function migrationEventOf(migration: MigrationStatus): EpicMigrationEvent {
  switch (migration.status) {
    case "started":
      return { phase: "started" };
    case "progress":
      return {
        phase: "progress",
        step: migration.stage,
        chunksDone: migration.chunksDone,
        chunksTotal: migration.chunksTotal,
      };
    case "failed":
      return { phase: "failed", reason: migration.reason };
    case "not-allowed":
      return { phase: "not-allowed" };
  }
}

/**
 * Translate one lane control event. Total: every arm of `ControlEvent` maps, so a member added to
 * the seam is a compile error here rather than an event the lane arm silently drops.
 */
export function legacyControlEventOf(event: ControlEvent): EpicControlEvent {
  switch (event.kind) {
    case "permission-changed":
      return {
        kind: "permission-changed",
        role: narrowPermissionRole(event.role),
      };
    case "control-snapshot-complete":
      // Narrowed by the SAME parser as `permission-changed`, and that matters more here than there: this
      // is the role the write gate adopts for the cycle, so an unrecognised role must reach it as `null`
      return {
        kind: "control-snapshot",
        role: narrowPermissionRole(event.role),
      };
    case "cloud-sync-status":
      return {
        kind: "cloud-sync-status",
        status: narrowCloudSyncStatus(event.status),
      };
    case "aggregate-dirty":
      // The ATOMIC arm, not the delta arm - see the module doc.
      return { kind: "dirty-snapshot", rootDirty: event.dirty, rooms: [] };
    case "epic-deleted":
      return {
        kind: "epic-deleted",
        attribution: {
          deletedByDisplayName: event.deletedByDisplayName,
          deletedByTraycerUserId: event.deletedByTraycerUserId,
        },
      };
    case "migration":
      return {
        kind: "migration",
        migration: migrationEventOf(event.migration),
      };
  }
}
