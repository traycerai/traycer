import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { imageSha256HexSchema } from "./images";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  MARKDOWN_REVISION_HEAD_PATH,
  MARKDOWN_REVISION_HEAD_SCALARS_FIELD,
  MARKDOWN_REVISION_HEAD_SEQ_FIELD,
  markdownRevisionScalarsSchema,
} from "./markdown-revision";

/**
 * Artifact metadata and tombstones. Markdown, HTML and canvas entries carry
 * an artifact-room reference; file entries carry one object.
 */

/**
 * POSIX path within an artifact folder: no leading ./ or /, no empty segment,
 * no .. segment, and no dot-prefixed segment. Artifact serving resolves
 * artifact-<id>/<path> against these manifest keys. Reject backslashes
 * and all Unicode control characters (C0,
 * DEL and C1). Windows hosts would read a backslash as a separator; the manifest
 * must name the same file everywhere. Reject segments named __proto__: the
 * record parser cannot carry that key. artifactHeadSchema also checks the raw
 * files input because the record parser skips that own key before validation.
 */
export const artifactManifestPathSchema = lazySchema(() =>
  z
    .string()
    .regex(
      /^(?!\.|__proto__(?:\/|$))[^/\\\p{Cc}]+(?:\/(?!\.|__proto__(?:\/|$))[^/\\\p{Cc}]+)*(?![\s\S])/u,
    ),
);

/**
 * Upload custody of one object, written by ingest and the uploader. Status
 * lives on each path's Y.Map so different hosts' writes to different files merge.
 */
export const artifactObjectStatusSchema = lazySchema(() =>
  z.enum(["queued", "uploading", "published", "local-only", "failed"]),
);
export type ArtifactObjectStatus = z.infer<typeof artifactObjectStatusSchema>;

const artifactObjectFields = {
  sha256: imageSha256HexSchema,
  byteLength: lazySchema(() => z.number().int().nonnegative()),
  // Same rule as the cloud uploader's epicFileMediaTypeSchema. Protocol cannot
  // import that internal package: only lowercase type/subtype, no parameters.
  mediaType: lazySchema(() =>
    z
      .string()
      .max(127)
      .regex(
        /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
        "Expected a lowercase type/subtype media type with no parameters",
      ),
  ),
  status: artifactObjectStatusSchema,
};

export const artifactObjectRefSchema = lazySchema(() =>
  z.object(artifactObjectFields),
);
export type ArtifactObjectRef = z.infer<typeof artifactObjectRefSchema>;

/**
 * JSON projection of the Yjs head; Y.Map readers call toJSON before parsing.
 * head is a Y.Map; files is a Y.Map of path -> Y.Map containing sha256,
 * byteLength, mediaType and status. Each per-path map is one capture generation:
 * a different sha replaces the whole map with status queued; a same-sha capture
 * touches nothing. Only a status flip mutates the map in place, guarded by the
 * sha. Different paths still merge independently. capturedAt is a plain
 * epoch-ms leaf on head, used for the status file and the disk-vs-head tiebreak.
 */
export const artifactHeadSchema = lazySchema(() =>
  z.object({
    files: z
      .preprocess(
        (value, ctx) => {
          // z.record skips an own __proto__ before checking its key schema.
          // Refuse the raw key instead of silently losing a manifest file.
          if (
            typeof value === "object" &&
            value !== null &&
            Object.hasOwn(value, "__proto__")
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                "Artifact manifest files must not contain an own __proto__ key",
            });
            return z.NEVER;
          }
          return value;
        },
        z.record(artifactManifestPathSchema, artifactObjectRefSchema),
      )
      // A preprocess accepts unknown; keep files required in the input surface.
      .nonoptional(),
    capturedAt: z.number(),
  }),
);
export type ArtifactHead = z.infer<typeof artifactHeadSchema>;

const ticketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

const baseEpicArtifactFieldsPreHtml = {
  id: lazySchema(() => z.string()),
  folderName: lazySchema(() => z.string()),
  title: lazySchema(() => z.string()),
  createdAt: lazySchema(() => z.number()),
  updatedAt: lazySchema(() => z.number()),
  createdManually: lazySchema(() => z.boolean()),
  parentId: lazySchema(() => z.string().nullable()),
} as const;

