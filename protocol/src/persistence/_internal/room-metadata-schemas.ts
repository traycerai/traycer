import { z } from "zod";
import {
  collaboratorRolesSchema,
  teamRolesSchema,
} from "@traycer/protocol/persistence/epic/room-metadata-schemas";

/**
 * Private Zod value for the `room-metadata` record.
 * Because clients read this before interpreting the rest of the room, the shape must stay stable across persistence migrations.
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
  artifactRoomIds: z.array(z.string()).default([]),
});
