import { z } from "zod";
import {
  LatestEpicArtifactKindSchema,
  commentThreadWireSchema,
} from "../epic/unary-schemas";

export const commentThreadStatusFilterSchema = z.enum([
  "all",
  "open",
  "resolved",
]);
export type CommentThreadStatusFilter = z.infer<
  typeof commentThreadStatusFilterSchema
>;

export const commentThreadStatusSchema = z.enum(["open", "resolved"]);
export type CommentThreadStatus = z.infer<typeof commentThreadStatusSchema>;

export const commentsListThreadsRequestSchema = z.object({
  epicId: z.string(),
  artifactPaths: z.array(z.string()).nullable(),
  status: commentThreadStatusFilterSchema,
});
export type CommentsListThreadsRequest = z.infer<
  typeof commentsListThreadsRequestSchema
>;

export const commentsListThreadSchema = z.object({
  thread: commentThreadWireSchema,
  anchorStatus: z.enum(["present", "missing", "unavailable"]),
  anchorOrder: z.number().nullable(),
  anchorWarning: z.string().nullable(),
});
export type CommentsListThread = z.infer<typeof commentsListThreadSchema>;

export const commentsListArtifactSchema = z.object({
  artifactPath: z.string(),
  kind: LatestEpicArtifactKindSchema,
  title: z.string(),
  warning: z.string().nullable(),
  threads: z.array(commentsListThreadSchema),
});
export type CommentsListArtifact = z.infer<typeof commentsListArtifactSchema>;

export const commentsListThreadsResponseSchema = z.object({
  artifacts: z.array(commentsListArtifactSchema),
});
export type CommentsListThreadsResponse = z.infer<
  typeof commentsListThreadsResponseSchema
>;

export const commentsSetThreadStatusUpdateSchema = z.object({
  artifactPath: z.string(),
  threadIds: z.array(z.string()),
  status: commentThreadStatusSchema,
});
export type CommentsSetThreadStatusUpdate = z.infer<
  typeof commentsSetThreadStatusUpdateSchema
>;

export const commentsSetThreadStatusRequestSchema = z.object({
  epicId: z.string(),
  updates: z.array(commentsSetThreadStatusUpdateSchema),
});
export type CommentsSetThreadStatusRequest = z.infer<
  typeof commentsSetThreadStatusRequestSchema
>;

export const commentsUpdatedThreadStatusSchema = z.object({
  artifactPath: z.string(),
  threadId: z.string(),
  status: commentThreadStatusSchema,
});
export type CommentsUpdatedThreadStatus = z.infer<
  typeof commentsUpdatedThreadStatusSchema
>;

export const commentsFailedThreadStatusSchema = z.object({
  artifactPath: z.string(),
  threadId: z.string(),
  reason: z.string(),
});
export type CommentsFailedThreadStatus = z.infer<
  typeof commentsFailedThreadStatusSchema
>;

export const commentsSetThreadStatusResponseSchema = z.object({
  updated: z.array(commentsUpdatedThreadStatusSchema),
  failed: z.array(commentsFailedThreadStatusSchema),
});
export type CommentsSetThreadStatusResponse = z.infer<
  typeof commentsSetThreadStatusResponseSchema
>;
