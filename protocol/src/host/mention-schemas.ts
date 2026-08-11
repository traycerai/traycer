/**
 * Wire shapes for GitHub pull-request and issue mentions in the composer.
 *
 * The catalog is cache-backed and stale-first; typed search is fetch-through.
 * Both expose the same lightweight row union so callers can merge cached and
 * remote results by GitHub identity without inventing a second client model.
 */
import { z } from "zod";
import {
  prActorSchema,
  prChecksRollupSchema,
  prReviewDecisionSchema,
  prSourceNoticeSchema,
  prSourceStatusSchema,
  prStateSchema,
} from "./pr-schemas";

export const githubMentionSectionSchema = z.enum(["pull-requests", "issues"]);
export type GithubMentionSection = z.infer<typeof githubMentionSectionSchema>;

export const githubCatalogRefreshSchema = z.enum(["none", "auto", "manual"]);
export type GithubCatalogRefresh = z.infer<typeof githubCatalogRefreshSchema>;

export const githubMentionBucketSchema = z.enum([
  "epic",
  "review-requested",
  "assigned",
  "authored",
  "mentions",
  "recent",
  "search",
]);
export type GithubMentionBucket = z.infer<typeof githubMentionBucketSchema>;

export const githubMentionRepositorySchema = z.object({
  githubHost: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type GithubMentionRepository = z.infer<
  typeof githubMentionRepositorySchema
>;

const githubMentionRowBaseSchema = githubMentionRepositorySchema.extend({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().min(1),
  author: prActorSchema.nullable(),
  updatedAt: z.number(),
  buckets: z.array(githubMentionBucketSchema),
});

export const githubPullRequestMentionRowSchema =
  githubMentionRowBaseSchema.extend({
    kind: z.literal("pull-request"),
    state: prStateSchema,
    isDraft: z.boolean(),
    baseRefName: z.string().nullable(),
    headRefName: z.string().nullable(),
    reviewDecision: prReviewDecisionSchema.nullable(),
    checksRollup: prChecksRollupSchema.nullable(),
  });
export type GithubPullRequestMentionRow = z.infer<
  typeof githubPullRequestMentionRowSchema
>;

export const githubIssueMentionRowSchema = githubMentionRowBaseSchema.extend({
  kind: z.literal("issue"),
  state: z.enum(["open", "closed"]),
  stateReason: z.string().nullable(),
  labels: z.array(z.string()),
  assignees: z.array(prActorSchema),
});
export type GithubIssueMentionRow = z.infer<typeof githubIssueMentionRowSchema>;

export const githubMentionRowSchema = z.discriminatedUnion("kind", [
  githubPullRequestMentionRowSchema,
  githubIssueMentionRowSchema,
]);
export type GithubMentionRow = z.infer<typeof githubMentionRowSchema>;

export const githubPullRequestMentionFilterSchema = z.object({
  state: z.enum(["open", "merged", "closed", "all"]),
  involvement: z.enum(["everyone", "review-requested", "assigned", "authored"]),
  repository: githubMentionRepositorySchema.nullable(),
});
export type GithubPullRequestMentionFilter = z.infer<
  typeof githubPullRequestMentionFilterSchema
>;

export const githubIssueMentionFilterSchema = z.object({
  state: z.enum(["open", "closed", "all"]),
  involvement: z.enum(["everyone", "assigned", "authored", "mentions"]),
  repository: githubMentionRepositorySchema.nullable(),
});
export type GithubIssueMentionFilter = z.infer<
  typeof githubIssueMentionFilterSchema
>;

const githubMentionRequestBaseSchema = z.object({
  // A null epic is the landing/new-task composer. The host authorizes these
  // requests against the attached workspace paths instead of an epic role.
  epicId: z.string().nullable(),
  workspacePaths: z.array(z.string()).min(1),
});

export const mentionGithubCatalogRequestSchema =
  githubMentionRequestBaseSchema.extend({
    section: githubMentionSectionSchema,
    // This is deliberately a three-way intent, not a boolean. `auto` stays
    // in the interactive lane while an explicit user click gets manual
    // admission; collapsing them would defeat the scheduler's budget floor.
    refresh: githubCatalogRefreshSchema,
  });
export type MentionGithubCatalogRequest = z.infer<
  typeof mentionGithubCatalogRequestSchema
>;

export const mentionGithubCatalogResponseSchema = z.object({
  rows: z.array(githubMentionRowSchema),
  repositories: z.array(githubMentionRepositorySchema).readonly(),
  freshnessAt: z.number().nullable(),
  stale: z.boolean(),
  sourceStatus: prSourceStatusSchema,
  notice: prSourceNoticeSchema.nullable(),
});
export type MentionGithubCatalogResponse = z.infer<
  typeof mentionGithubCatalogResponseSchema
>;

export const mentionGithubSearchRequestSchema = z.discriminatedUnion(
  "section",
  [
    githubMentionRequestBaseSchema.extend({
      section: z.literal("pull-requests"),
      query: z.string(),
      filter: githubPullRequestMentionFilterSchema,
    }),
    githubMentionRequestBaseSchema.extend({
      section: z.literal("issues"),
      query: z.string(),
      filter: githubIssueMentionFilterSchema,
    }),
  ],
);
export type MentionGithubSearchRequest = z.infer<
  typeof mentionGithubSearchRequestSchema
>;

export const mentionGithubSearchResponseSchema = z.object({
  rows: z.array(githubMentionRowSchema),
  sourceStatus: prSourceStatusSchema,
  notice: prSourceNoticeSchema.nullable(),
});
export type MentionGithubSearchResponse = z.infer<
  typeof mentionGithubSearchResponseSchema
>;
