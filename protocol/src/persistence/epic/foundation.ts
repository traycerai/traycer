import { z } from "zod";
import {
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  type AgentMode,
} from "@traycer/protocol/common/schemas";

export { DEFAULT_AGENT_MODE, agentModeSchema, type AgentMode };

/**
 * Foundational sub-schemas used across the epic persistence shape: parent reference, token usage, harness ids, permission mode, and chat run settings.
 */

// ---- Parent reference ------------------------------------------------- //

export const parentArtifactReferenceSchema = z.object({
  parentId: z.string().nullable(),
});
export type ParentArtifactReference = z.infer<
  typeof parentArtifactReferenceSchema
>;

// ---- Token usage ----------------------------------------------------- //

export const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  contextTokens: z.number().optional(),
  // Model context window at this turn. Adapter-sourced from its SDK; never
  // hardcoded.
  contextWindow: z.number().optional(),
  contextBaselineTokens: z.number().optional(),
  // Cumulative billed cost for the turn in USD, where the SDK reports it (Claude/OpenCode).
  costUsd: z.number().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

// ---- Harness identity ------------------------------------------------ //

export const guiHarnessIdSchema = z.enum([
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
  "reasonix",
]);
export type GuiHarnessId = z.infer<typeof guiHarnessIdSchema>;

/**
 * Frozen copy of the persisted harness enum as the released `chat.subscribe@1.0-1.6` lines shipped it - everything before Reasonix, which first rides `1.7`.
 * Do NOT add new harnesses here - extend `guiHarnessIdSchema` above.
 */
export const guiHarnessIdSchemaPreReasonix = z.enum([
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
export type GuiHarnessIdPreReasonix = z.infer<
  typeof guiHarnessIdSchemaPreReasonix
>;

// Cursor remains a reserved compatibility value: it shipped in this persisted
// enum before the unfinished runtime surface was withdrawn from the product.
export const tuiHarnessIdSchema = z.enum([
  "claude",
  "codex",
  "opencode",
  "cursor",
]);
export type TuiHarnessId = z.infer<typeof tuiHarnessIdSchema>;

// ---- Permission + run settings --------------------------------------- //

export const permissionModeSchema = z.enum([
  "supervised",
  "auto_accept_edits",
  "full_access",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

// Canonical full set of permission modes, ordered most-restrictive to most-permissive.
export const ALL_PERMISSION_MODES: readonly PermissionMode[] =
  permissionModeSchema.options;

export const chatRunSettingsSchema = z.object({
  harnessId: guiHarnessIdSchema,
  // Concrete model slug; there is no "use the harness default" sentinel.
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  // Codex-style service / speed tier (e.g. `"fast"`). Defaults to null so
  // chats persisted before this field was introduced still parse cleanly.
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  // Which of the harness's logged-in profiles (subscriptions) this chat runs on.
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettings = z.infer<typeof chatRunSettingsSchema>;

/**
 * Wire-freeze copy of the settings tuple with `harnessId` pinned to the pre-Reasonix enum.
 * Only `chatSubscribeClientFrameSchemaV10` pins this tuple - that line is frozen verbatim against a shipped host and gets the enum pin with everything else.
 */
export const chatRunSettingsSchemaPreReasonix = z.object({
  harnessId: guiHarnessIdSchemaPreReasonix,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettingsPreReasonix = z.infer<
  typeof chatRunSettingsSchemaPreReasonix
>;

// The wire-strict variant of `chatRunSettingsSchema`: identical output type, but every field is REQUIRED - no `.default(...)` backstops.
// A settings write is a whole-tuple WYSIWYG replace - the caller must state every field of the tuple it resolved, so a partial object is a validation error instead.
export const chatRunSettingsStrictSchema = z.object({
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable(),
  agentMode: agentModeSchema,
  profileId: z.string().nullable(),
});
