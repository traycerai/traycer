import { z } from "zod";

/** Private Zod values for the non-recursive common-vocabulary records. */

export const attachmentMentionAttrsSchema = z.object({
  contextType: z.literal("attachment"),
  fileName: z.string(),
  b64content: z.string().optional(),
  url: z.string().optional(),
  altText: z.string().optional(),
});

export const attachmentMentionNodeSchema = z.object({
  type: z.literal("mention"),
  attrs: attachmentMentionAttrsSchema,
});

export const permissionRoleSchema = z.enum(["owner", "editor", "viewer"]);

export const ticketStatusSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);

export const epicArtifactKindSchema = z.enum([
  "spec",
  "ticket",
  "story",
  "review",
]);

export const harnessIdSchemaPreReasonix = z.enum([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
]);

export const harnessIdSchema = z.enum([
  ...harnessIdSchemaPreReasonix.options,
  "reasonix",
]);