// A room points at a Yjs document. Only file entries have no such body.
const artifactRoomFields = {
  // Artifact room hosting this artifact's body fragment
  // (`artifact-body:{artifactId}`). Populated when the host assigns the
  // artifact to a artifactRoom; empty string is a transitional placeholder for code
  // paths that pre-date artifact-room allocation (e.g. v1.0.0→v2.0.0 migration emit
  // before the artifactRoom manager lands).
  artifactRoomId: lazySchema(() => z.string()),
} as const;

/**
 * A markdown body stored as revision objects: the head names the current
 * revision envelope as its one file (`markdown-revision.ts`), the same shape
 * as an html head. That file's generation also carries the revision's
 * position in the cloud chain, so a reader of the index can tell a newer
 * projection from an older one, and the revision's frontmatter scalars, so
 * they are always the ones of the revision the generation names.
 */
export const markdownArtifactHeadSchema = lazySchema(() =>
  z.object({
    files: z.object({
      [MARKDOWN_REVISION_HEAD_PATH]: z.object({
        ...artifactObjectFields,
        [MARKDOWN_REVISION_HEAD_SEQ_FIELD]: z.number().int().positive(),
        [MARKDOWN_REVISION_HEAD_SCALARS_FIELD]: markdownRevisionScalarsSchema,
      }),
    }),
    capturedAt: z.number(),
  }),
);
export type MarkdownArtifactHead = z.infer<typeof markdownArtifactHeadSchema>;

/** Absent on an entry whose body still lives in its artifact room. */
const markdownHeadFields = {
  head: lazySchema(() => markdownArtifactHeadSchema.optional()),
} as const;

const baseEpicArtifactFields = {
  ...baseEpicArtifactFieldsPreHtml,
  layout: lazySchema(() => z.enum(["folder", "file"]).default("folder")),
  // Where the entry lives relative to the parent artifact's folder or the tree
  // root, on either layout. A file-layout entry names its file; a folder-layout
  // entry names its folder, which is how an html or canvas folder nested under
  // a plain folder (`research/site/index.html`) is representable: the
  // `parentId` chain alone cannot carry the `research/` segment. When present
  // it replaces `folderName` in the path chain; `folderName` stays the last
  // segment for anything that displays it. Absent means the entry sits directly
  // under its parent (or the root) as `folderName`, which is every entry
  // written before this field existed.
  relativePath: lazySchema(() => artifactManifestPathSchema.optional()),
} as const;

export const specArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("spec"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
    ...markdownHeadFields,
  }),
);
export type SpecArtifact = z.infer<typeof specArtifactSchema>;

export const ticketArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("ticket"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
    ...markdownHeadFields,
    assignee: z.string(),
    status: ticketStatusSchema,
  }),
);
export type TicketArtifact = z.infer<typeof ticketArtifactSchema>;

export const storyArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("story"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
    ...markdownHeadFields,
    assignee: z.string(),
    status: ticketStatusSchema,
  }),
);
export type StoryArtifact = z.infer<typeof storyArtifactSchema>;

export const reviewArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("review"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
    ...markdownHeadFields,
  }),
);
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

// Released entries have neither layout, relativePath nor a markdown head.
export const specArtifactSchemaPreHtml = lazySchema(() =>
  specArtifactSchema.omit({ layout: true, relativePath: true, head: true }),
);
export const ticketArtifactSchemaPreHtml = lazySchema(() =>
  ticketArtifactSchema.omit({ layout: true, relativePath: true, head: true }),
);
export const storyArtifactSchemaPreHtml = lazySchema(() =>
  storyArtifactSchema.omit({ layout: true, relativePath: true, head: true }),
);
export const reviewArtifactSchemaPreHtml = lazySchema(() =>
  reviewArtifactSchema.omit({ layout: true, relativePath: true, head: true }),
);

export const epicArtifactSchemaPreHtml = lazySchema(() =>
  z.discriminatedUnion("kind", [
    specArtifactSchemaPreHtml,
    ticketArtifactSchemaPreHtml,
    storyArtifactSchemaPreHtml,
    reviewArtifactSchemaPreHtml,
  ]),
);

export const htmlArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("html"),
    ...baseEpicArtifactFields,
    // Older HTML entries have no room until the room heal pass allocates one.
    artifactRoomId: z.string().default(""),
    head: artifactHeadSchema,
  }),
);
export type HtmlArtifact = z.infer<typeof htmlArtifactSchema>;

