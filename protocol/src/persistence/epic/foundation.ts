import { z } from "zod";
import {
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  type AgentMode,
} from "@traycer/protocol/common/schemas";

export { DEFAULT_AGENT_MODE, agentModeSchema, type AgentMode };

/**
 * Foundational sub-schemas used across the epic persistence shape:
 * parent reference, token usage, harness ids, permission mode, and chat
 * run settings.
 *
 * Persistence keeps its own harness enums (separate from the host RPC
 * enum in `protocol/host/agent/shared.ts`) so persistence can stay
 * stable while RPC contracts evolve. Names match across layers.
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
  // Adapter-normalized "tokens currently occupying the context window".
  // Single canonical numerator for the "% context left" chip - avoids
  // double-counting cache reads on OpenAI-style SDKs where cached input
  // is a subset of input. See `runtimeTokenUsageSchema.contextTokens`.
  contextTokens: z.number().optional(),
  // Model context window at this turn. Adapter-sourced from its SDK; never
  // hardcoded.
  contextWindow: z.number().optional(),
  // Always-present tokens (fixed system prompt + tools) that the renderer
  // folds into the displayed used total while keeping contextWindow as the
  // reported model capacity. Harnesses without a separate baseline omit it.
  // See `runtimeTokenUsageSchema`.
  contextBaselineTokens: z.number().optional(),
  // Cumulative billed cost for the turn in USD, where the SDK reports it
  // (Claude/OpenCode). Omitted by harnesses without a price; the cost row in
  // the usage tooltip hides without it. See `runtimeTokenUsageSchema.costUsd`.
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
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
]);
export type GuiHarnessId = z.infer<typeof guiHarnessIdSchema>;

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

// Canonical full set of permission modes, ordered most-restrictive to
// most-permissive. Single source of truth shared by:
//   - the host-RPC schema default for protocol skew (unary-schemas.ts)
//   - adapter declarations that honor every mode (claude, codex, opencode)
//   - the renderer's safest-fallback clamp (normalizePermissionMode)
// Adding a mode here propagates to every consumer; never duplicate this list.
export const ALL_PERMISSION_MODES: readonly PermissionMode[] =
  permissionModeSchema.options;

export const chatRunSettingsSchema = z.object({
  harnessId: guiHarnessIdSchema,
  // Concrete model slug; there is no "use the harness default" sentinel. The
  // renderer resolves a real model (defaulting to the provider's first listed
  // model) before a turn is sent.
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  // Codex-style service / speed tier (e.g. `"fast"`). Defaults to null so
  // chats persisted before this field was introduced still parse cleanly.
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
});
export type ChatRunSettings = z.infer<typeof chatRunSettingsSchema>;
