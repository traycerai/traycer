import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  draftComposerHeadSchemaV10,
  draftComposerHeadSchemaV11,
  draftComposerPortableSchemaV11,
  draftOperationIdSchema,
  draftSurfaceKindSchema,
  draftTargetSchema,
  draftWorkspaceSnapshotSchema,
} from "@traycer/protocol/persistence/draft/schemas";
import { draftBlobSha256Schema } from "./schemas";

/** A pool advertising this capability serves the image arm of drafts.putBlob. */
export const DRAFTS_IMAGE_ONLY_CAPABILITY = "drafts.image-only";

/** Opt-in to negotiating the exact conditional draft contracts. */
export const DRAFTS_CONDITIONAL_CAPABILITY = "drafts.conditional-v1";

const draftIdSchema = lazySchema(() => z.string().min(1));
const scopeIdSchema = lazySchema(() => z.string().min(1));
const feedSeqSchema = lazySchema(() => z.int().nonnegative());

/** A witness of the current cloud row, independent of the host's storeSeq. */
export const draftBaseSchema = lazySchema(() =>
  z.strictObject({
    // An older delete can retain row metadata without a head.
    headSha256: draftBlobSha256Schema.nullable(),
    ownerEpoch: z.int().nonnegative(),
    revision: z.int().nonnegative(),
  }),
);
export type DraftBase = z.infer<typeof draftBaseSchema>;

const draftPublishedBaseSchema = lazySchema(() =>
  draftBaseSchema.extend({ headSha256: draftBlobSha256Schema }),
);

export const draftCloudWriteSchema = lazySchema(() =>
  z.strictObject({
    draftId: draftIdSchema,
    kind: draftSurfaceKindSchema,
    target: draftTargetSchema,
    workspace: draftWorkspaceSnapshotSchema.nullable(),
    lastTouchedAt: z.int().nonnegative(),
    portable: draftComposerPortableSchemaV11,
  }),
);
export type DraftCloudWrite = z.infer<typeof draftCloudWriteSchema>;

export const draftsUpsertRequestSchemaV30 = lazySchema(() =>
  z.strictObject({
    scopeId: scopeIdSchema,
    draft: draftCloudWriteSchema,
    // Null claims a new id. Revival must name the current tombstone.
    base: draftBaseSchema.nullable(),
    operationId: draftOperationIdSchema,
  }),
);
export type DraftsUpsertRequestV30 = z.infer<
  typeof draftsUpsertRequestSchemaV30
>;

export const draftsDeleteRequestSchemaV20 = lazySchema(() =>
  z.strictObject({
    scopeId: scopeIdSchema,
    draftId: draftIdSchema,
    base: draftBaseSchema,
    operationId: draftOperationIdSchema,
  }),
);
export type DraftsDeleteRequestV20 = z.infer<
  typeof draftsDeleteRequestSchemaV20
>;

export const draftsRetractRequestSchemaV20 = draftsDeleteRequestSchemaV20;
export type DraftsRetractRequestV20 = DraftsDeleteRequestV20;

const cloudRowFields = {
  draftId: draftIdSchema,
  base: draftPublishedBaseSchema,
} as const;
const draftCloudDocumentSchemaV11 = lazySchema(() =>
  z.strictObject({
    ...cloudRowFields,
    head: draftComposerHeadSchemaV11,
    operationId: draftOperationIdSchema,
  }),
);
export const draftCloudDocumentSchema = lazySchema(() =>
  z.union([
    draftCloudDocumentSchemaV11,
    z.strictObject({
      ...cloudRowFields,
      head: draftComposerHeadSchemaV10,
      operationId: z.null(),
    }),
  ]),
);
export type DraftCloudDocument = z.infer<typeof draftCloudDocumentSchema>;

const draftCloudTombstoneSchemaV11 = lazySchema(() =>
  z.strictObject({
    ...cloudRowFields,
    operationId: draftOperationIdSchema,
  }),
);
export const draftCloudTombstoneSchema = lazySchema(() =>
  z.union([
    draftCloudTombstoneSchemaV11,
    z.strictObject({
      draftId: draftIdSchema,
      base: draftBaseSchema,
      operationId: z.null(),
    }),
  ]),
);
export type DraftCloudTombstone = z.infer<typeof draftCloudTombstoneSchema>;