export const canvasArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("canvas"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
    head: artifactHeadSchema,
  }),
);
export type CanvasArtifact = z.infer<typeof canvasArtifactSchema>;

/**
 * The object Y.Map is one capture generation. Four flat leaves can tear under
 * a merge: a peer's published status can win against a concurrent sha change
 * and mark bytes nobody uploaded as published. A different sha replaces the
 * whole object map with status queued; a same-sha capture touches nothing.
 * Only a sha-guarded status flip mutates the map in place.
 */
export const fileArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("file"),
    ...baseEpicArtifactFields,
    layout: z.literal("file").default("file"),
    object: artifactObjectRefSchema,
  }),
);
export type FileArtifact = z.infer<typeof fileArtifactSchema>;

export const epicArtifactSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    specArtifactSchema,
    ticketArtifactSchema,
    storyArtifactSchema,
    reviewArtifactSchema,
    htmlArtifactSchema,
    canvasArtifactSchema,
    fileArtifactSchema,
  ]),
);
export type EpicArtifact = z.infer<typeof epicArtifactSchema>;

/**
 * Deterministic prefix for artifact body fragment names. Consumers that
 * iterate share-keys looking for body fragments may match on this; everyone
 * else should use {@link artifactBodyFragmentName} to compose the full name.
 */
export const ARTIFACT_BODY_FRAGMENT_PREFIX = "artifact-body:";

/**
 * Field name on a root artifact entry that names the artifact-room hosting this
 * artifact's body fragment. Consumers reading or writing this field on a
 * Y.Map should use this constant rather than the literal string.
 */
export const ARTIFACT_ARTIFACT_ROOM_FIELD = "artifactRoomId";

/**
 * The epic's markdown body epoch: a number on the epic root map (the map that
 * holds `artifacts`), written by the host that migrates the epic's markdown
 * bodies off their shared artifact rooms, in the same transaction as the
 * first artifact it switches, and only ever raised. Only 1 is defined: two
 * hosts writing the same value converge, while two different values written
 * at once would settle by Yjs client order, so a later epoch needs its own
 * rule for that.
 *
 * - Absent or 0: every markdown artifact's body is its room's fragment.
 * - {@link MARKDOWN_BODY_EPOCH_HEADS} (1): a markdown artifact whose entry
 *   names a markdown head (`head`) has its body on the revision chain; its
 *   room fragment is no longer its body. A host at this epoch reads and
 *   writes such a body through the head and creates new markdown artifacts
 *   with no room. An artifact whose entry names no head still lives in its
 *   room. A host older than the epoch does not read this field and keeps
 *   using the room.
 *
 * The cutoff rule, at epoch 1 and later: a client's write into an artifact
 * room that touches the body fragment of an artifact whose entry names a
 * markdown head is refused by the host at the point it would be applied, and
 * the client is told so, never answered as saved. `artifact.subscribe`
 * answers it `unavailable` with code `bodyMoved` (from minor 2; terminal
 * `bodyUnavailable` below), `epic.subscribe` with `artifactRoomState`
 * `unavailable`, reason `bodyMoved` (from minor 7; the state alone below).
 * Bytes another host's room write brings through the cloud are kept, since
 * a room cannot refuse part of its log, and every reader at the epoch
 * ignores such a fragment.
 */
export const MARKDOWN_BODY_EPOCH_FIELD = "markdownBodyEpoch";
/** The epoch at which a markdown entry's head is its body's authority. */
export const MARKDOWN_BODY_EPOCH_HEADS = 1;
export const markdownBodyEpochSchema = lazySchema(() =>
  z.number().int().nonnegative(),
);

/** Y.Map field names for the nested manifest and each path's upload status. */
export const ARTIFACT_HEAD_FIELD = "head";
export const ARTIFACT_HEAD_FILES_FIELD = "files";
export const ARTIFACT_HEAD_FILE_STATUS_FIELD = "status";
/** Y.Map field holding a file artifact's complete capture generation. */
export const ARTIFACT_FILE_OBJECT_FIELD = "object";

/**
 * Deterministic Y.Doc root key for an artifact's body fragment inside its
 * assigned artifact-room. Authoritative across protocol/host/GUI: every consumer
 * that resolves an artifact body must derive the fragment name from this
 * helper rather than hard-coding the prefix.
 */
export function artifactBodyFragmentName(artifactId: string): string {
  return `${ARTIFACT_BODY_FRAGMENT_PREFIX}${artifactId}`;
}

