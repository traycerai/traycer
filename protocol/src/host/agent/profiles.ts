/**
 * Agent-facing provider-profile discovery, on-demand rate-limit reads, and
 * atomic GUI-agent reconfiguration - the additive RPC family the A2A
 * profile-awareness epic adds alongside `agent.create@2.0`'s
 * `profileSelection` (see `shared.ts`).
 *
 * All three methods are registered outside `RELEASED_FLOOR_METHOD_NAMES`
 * with `degrade: { kind: "unsupported" }` (see `host/registry.ts`): an old
 * host simply lacks them, and callers get per-call upgrade guidance instead
 * of a fatal handshake mismatch.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { agentModeSchema } from "@traycer/protocol/common/schemas";
import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  providerIdSchema,
  providerProfileRateLimitStatusSchema,
} from "@traycer/protocol/host/provider-schemas";
import { providerRateLimitsSchema } from "@traycer/protocol/host/rate-limit/schemas";
import {
  agentFacingHarnessIdSchema,
  concreteProfileSelectionSchema,
  guiHarnessIdSchema,
} from "@traycer/protocol/host/agent/shared";

// ─── `agent.listProviderProfiles@1.0` ─────────────────────────────────────
//
// Discovers the profiles available for one harness's provider: the ambient
// CLI login plus any Traycer-managed subscriptions, with their cached
// rate-limit status. Harness-scoped (not provider-scoped) because creation
// and model catalogs are also keyed by `harnessId`; the response echoes the
// mapped `providerId` for transparency.

export const agentListProviderProfilesRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  harnessId: agentFacingHarnessIdSchema,
});
export type AgentListProviderProfilesRequest = z.infer<
  typeof agentListProviderProfilesRequestSchema
>;

/**
 * One selectable row: the harness's provider's ambient login, or one of its
 * managed profiles. Deliberately narrow - a projection of `ProviderProfile`
 * (`provider-schemas.ts`), not a reuse of its wire type - so email, account
 * UUID, tier identity, config paths, environment overrides, CLI candidates,
 * and credential-derived labels never reach an agent. See the A2A
 * profile-awareness ticket's guardrails.
 *
 * `selection.kind` (`ambient` | `profile`) is the sole ambient-vs-managed
 * discriminant - there is deliberately no separate `kind` field, so a row
 * can never claim ambient/managed identity that disagrees with its own
 * selection (the batch-1 review's "structurally correlate or remove the
 * redundant independent kind" finding).
 */
export const agentProviderProfileSummarySchema = z.object({
  selection: concreteProfileSelectionSchema,
  label: z.string(),
  authStatus: PROVIDER_AUTH_STATUS_SCHEMA,
  rateLimitStatus: providerProfileRateLimitStatusSchema,
  usageUpdatedAt: z.number().nullable(),
  isEffectiveLastUsed: z.boolean(),
});
export type AgentProviderProfileSummary = z.infer<
  typeof agentProviderProfileSummarySchema
>;

export const agentListProviderProfilesResponseSchema = z.object({
  providerId: providerIdSchema,
  profiles: z.array(agentProviderProfileSummarySchema),
});
export type AgentListProviderProfilesResponse = z.infer<
  typeof agentListProviderProfilesResponseSchema
>;

export const agentListProviderProfilesV10 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchema,
});

// ─── `agent.getProviderProfileRateLimits@1.0` ─────────────────────────────
//
// On-demand detailed rate-limit read for one concrete profile selection
// (ambient or a specific managed profile) - distinct from the cached
// `rateLimitStatus` summary `agent.listProviderProfiles` returns for every
// row. `last_used`/`inherit_sender` are not accepted: the caller must
// already know which concrete profile it wants a fresh read for.

export const agentGetProviderProfileRateLimitsRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  harnessId: agentFacingHarnessIdSchema,
  profileSelection: concreteProfileSelectionSchema,
});
export type AgentGetProviderProfileRateLimitsRequest = z.infer<
  typeof agentGetProviderProfileRateLimitsRequestSchema
>;

// No standalone `providerId` field: every arm of `providerRateLimitsSchema`
// (including the `available: false` arm) already carries its own `provider`,
// so an outer field would be a second, independently-settable source of
// truth that could disagree with the nested one (the batch-1 review's
// "remove or validate redundant provider identity" finding). Callers read
// `rateLimits.provider`.
export const agentGetProviderProfileRateLimitsResponseSchema = z.object({
  rateLimits: providerRateLimitsSchema,
  usageUpdatedAt: z.number().nullable(),
});
export type AgentGetProviderProfileRateLimitsResponse = z.infer<
  typeof agentGetProviderProfileRateLimitsResponseSchema
>;

export const agentGetProviderProfileRateLimitsV10 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchema,
});

// ─── `agent.configure@1.0` ─────────────────────────────────────────────────
//
// Atomically switches the provider, profile, and model an existing local GUI
// agent uses for future turns. Carries the full target run tuple rather than
// a partial patch: `permissionMode` and `agentMode` are deliberately absent
// from the request (the resolver preserves the target chat's current values)
// but appear in the response's committed `settings` alongside everything the
// caller did specify.

export const agentConfigureRequestSchema = z.object({
  epicId: z.string(),
  senderAgentId: z.string(),
  agentId: z.string(),
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
});
export type AgentConfigureRequest = z.infer<typeof agentConfigureRequestSchema>;

export const agentConfigureSettingsSchema = z.object({
  harnessId: guiHarnessIdSchema,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
  permissionMode: permissionModeSchema,
  agentMode: agentModeSchema,
});
export type AgentConfigureSettings = z.infer<
  typeof agentConfigureSettingsSchema
>;

export const agentConfigureResponseSchema = z.object({
  settings: agentConfigureSettingsSchema,
  warnings: z.array(z.string()),
});
export type AgentConfigureResponse = z.infer<
  typeof agentConfigureResponseSchema
>;

export const agentConfigureV10 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchema,
  responseSchema: agentConfigureResponseSchema,
});
