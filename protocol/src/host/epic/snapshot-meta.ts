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
 * Frozen `epic.subscribe@1.2` snapshot metadata: adds the room identity.
 *
 * IMMUTABLE, for the same reason {@link snapshotMetaEpicSchemaV10} is. A NEW
 * schema object (not a mutation of the V10 shape) per the frozen-per-minor
 * rule: `@1.0`/`@1.1` connections keep parsing the frozen shape above and
 * silently strip the extra key a `@1.2`-built frame carries. `@1.3` extends
 * THIS shape the same way - see {@link snapshotMetaEpicSchema}.
 */
export const snapshotMetaEpicSchemaV12 = snapshotMetaEpicSchemaV10.extend({
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
export type SnapshotMetaEpicV12 = z.infer<typeof snapshotMetaEpicSchemaV12>;

/**
 * `epic.subscribe@1.3` snapshot metadata: adds the delta-seed basis marker.
 *
 * The LATEST installed shape - host code builds meta against this, and every
 * client-side `SnapshotMetaEpic` type flows from it. Another new schema
 * object rather than a mutation of {@link snapshotMetaEpicSchemaV12}, per the
 * frozen-per-minor rule.
 */
export const snapshotMetaEpicSchema = snapshotMetaEpicSchemaV12.extend({
  /**
   * Present ONLY when the snapshot frame's binary payload is a Yjs **delta**
   * computed against the state vector this client offered in the open
   * request's `seedOffer` - i.e. the bytes are NOT self-sufficient and MUST be
   * merged into the very doc that produced that offer.
   *
   * Absence means the payload is a full snapshot. That is the encoding for
   * every case that is not a served delta, and they are deliberately
   * indistinguishable on the wire: a pre-`@1.3` host, a client that made no
   * offer (cold open), an offer the host rejected (unparseable state vector,
   * or a `roomId` that does not name the room the bytes came from), and any
   * host-side fallback all look identical to the client. A full snapshot is
   * always safe to apply, so collapsing them costs nothing and removes every
   * branch where a client could mistake one for the other.
   *
   * `z.literal(true)` rather than `z.boolean()` deliberately: the fact is
   * two-state, so this leaves exactly ONE representation of "full snapshot"
   * (absence) instead of two (absence and `false`), and no consumer can
   * branch on `=== false` where it meant `!== true`.
   *
   * LOAD-BEARING, not cosmetic. Both a full snapshot and a delta are applied
   * with the same `Y.applyUpdate`, so this does not select an apply function -
   * it forbids the renderer's plain-swap path. The renderer decides between
   * merging into the existing replica and swapping in a fresh doc (the seam
   * `roomId` was added for at `@1.2`); handing a delta to the swap branch
   * would drop every byte the delta legitimately omitted.
   */
  seededFromOffer: z.literal(true).optional(),
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