const baseDeletedEpicArtifactFields = {
  id: lazySchema(() => z.string()),
  title: lazySchema(() => z.string()),
  artifactRoomId: lazySchema(() => z.string().nullable()),
  deletedAt: lazySchema(() => z.string()),
  folderName: lazySchema(() => z.string().nullish()),
  parentId: lazySchema(() => z.string().nullish()),
  createdAt: lazySchema(() => z.number().nullish()),
  createdManually: lazySchema(() => z.boolean().nullish()),
  assignee: lazySchema(() => z.string().nullish()),
  status: lazySchema(() => ticketStatusSchema.nullish()),
} as const;

export const deletedSpecArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("spec"),
    ...baseDeletedEpicArtifactFields,
  }),
);
export type DeletedSpecArtifact = z.infer<typeof deletedSpecArtifactSchema>;

export const deletedTicketArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("ticket"),
    ...baseDeletedEpicArtifactFields,
  }),
);
export type DeletedTicketArtifact = z.infer<typeof deletedTicketArtifactSchema>;

export const deletedStoryArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("story"),
    ...baseDeletedEpicArtifactFields,
  }),
);
export type DeletedStoryArtifact = z.infer<typeof deletedStoryArtifactSchema>;

export const deletedReviewArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("review"),
    ...baseDeletedEpicArtifactFields,
  }),
);
export type DeletedReviewArtifact = z.infer<typeof deletedReviewArtifactSchema>;

export const deletedEpicArtifactSchemaPreHtml = lazySchema(() =>
  z.discriminatedUnion("kind", [
    deletedSpecArtifactSchema,
    deletedTicketArtifactSchema,
    deletedStoryArtifactSchema,
    deletedReviewArtifactSchema,
  ]),
);
export const deletedHtmlArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("html"),
    ...baseDeletedEpicArtifactFields,
    deletionUnderstood: z.boolean().default(false),
  }),
);
export type DeletedHtmlArtifact = z.infer<typeof deletedHtmlArtifactSchema>;
export const deletedCanvasArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("canvas"),
    ...baseDeletedEpicArtifactFields,
    deletionUnderstood: z.boolean().default(false),
  }),
);
export type DeletedCanvasArtifact = z.infer<typeof deletedCanvasArtifactSchema>;
export const deletedFileArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("file"),
    ...baseDeletedEpicArtifactFields,
    deletionUnderstood: z.boolean().default(false),
  }),
);
export type DeletedFileArtifact = z.infer<typeof deletedFileArtifactSchema>;

export const deletedEpicArtifactSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    ...deletedEpicArtifactSchemaPreHtml.options,
    deletedHtmlArtifactSchema,
    deletedCanvasArtifactSchema,
    deletedFileArtifactSchema,
  ]),
);
export type DeletedEpicArtifact = z.infer<typeof deletedEpicArtifactSchema>;

/**
 * Builds the metadata tombstone written atomically with an artifact removal.
 *
 * The nullable scalar slots deliberately exist on every artifact kind. This
 * gives delete/revive and crash recovery one total shape while old, slim
 * tombstones remain valid through the schemas' nullish additions.
 */
export function buildDeletedEpicArtifact(
  artifact: EpicArtifact,
  deletedAt: string,
): DeletedEpicArtifact {
  const common = {
    id: artifact.id,
    title: artifact.title,
    artifactRoomId:
      "artifactRoomId" in artifact && artifact.artifactRoomId.length > 0
        ? artifact.artifactRoomId
        : null,
    deletedAt,
    folderName: artifact.folderName,
    parentId: artifact.parentId,
    createdAt: artifact.createdAt,
    createdManually: artifact.createdManually,
    assignee:
      artifact.kind === "ticket" || artifact.kind === "story"
        ? artifact.assignee
        : null,
    status:
      artifact.kind === "ticket" || artifact.kind === "story"
        ? artifact.status
        : null,
  };
  switch (artifact.kind) {
    case "html":
    case "canvas":
    case "file":
      // A legacy host can write a tombstone before its unsupported-kind delete
      // throws. Only this constructor acknowledges a deletion that understood it.
      return { ...common, kind: artifact.kind, deletionUnderstood: true };
    case "spec":
    case "ticket":
    case "story":
    case "review":
      return { ...common, kind: artifact.kind };
  }
}
