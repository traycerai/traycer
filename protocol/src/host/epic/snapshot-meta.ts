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
 *
 * IMMUTABLE. A renderer that negotiated either of those minors agreed to
 * exactly these keys, so this object must never learn a new one. Adding a
 * key here - even a tolerated one (`.optional()`, `.catch()`, `.default()`) -
 * is a same-version wire-shape change on an already-released line: the
 * tolerance makes the *parse* succeed but says nothing about whether the
 * released peer's payload ever carries the key, so a consumer typed as if
 * the field were always populated reads `undefined` (the `providers.list`
 * #258 incident). New fields go on a new minor's shape below.
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
 * `epic.subscribe@1.2` snapshot metadata: adds the room identity.
 *
 * The LATEST installed shape - host code builds meta against this, and every
 * client-side `SnapshotMetaEpic` type flows from it. A NEW schema object
 * (not a mutation of {@link snapshotMetaEpicSchemaV10}) per the
 * frozen-per-minor rule: `@1.0`/`@1.1` connections keep parsing the frozen
 * shape above and silently strip the extra key a `@1.2`-built frame carries.
 */
export const snapshotMetaEpicSchema = snapshotMetaEpicSchemaV10.extend({
  /**
   * The concrete cloud collaboration room the host opened for this snapshot.
   *
   * Consumers must treat an absent identity as unknown, and must NOT infer it
   * from `epicId`: a major schema migration mints a NEW room for the same
   * Epic id, so merging two docs on equal `epicId` alone would union a
   * pre-migration doc into its transformed successor.
   *
   * Optional at `@1.2`, deliberately, for two independent reasons:
   *
   * 1. The client parses every server frame with the LATEST schema rather
   *    than the negotiated minor's (`epic-stream-client.ts`), so a required
   *    key here would make a `@1.0`/`@1.1` host's snapshot frame fail to
   *    parse at a `@1.2`-capable client - and that parse failure returns
   *    silently, leaving the canvas on its loading skeleton forever.
   * 2. The host genuinely may have no room open when it builds the snapshot,
   *    so absence is a real state rather than only a version artifact.
   *
   * What the minor buys is that the two are now distinguishable: below `@1.2`
   * absence is *contractual* (the key does not exist on that wire), while at
   * `@1.2` absence means the host has no room open. Presence is a version
   * fact instead of a runtime coin flip.
   */
  roomId: z.string().optional(),
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
