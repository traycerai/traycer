/**
 * Host → client snapshot metadata for the epic stream.
 *
 * `snapshotMetaEpicSchema` rides the text envelope of the binary-framed
 * `snapshot` server frame on `epic.subscribe@1.0`. The binary payload carries
 * the Y.Doc snapshot bytes; this schema carries the surrounding epic-level
 * context (epic light, permission role, repos, workspaces) plus the
 * host-local repo-path mapping the GUI needs to resolve workspaces to
 * on-disk checkouts.
 *
 * Allowed dependencies: `zod` and other protocol modules only - this file
 * must stay browser-safe.
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
  "permission-role", "latest");

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

export const snapshotMetaEpicSchema = z.object({
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
export type SnapshotMetaEpic = z.infer<typeof snapshotMetaEpicSchema>;

/**
 * Payload of the `earlyMeta` server frame on `epic.subscribe@1.0`. The
 * host emits this BEFORE the Tiptap WS sync completes so the renderer
 * can populate workspace-derived UI (git status, file tree, sidebar repo
 * chip, permission display) without waiting for the full snapshot.
 *
 * Distinct from {@link snapshotMetaEpicSchema}: omits the fields that are
 * only knowable after the room is open (`schemaVersion` from
 * `roomMetadata`, `hostStateVectorBase64` from the live Y.Doc). This
 * keeps the renderer's `snapshotMeta` consumer from observing semantically
 * wrong placeholder values between the early frame and the real snapshot.
 */
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
