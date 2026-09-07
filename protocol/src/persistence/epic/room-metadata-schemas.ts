import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";

/** Public sub-schemas and inferred types for the room-metadata record. */

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);

export const collaboratorRolesSchema = z.record(
  z.string(),
  permissionRoleSchema,
);
export type CollaboratorRoles = z.infer<typeof collaboratorRolesSchema>;

/**
 * Map of teamId to the role granted through team sharing.
 */
export const teamRolesSchema = z.record(z.string(), permissionRoleSchema);
export type TeamRoles = z.infer<typeof teamRolesSchema>;

export const roomVersionMetadataSchema = z.object({
  schemaVersion: z.string(),
  sealed: z.boolean(),
});
export type RoomVersionMetadata = z.infer<typeof roomVersionMetadataSchema>;

export const roomDeletionAttributionSchema = z.object({
  traycerUserId: z.string(),
  displayName: z.string(),
});
export type RoomDeletionAttribution = z.infer<
  typeof roomDeletionAttributionSchema
>;
