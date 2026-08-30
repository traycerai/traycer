import { z } from "zod";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";

/**
 * Epic artifacts: spec / ticket / story / review (plus their tombstone
 * variants). Each carries a `kind` discriminator. Tickets and stories
 * embed `ticketStatusSchema` from the common registry so the status
 * vocabulary stays versioned independently of the artifact shape.
 *
 * Bodies live in artifact-body artifact-rooms after the artifact-room cutover -
 * each artifact metadata entry references its artifact-room via `artifactRoomId`,
 * and the body fragment is `artifact-body:{artifactId}` inside that artifactRoom
 * room. Root artifact metadata no longer carries inline body content.
 */

const ticketStatusSchema = getRecordSchema(
  commonRecordRegistry,
  "ticket-status",
  "latest",
);

const baseEpicArtifactFields = {
  id: z.string(),
  folderName: z.string(),
  title: z.string(),
  // Artifact room hosting this artifact's body fragment
  // (`artifact-body:{artifactId}`). Populated when the host assigns the
  // artifact to a artifactRoom; empty string is a transitional placeholder for code
  // paths that pre-date artifact-room allocation (e.g. v1.0.0→v2.0.0 migration emit
  // before the artifactRoom manager lands).
  artifactRoomId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdManually: z.boolean(),
  parentId: z.string().nullable(),
} as const;

export const specArtifactSchema = z.object({
  kind: z.literal("spec"),
  ...baseEpicArtifactFields,
});
export type SpecArtifact = z.infer<typeof specArtifactSchema>;

export const ticketArtifactSchema = z.object({
  kind: z.literal("ticket"),
  ...baseEpicArtifactFields,
  assignee: z.string(),
  status: ticketStatusSchema,
});
export type TicketArtifact = z.infer<typeof ticketArtifactSchema>;

export const storyArtifactSchema = z.object({
  kind: z.literal("story"),
  ...baseEpicArtifactFields,
  assignee: z.string(),
  status: ticketStatusSchema,
});
export type StoryArtifact = z.infer<typeof storyArtifactSchema>;

export const reviewArtifactSchema = z.object({
  kind: z.literal("review"),
  ...baseEpicArtifactFields,
});
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

export const epicArtifactSchema = z.discriminatedUnion("kind", [
  specArtifactSchema,
  ticketArtifactSchema,
  storyArtifactSchema,
  reviewArtifactSchema,
]);
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
 * Deterministic Y.Doc root key for an artifact's body fragment inside its
 * assigned artifact-room. Authoritative across protocol/host/GUI: every consumer
 * that resolves an artifact body must derive the fragment name from this
 * helper rather than hard-coding the prefix.
 */
export function artifactBodyFragmentName(artifactId: string): string {
  return `${ARTIFACT_BODY_FRAGMENT_PREFIX}${artifactId}`;
}

const baseDeletedEpicArtifactFields = {
  id: z.string(),
  title: z.string(),
  artifactRoomId: z.string().nullable(),
  deletedAt: z.string(),
  folderName: z.string().nullish(),
  parentId: z.string().nullish(),
  createdAt: z.number().nullish(),
  createdManually: z.boolean().nullish(),
  assignee: z.string().nullish(),
  status: ticketStatusSchema.nullish(),
} as const;

export const deletedSpecArtifactSchema = z.object({
  kind: z.literal("spec"),
  ...baseDeletedEpicArtifactFields,
});
export type DeletedSpecArtifact = z.infer<typeof deletedSpecArtifactSchema>;

export const deletedTicketArtifactSchema = z.object({
  kind: z.literal("ticket"),
  ...baseDeletedEpicArtifactFields,
});
export type DeletedTicketArtifact = z.infer<typeof deletedTicketArtifactSchema>;

export const deletedStoryArtifactSchema = z.object({
  kind: z.literal("story"),
  ...baseDeletedEpicArtifactFields,
});
export type DeletedStoryArtifact = z.infer<typeof deletedStoryArtifactSchema>;

export const deletedReviewArtifactSchema = z.object({
  kind: z.literal("review"),
  ...baseDeletedEpicArtifactFields,
});
export type DeletedReviewArtifact = z.infer<typeof deletedReviewArtifactSchema>;

export const deletedEpicArtifactSchema = z.discriminatedUnion("kind", [
  deletedSpecArtifactSchema,
  deletedTicketArtifactSchema,
  deletedStoryArtifactSchema,
  deletedReviewArtifactSchema,
]);
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
      artifact.artifactRoomId.length > 0 ? artifact.artifactRoomId : null,
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
