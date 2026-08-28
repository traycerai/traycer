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
 * Frozen copy of the persisted harness enum as the released
 * `chat.subscribe@1.0–1.6` lines shipped it - everything before Reasonix, which
 * first rides `1.7`.
 *
 * This is the SECOND independent copy of the harness enum (the first lives in
 * `host/agent/shared.ts` as `guiHarnessIdSchemaPreReasonix`). They are kept
 * separate on purpose: this one is the PERSISTED spelling, and it reaches the
 * wire through `chatRunSettingsSchema` on released snapshot / `queueChanged`
 * frames. Do NOT add new harnesses here - extend `guiHarnessIdSchema` above.
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
  // Which of the harness's logged-in profiles (subscriptions) this chat runs
  // on. `null` = the ambient/host login, so chats persisted before profiles
  // existed still parse cleanly. See the multi-profile decision log.
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettings = z.infer<typeof chatRunSettingsSchema>;

/**
 * Wire-freeze copy of the settings tuple with `harnessId` pinned to the
 * pre-Reasonix enum. Bound by every released `chat.subscribe@1.0–1.6`
 * server-frame path that carries settings - the queue items embedded in
 * snapshot / `queueChanged` frames, and `chat.settings` on the frozen chat
 * records - so a newer host cannot project `harnessId: "reasonix"` onto a minor
 * whose installed client would reject the whole frame.
 *
 * Hand-frozen field-for-field rather than `chatRunSettingsSchema.extend(...)`:
 * a later required field added to the live tuple must not silently leak into
 * this frozen contract.
 *
 * Client→host coverage is deliberately NARROWER than server→client, and the
 * asymmetry is the point: the host is the side that must stay permissive, since
 * a `1.7` peer has to be able to send `reasonix` in a settings write. Only
 * `chatSubscribeClientFrameSchemaV10` pins this tuple - that line is frozen
 * verbatim against a shipped host and gets the enum pin with everything else.
 * `1.1`-`1.6` client frames still bind the LIVE tuple, which costs nothing
 * today: a released client's own enum cannot spell `reasonix`, so only a
 * crafted peer could send it, and the server-frame freezes above are what stop
 * such a chat from ever being served back to a line that cannot decode it.
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

// The wire-strict variant of `chatRunSettingsSchema`: identical output type,
// but every field is REQUIRED - no `.default(...)` backstops. The defaults
// above exist for PERSISTED records written before a field was introduced;
// on a write path they are a misuse foothold: a caller sending a partial
// tuple would have the omitted fields silently defaulted, turning a
// subset-field "patch" into a null-clobber of settings it never looked at.
// A settings write is a whole-tuple WYSIWYG replace - the caller must state
// every field of the tuple it resolved, so a partial object is a validation
// error instead. Field-level updates get their own narrow methods (e.g.
// `epic.updateChatProfile`); there is deliberately no narrow model/harness
// update - changing the model invalidates the reasoning/thinking/tier
// selection, so it is only expressible as a full tuple.
export const chatRunSettingsStrictSchema = z.object({
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable(),
  agentMode: agentModeSchema,
  profileId: z.string().nullable(),
});
