/**
 * The status lane's `ControlEvent` in the `@1` control replica's vocabulary.
 *
 * The control replica is not rewritten for the cutover, and deliberately: it
 * holds the migration modal's state machine, the access-lost latch, the
 * transport-status policy and the freshness latches, all of which are identical
 * on both arms. What differs is only the WORDS the two wires use, so the lane
 * arm translates at its boundary and the replica keeps its single
 * implementation. A second control replica would be a second answer to "is this
 * epic writable".
 *
 * Three of the five arms are shape-identical and the mapping is a rename. The
 * two that are not are the two worth reading.
 *
 * ## `permission-changed`: the seam widened the role, so this narrows it back
 *
 * The wire types `permissionRole` as `PermissionRole | null`; the shared
 * `ControlEvent` widens it to `string | null` because the seam is generic over
 * adapters that may speak other vocabularies. The `@1` replica needs the
 * narrow type, and the only honest way back is to parse it - so an
 * unrecognised role becomes `null`, which is "the host cannot attribute a
 * role", NOT "no access".
 *
 * That direction is load-bearing. `isWritablePermissionRole` is an INCLUSION
 * test over the two writable roles, so `null` is unwritable - which agrees with
 * the `canWrite` the adapter already computed fail-closed for the same
 * unrecognised value. The two must agree, because only one of them survives
 * this translation: the replica recomputes writability from the role, and
 * `canWrite` is dropped. A narrowing that widened here (mapping an unknown role
 * onto `"editor"`, say) would grant write access the adapter had refused.
 *
 * ## `aggregate-dirty`: one boolean, and the per-room map is EMPTY by design
 *
 * `@1` carries dirtiness three ways - an atomic `dirtySnapshot` baseline, plus
 * `rootDirty` and per-room deltas - and only the atomic snapshot may ESTABLISH
 * the fact (a delta cannot prove the subscription has seen every room). The
 * lane carries ONE aggregate boolean owned by the authority, root OR any room,
 * and the contract says pre-snapshot silence means unknown.
 *
 * So an `aggregate-dirty` maps onto the atomic arm, not the delta arm: it is
 * the authority's complete answer, so it establishes. Its `rooms` list is empty
 * and that is a true statement rather than a stub - the lane aggregates rooms
 * into the boolean, so per-room detail is not merely unavailable here, it does
 * not exist on this wire. Downstream, `selectHostDirtyState` ORs the root flag
 * with the room map, and an empty map leaves the aggregate as the answer.
 *
 * The lane's `dirty: null` never reaches this function: the status adapter
 * emits nothing at all for a not-established snapshot, precisely so that
 * pre-snapshot silence and an in-band "cannot answer yet" collapse onto the
 * consumer's `unknown` rather than onto a synthesised `false`.
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

/**
 * The wire's role, or `null` when it is not one this build recognises.
 *
 * Parsed rather than cast. A cast would make an unrecognised role read as a
 * recognised one to every downstream consumer, including the write gate.
 */
function narrowPermissionRole(role: string | null): PermissionRole | null {
  if (role === null) return null;
  const parsed = LatestPermissionRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}

/**
 * The wire's cloud-sync status, or the honest fallback.
 *
 * `"disconnected"` rather than `"connected"` for an unrecognised value: the
 * status feeds a freshness claim, and a default that reads as connected is the
 * false-clean direction this whole plane exists to forbid.
 */
function narrowCloudSyncStatus(status: string): EpicCloudSyncStatus {
  if (status === "connected" || status === "reconnecting") return status;
  return "disconnected";
}

/**
 * The seam's migration lifecycle in the `@1` line's words.
 *
 * `MigrationStage` and `EpicMigrationPhase` are the same three members
 * (`prepare` / `upload` / `finalize`), so the progress arm is a rename. The
 * lifecycle discriminants differ on purpose - the wire calls the STAGE `phase`
 * and the seam calls the LIFECYCLE `status` - and this is the boundary where
 * that difference is resolved rather than allowed to give one word two
 * meanings.
 *
 * There is no `completed` member on either side: a finished migration is an
 * authority-epoch change, which reaches the runtime as a replacement rather
 * than as an event on this lane.
 */
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
 * Translate one lane control event. Total: every arm of `ControlEvent` maps,
 * so a member added to the seam is a compile error here rather than an event
 * the lane arm silently drops.
 */
export function legacyControlEventOf(event: ControlEvent): EpicControlEvent {
  switch (event.kind) {
    case "permission-changed":
      return {
        kind: "permission-changed",
        role: narrowPermissionRole(event.role),
      };
    case "control-snapshot-complete":
      // Narrowed by the SAME parser as `permission-changed`, and that matters
      // more here than there: this is the role the write gate adopts for the
      // cycle, so an unrecognised role must reach it as `null` - unwritable -
      // rather than as anything this build could mistake for an editor.
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
      // The ATOMIC arm, not the delta arm - see the module doc. This is the
      // authority's complete answer, so it establishes the fact, and its empty
      // room list is a true statement about a wire that has no per-room detail.
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
