import { z } from "zod";
import {
  collaboratorRolesSchema,
  teamRolesSchema,
} from "@traycer/protocol/persistence/epic/room-metadata-schemas";

/**
 * Private Zod value for the `room-metadata` record.
 *
 * Materialized metadata stored in every Tiptap Cloud epic room at
 * `doc.getMap("meta")`. The Yjs adapter owns conversion to and from
 * live Y.Maps; this schema owns the plain object contract. Because
 * clients read this before interpreting the rest of the room, the
 * shape must stay stable across persistence migrations.
 *
 * This schema is the contract authority for the `room-metadata`
 * record's TypeScript shape - `RoomMetadata` is derived from it in
 * `protocol/persistence/registry.ts` via `RecordValue<>`. Only that
 * registry imports this module; every other consumer reaches the
 * schema through
 * `getRecordSchema(persistenceRecordRegistry, "room-metadata")`.
 */
export const roomMetadataSchema = z.object({
  schemaVersion: z.string(),
  sealed: z.boolean(),
  deleted: z.boolean(),
  deletedByTraycerUserId: z.string().nullable(),
  deletedByDisplayName: z.string().nullable(),
  collaboratorRoles: collaboratorRolesSchema,
  teamRoles: teamRolesSchema,
  createdBy: z.string(),
  // Ordered list of artifact-body artifact-room IDs hosted under this Epic root.
  // Defaults to `[]` so existing room-metadata payloads written before the
  // artifact-room cutover still parse. The host appends a artifact-room ID here
  // when allocating a new artifactRoom; this is the easy "open all artifactRooms" list for
  // an Epic session.
  artifactRoomIds: z.array(z.string()).default([]),
});
