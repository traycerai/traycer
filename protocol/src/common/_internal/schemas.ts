import { z } from "zod";

/**
 * Private Zod values for the non-recursive common-vocabulary records.
 *
 * These schemas are the contract authority for their record types.
 * Consumers obtain the runtime schema through
 * `getRecordSchema(commonRecordRegistry, "<record-name>", "latest")`
 * and the inferred TypeScript type through
 * `RecordValue<typeof commonRecordRegistry, "<record-name>">`. There
 * are no public TS type aliases for record shapes - the Zod schema is
 * the single source of truth.
 *
 * The recursive `json-content` record lives in
 * `protocol/common/registry.ts` next to the registry: `z.lazy()`
 * requires an explicit `z.ZodType<JsonContent>` annotation, and the
 * `JsonContent` type alias has to live wherever it can be named
 * without leaking out of `_internal/`. Co-locating both with the
 * registry keeps `_internal/` free of any type that crosses the
 * privacy boundary.
 */

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

export const harnessIdSchema = z.enum([
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
]);