const liveDraftSchema = lazySchema(() =>
  z.strictObject({ kind: z.literal("live"), draft: draftCloudDocumentSchema }),
);
const tombstonedDraftSchema = lazySchema(() =>
  z.strictObject({
    kind: z.literal("tombstone"),
    tombstone: draftCloudTombstoneSchema,
  }),
);
export const draftCloudCurrentSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    liveDraftSchema,
    tombstonedDraftSchema,
    z.strictObject({ kind: z.literal("absent") }),
  ]),
);
export type DraftCloudCurrent = z.infer<typeof draftCloudCurrentSchema>;

const draftConflictSchema = lazySchema(() =>
  z.strictObject({
    status: z.literal("conflict"),
    current: draftCloudCurrentSchema,
  }),
);
export const draftsUpsertResponseSchemaV30 = lazySchema(() =>
  z
    .discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("committed"),
        operationId: draftOperationIdSchema,
        current: liveDraftSchema.extend({ draft: draftCloudDocumentSchemaV11 }),
      }),
      draftConflictSchema,
    ])
    .refine(
      (receipt) =>
        receipt.status === "conflict" ||
        receipt.operationId === receipt.current.draft.operationId,
      {
        path: ["operationId"],
        message: "The receipt must match the operation in the committed head.",
      },
    ),
);
export type DraftsUpsertResponseV30 = z.infer<
  typeof draftsUpsertResponseSchemaV30
>;

export const draftsDeleteResponseSchemaV20 = lazySchema(() =>
  z
    .discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("committed"),
        operationId: draftOperationIdSchema,
        current: tombstonedDraftSchema.extend({
          tombstone: draftCloudTombstoneSchemaV11,
        }),
      }),
      draftConflictSchema,
    ])
    .refine(
      (receipt) =>
        receipt.status === "conflict" ||
        receipt.operationId === receipt.current.tombstone.operationId,
      {
        path: ["operationId"],
        message:
          "The receipt must match the operation in the committed tombstone.",
      },
    ),
);
export type DraftsDeleteResponseV20 = z.infer<
  typeof draftsDeleteResponseSchemaV20
>;

export const draftsRetractResponseSchemaV20 = draftsDeleteResponseSchemaV20;
export type DraftsRetractResponseV20 = DraftsDeleteResponseV20;

export const draftsListResponseSchemaV30 = lazySchema(() =>
  z.strictObject({
    scopeId: scopeIdSchema,
    drafts: z.array(draftCloudDocumentSchema),
    tombstones: z.array(draftCloudTombstoneSchema),
    // Read under the same frontier as the live rows and tombstones.
    snapshotSeq: feedSeqSchema,
  }),
);
export type DraftsListResponseV30 = z.infer<typeof draftsListResponseSchemaV30>;

export const draftsSubscribeOpenRequestSchemaV20 = lazySchema(() =>
  z.strictObject({
    scopeId: scopeIdSchema,
    afterSeq: feedSeqSchema,
  }),
);
export type DraftsSubscribeOpenRequestV20 = z.infer<
  typeof draftsSubscribeOpenRequestSchemaV20
>;

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

/** Tail only the committed feed for the scope and peer that served the snapshot. */
export const draftsSubscribeServerFrameSchemaV20 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("upsert"),
      ...textFrameFields,
      seq: feedSeqSchema,
      draft: draftCloudDocumentSchema,
    }),
    z.strictObject({
      kind: z.literal("delete"),
      ...textFrameFields,
      seq: feedSeqSchema,
      tombstone: draftCloudTombstoneSchema,
    }),
    // The previous frontier is unusable. Fetch a fresh snapshot before tailing.
    z.strictObject({ kind: z.literal("reset"), ...textFrameFields }),
    z.strictObject({ kind: z.literal("pong"), ...textFrameFields }),
  ]),
);
export type DraftsSubscribeServerFrameV20 = z.infer<
  typeof draftsSubscribeServerFrameSchemaV20
>;

export const draftsSubscribeClientFrameSchemaV20 = lazySchema(() =>
  z.strictObject({ kind: z.literal("ping"), ...textFrameFields }),
);
export type DraftsSubscribeClientFrameV20 = z.infer<
  typeof draftsSubscribeClientFrameSchemaV20
>;
