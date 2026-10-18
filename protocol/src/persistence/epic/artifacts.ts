import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { imageSha256HexSchema } from "./images";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Artifact metadata and tombstones. Markdown and canvas bodies have a Yjs
 * artifact room; HTML and file entries have no Yjs body and no room id.
 */

/**
 * POSIX path within an artifact folder: no leading ./ or /, no empty segment,
 * no .. segment, and no dot-prefixed segment. Track C resolves
 * artifact-<id>/<path> against these manifest keys. Reject backslashes as
 * isEpicFilePath in files.ts does, and all Unicode control characters (C0,
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
 * byteLength, mediaType and status. Writes to different paths, or a status flip
 * and a captured sha change, merge independently. capturedAt is a plain epoch-ms
 * leaf on head, used by the status file and the disk-vs-head tiebreak.
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

// A room points at a Yjs document. HTML and file entries have no such body.
const artifactRoomFields = {
  // Artifact room hosting this artifact's body fragment
  // (`artifact-body:{artifactId}`). Populated when the host assigns the
  // artifact to a artifactRoom; empty string is a transitional placeholder for code
  // paths that pre-date artifact-room allocation (e.g. v1.0.0→v2.0.0 migration emit
  // before the artifactRoom manager lands).
  artifactRoomId: lazySchema(() => z.string()),
} as const;

const baseEpicArtifactFields = {
  ...baseEpicArtifactFieldsPreHtml,
  layout: lazySchema(() => z.enum(["folder", "file"]).default("folder")),
  // File-layout entries: relative to the parent artifact's folder or tree root.
  // folderName retains its existing meaning.
  relativePath: artifactManifestPathSchema.optional(),
} as const;

export const specArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("spec"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
  }),
);
export type SpecArtifact = z.infer<typeof specArtifactSchema>;

export const ticketArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("ticket"),
    ...baseEpicArtifactFields,
    ...artifactRoomFields,
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
  }),
);
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

// Released entries have neither layout nor relativePath.
export const specArtifactSchemaPreHtml = lazySchema(() =>
  specArtifactSchema.omit({ layout: true, relativePath: true }),
);
export const ticketArtifactSchemaPreHtml = lazySchema(() =>
  ticketArtifactSchema.omit({ layout: true, relativePath: true }),
);
export const storyArtifactSchemaPreHtml = lazySchema(() =>
  storyArtifactSchema.omit({ layout: true, relativePath: true }),
);
export const reviewArtifactSchemaPreHtml = lazySchema(() =>
  reviewArtifactSchema.omit({ layout: true, relativePath: true }),
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

// Object fields are plain leaves on the entry's own Y.Map so per-field writes merge.
export const fileArtifactSchema = lazySchema(() =>
  z.object({
    kind: z.literal("file"),
    ...baseEpicArtifactFields,
    layout: z.literal("file").default("file"),
    ...artifactObjectFields,
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

/** Y.Map field names for the nested manifest and each path's upload status. */
export const ARTIFACT_HEAD_FIELD = "head";
export const ARTIFACT_HEAD_FILES_FIELD = "files";
export const ARTIFACT_HEAD_FILE_STATUS_FIELD = "status";

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
  z.object({ kind: z.literal("html"), ...baseDeletedEpicArtifactFields }),
);
export type DeletedHtmlArtifact = z.infer<typeof deletedHtmlArtifactSchema>;
export const deletedCanvasArtifactSchema = lazySchema(() =>
  z.object({ kind: z.literal("canvas"), ...baseDeletedEpicArtifactFields }),
);
export type DeletedCanvasArtifact = z.infer<typeof deletedCanvasArtifactSchema>;
export const deletedFileArtifactSchema = lazySchema(() =>
  z.object({ kind: z.literal("file"), ...baseDeletedEpicArtifactFields }),
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
  return {
    id: artifact.id,
    kind: artifact.kind,
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
}
