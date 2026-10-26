import { getRecordSchema } from "@traycer/protocol/framework/index";
import { z } from "zod";
import {
  commonRecordRegistry,
  EpicArtifactKindSchemaPreHtml,
} from "@traycer/protocol/common/registry";
import {
  commentThreadWireSchema,
  commentThreadWireSchemaPreAnchor,
  commentThreadWireSchemaPreCanvasPoint,
} from "../epic/unary-schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const commentThreadStatusFilterSchema = lazySchema(() =>
  z.enum(["all", "open", "resolved"]),
);
export type CommentThreadStatusFilter = z.infer<
  typeof commentThreadStatusFilterSchema
>;

export const commentThreadStatusSchema = lazySchema(() =>
  z.enum(["open", "resolved"]),
);
export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>;

export const commentsListThreadsRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string(),
    artifactPaths: z.array(z.string()).nullable(),
    status: commentThreadStatusFilterSchema,
  }),
);
export type CommentsListThreadsRequest = z.infer<
  typeof commentsListThreadsRequestSchema
>;

export const commentsListThreadSchemaPreAnchor = lazySchema(() =>
  z.object({
    thread: commentThreadWireSchemaPreAnchor,
    anchorStatus: z.enum(["present", "missing", "unavailable"]),
    anchorOrder: z.number().nullable(),
    anchorWarning: z.string().nullable(),
  }),
);
export const commentsListThreadSchemaPreCanvasPoint = lazySchema(() =>
  commentsListThreadSchemaPreAnchor.extend({
    thread: commentThreadWireSchemaPreCanvasPoint,
  }),
);
/** 1.3 adds the canvas-point anchor kind; 1.2 keeps its frozen enum. */
export const commentsListThreadSchema = lazySchema(() =>
  commentsListThreadSchemaPreAnchor.extend({ thread: commentThreadWireSchema }),
);
export type CommentsListThread = z.infer<typeof commentsListThreadSchema>;

export const commentsListArtifactSchemaPreHtml = lazySchema(() =>
  z.object({
    artifactPath: z.string(),
    kind: EpicArtifactKindSchemaPreHtml,
    title: z.string(),
    warning: z.string().nullable(),
    threads: z.array(commentsListThreadSchemaPreAnchor),
  }),
);
/** 1.1 adds new-kind artifacts; 1.0 stays frozen. */
export const commentsListArtifactSchemaPreAnchor = lazySchema(() =>
  commentsListArtifactSchemaPreHtml.extend({
    kind: getRecordSchema(commonRecordRegistry, "epic-artifact-kind", "latest"),
  }),
);
export const commentsListArtifactSchemaPreCanvasPoint = lazySchema(() =>
  commentsListArtifactSchemaPreAnchor.extend({
    threads: z.array(commentsListThreadSchemaPreCanvasPoint),
  }),
);
/** 1.3 adds the canvas-point anchor kind; 1.2 keeps its frozen enum. */
export const commentsListArtifactSchema = lazySchema(() =>
  commentsListArtifactSchemaPreAnchor.extend({
    threads: z.array(commentsListThreadSchema),
  }),
);
export type CommentsListArtifact = z.infer<typeof commentsListArtifactSchema>;

export const commentsListThreadsResponseSchemaPreHtml = lazySchema(() =>
  z.object({
    artifacts: z.array(commentsListArtifactSchemaPreHtml),
  }),
);
/** 1.1 adds new-kind artifacts; 1.0 stays frozen. */
export const commentsListThreadsResponseSchemaPreAnchor = lazySchema(() =>
  commentsListThreadsResponseSchemaPreHtml.extend({
    artifacts: z.array(commentsListArtifactSchemaPreAnchor),
  }),
);
export const commentsListThreadsResponseSchemaPreCanvasPoint = lazySchema(() =>
  commentsListThreadsResponseSchemaPreAnchor.extend({
    artifacts: z.array(commentsListArtifactSchemaPreCanvasPoint),
  }),
);
/** 1.3 adds the canvas-point anchor kind; 1.2 keeps its frozen enum. */
export const commentsListThreadsResponseSchema = lazySchema(() =>
  commentsListThreadsResponseSchemaPreAnchor.extend({
    artifacts: z.array(commentsListArtifactSchema),
  }),
);
export type CommentsListThreadsResponse = z.infer<
  typeof commentsListThreadsResponseSchema
>;

export const commentsSetThreadStatusUpdateSchema = lazySchema(() =>
  z.object({
    artifactPath: z.string(),
    threadIds: z.array(z.string()),
    status: commentThreadStatusSchema,
  }),
);
export type CommentsSetThreadStatusUpdate = z.infer<
  typeof commentsSetThreadStatusUpdateSchema
>;

export const commentsSetThreadStatusRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string(),
    updates: z.array(commentsSetThreadStatusUpdateSchema),
  }),
);
export type CommentsSetThreadStatusRequest = z.infer<
  typeof commentsSetThreadStatusRequestSchema
>;

export const commentsUpdatedThreadStatusSchema = lazySchema(() =>
  z.object({
    artifactPath: z.string(),
    threadId: z.string(),
    status: commentThreadStatusSchema,
  }),
);
export type CommentsUpdatedThreadStatus = z.infer<
  typeof commentsUpdatedThreadStatusSchema
>;

export const commentsFailedThreadStatusSchema = lazySchema(() =>
  z.object({
    artifactPath: z.string(),
    threadId: z.string(),
    reason: z.string(),
  }),
);
export type CommentsFailedThreadStatus = z.infer<
  typeof commentsFailedThreadStatusSchema
>;

export const commentsSetThreadStatusResponseSchema = lazySchema(() =>
  z.object({
    updated: z.array(commentsUpdatedThreadStatusSchema),
    failed: z.array(commentsFailedThreadStatusSchema),
  }),
);
export type CommentsSetThreadStatusResponse = z.infer<
  typeof commentsSetThreadStatusResponseSchema
>;
