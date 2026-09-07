/**
 * `epic.subscribe@1.0` - Host → client snapshot metadata for the epic stream.
 * Allowed dependencies: `zod` and other protocol modules only - this file must stay browser-safe.
 */
import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import {
  epicLightSchema,
  taskRepoIdentifierSchema,
  taskRepoAssociationSchema,
  userTaskWorkspaceSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

const permissionRoleSchema = getRecordSchema(
  commonRecordRegistry,
  "permission-role",
  "latest",
);

export const localRepoMappingEntrySchema = z.object({
  repoIdentifier: z.string(),
  workspacePath: z.string(),
  lastSyncedAt: z.number(),
});
export type LocalRepoMappingEntry = z.infer<typeof localRepoMappingEntrySchema>;

export const resolvedWorkspaceFolderSchema = z.object({
  workspacePath: z.string(),
  hostId: z.string(),
  repoIdentifier: taskRepoIdentifierSchema.nullable(),
  lastSyncedAt: z.number().nullable(),
});
export type ResolvedWorkspaceFolder = z.infer<
  typeof resolvedWorkspaceFolderSchema
>;

/**
 * Frozen `epic.subscribe@1.0` / `@1.1` snapshot metadata, as shipped.
 * A renderer that negotiated either of those minors agreed to exactly these keys, so this object must never learn a new one.
 */
export const snapshotMetaEpicSchemaV10 = z.object({
  schemaVersion: z.string(),
  epicLight: epicLightSchema.nullable(),
  permissionRole: permissionRoleSchema.nullable(),
  repos: z.array(taskRepoAssociationSchema),
  workspaces: z.array(userTaskWorkspaceSchema),
  repoMapping: z.array(localRepoMappingEntrySchema),
  workspaceFolders: z.array(resolvedWorkspaceFolderSchema),
  unresolvedRepos: z.array(taskRepoIdentifierSchema),
  hostStateVectorBase64: z.string(),
});
export type SnapshotMetaEpicV10 = z.infer<typeof snapshotMetaEpicSchemaV10>;

/**
 * Frozen `epic.subscribe@1.2` snapshot metadata: adds the room identity.
 * A NEW schema object (not a mutation of the V10 shape) per the frozen-per-minor rule: `@1.0`/`@1.1` connections keep parsing the frozen shape above and silently strip the extra key a `@1.2`-built frame carries.
 */
export const snapshotMetaEpicSchemaV12 = snapshotMetaEpicSchemaV10.extend({
  /** The concrete cloud collaboration room the host opened for this snapshot. */
  roomId: z.string().optional(),
});
export type SnapshotMetaEpicV12 = z.infer<typeof snapshotMetaEpicSchemaV12>;

/**
 * `epic.subscribe@1.3` snapshot metadata: adds the delta-seed basis marker.
 * Another new schema object rather than a mutation of {@link snapshotMetaEpicSchemaV12}, per the frozen-per-minor rule.
 */
export const snapshotMetaEpicSchema = snapshotMetaEpicSchemaV12.extend({
  /**
   * Present ONLY when the snapshot frame's binary payload is a Yjs **delta** computed against the state vector this client offered in the open request's `seedOffer` - i.e. the bytes are NOT self-sufficient and MUST be.
   */
  seededFromOffer: z.literal(true).optional(),
});
export type SnapshotMetaEpic = z.infer<typeof snapshotMetaEpicSchema>;

/** Payload of the `earlyMeta` server frame on `epic.subscribe@1.0`. */
export const earlyMetaEpicSchema = z.object({
  epicLight: epicLightSchema.nullable(),
  permissionRole: permissionRoleSchema.nullable(),
  repos: z.array(taskRepoAssociationSchema),
  workspaces: z.array(userTaskWorkspaceSchema),
  repoMapping: z.array(localRepoMappingEntrySchema),
  workspaceFolders: z.array(resolvedWorkspaceFolderSchema),
  unresolvedRepos: z.array(taskRepoIdentifierSchema),
});
export type EarlyMetaEpic = z.infer<typeof earlyMetaEpicSchema>;
