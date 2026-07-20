import {
  defineRecordContract,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import { epicSchema } from "@traycer/protocol/persistence/_internal/epic-schemas";
import { roomMetadataSchema } from "@traycer/protocol/persistence/_internal/room-metadata-schemas";

/**
 * Traycer 3.0 persistence record protocol.
 *
 * Each entry describes the on-disk shape of a logical record type:
 *
 * - `epic` - the local on-disk epic document at V200. Legacy pre-V200
 *   shapes live as hand-rolled TS interfaces + migrations inside the host
 *   (the external Traycer Host); protocol keeps
 *   the current record authority aligned to the live V200 / 2.0.0 line
 *   instead of rebasing it to 1.0.
 * - `room-metadata` - Tiptap Cloud Yjs room metadata stored at
 *   `doc.getMap("meta")`. Lives independently of the epic record because
 *   clients read it before interpreting the rest of the room.
 *
 * Cloud-catalog / task-ref / workspace-association caches are owned by
 * the cloud data client (internal, not in this repo) and are NOT versioned
 * here. Phases were folded into epics in Traycer 3.0, so there is no
 * `phase-light` record here either.
 *
 * Compatibility rules and the frozen epic-schema review workflow live in
 * `COMPATIBILITY.md` beside this registry.
 */

export const epicRecordV200 = defineRecordContract({
  name: "epic",
  schemaVersion: { major: 2, minor: 0 } as const,
  schema: epicSchema,
});

export const roomMetadataRecordV100 = defineRecordContract({
  name: "room-metadata",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: roomMetadataSchema,
});

export const persistenceRecordRegistry = defineVersionedRecordRegistry({
  epic: {
    2: {
      latestMinor: 0,
      versions: {
        0: { contract: epicRecordV200, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "room-metadata": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: roomMetadataRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

export type PersistenceRecordRegistry = typeof persistenceRecordRegistry;

// Types via `RecordValue<>` so runtime + type stay in lock-step.

export type Epic = RecordValue<PersistenceRecordRegistry, "epic">;
export type RoomMetadata = RecordValue<
  PersistenceRecordRegistry,
  "room-metadata"
>;
