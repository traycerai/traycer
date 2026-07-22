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
import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { agentModeSchema } from "@traycer/protocol/common/schemas";
import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  PROVIDER_AUTH_STATUS_SCHEMA,
  providerIdSchema,
  providerIdSchemaV40,
  providerProfileRateLimitStatusSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerRateLimitsSchema,
  providerRateLimitsSchemaV40,
} from "@traycer/protocol/host/rate-limit/schemas";
import {
  agentFacingHarnessIdSchema,
  concreteProfileSelectionSchema,
  guiHarnessIdSchema,
  guiHarnessIdSchemaV40,
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

/**
 * Frozen `agent.listProviderProfiles@1.0` response, pinned to the pre-Hermes
 * provider id set (`providerIdSchemaV40`) so an already-shipped v1.0 caller's
 * strict decode never sees `hermes`. The v2.0 line adds it via the live,
 * still-growing `agentListProviderProfilesResponseSchema` above, with a
 * v2->v1 downgrade bridge that fails closed (`DOWNGRADE_UNSUPPORTED`) for a
 * Hermes-only provider id instead of silently mis-decoding it. Do NOT widen
 * this schema - extend the latest schema and use the v2 bridge instead.
 */
export const agentListProviderProfilesResponseSchemaV1 = z.object({
  providerId: providerIdSchemaV40,
  profiles: z.array(agentProviderProfileSummarySchema),
});
export type AgentListProviderProfilesResponseV1 = z.infer<
  typeof agentListProviderProfilesResponseSchemaV1
>;

export const agentListProviderProfilesV10 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchemaV1,
});

export const agentListProviderProfilesV20 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchema,
});

export const agentListProviderProfilesUpgradeV10ToV20 = defineUpgradePath<
  typeof agentListProviderProfilesV10,
  typeof agentListProviderProfilesV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  // Request shape is identical across both majors - only the response's
  // `providerId` enum grows (Hermes).
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListProviderProfilesDowngradeV20ToV10 = defineDowngradePath<
  typeof agentListProviderProfilesV20,
  typeof agentListProviderProfilesV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // A v1.0 caller only ever configures/lists a pre-hermes provider, so the
    // common case reparses cleanly through the frozen schema. Fails closed
    // (rather than silently mis-decoding) for a Hermes-only provider id.
    const parsed =
      agentListProviderProfilesResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing Hermes provider profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
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

/**
 * Frozen `agent.getProviderProfileRateLimits@1.0` response, pinned to the
 * pre-Hermes `rateLimits.provider` enum (`providerRateLimitsSchemaV40`, whose
 * `available: false` arm carries `providerIdSchemaV40`) so an already-shipped
 * v1.0 caller's strict decode never sees `hermes`. The v2.0 line adds it via
 * the live, still-growing `agentGetProviderProfileRateLimitsResponseSchema`
 * above, with a v2->v1 downgrade bridge that fails closed
 * (`DOWNGRADE_UNSUPPORTED`) for a Hermes rate-limit read instead of silently
 * mis-decoding it. Do NOT widen this schema - extend the latest schema and
 * use the v2 bridge instead.
 */
export const agentGetProviderProfileRateLimitsResponseSchemaV1 = z.object({
  rateLimits: providerRateLimitsSchemaV40,
  usageUpdatedAt: z.number().nullable(),
});
export type AgentGetProviderProfileRateLimitsResponseV1 = z.infer<
  typeof agentGetProviderProfileRateLimitsResponseSchemaV1
>;

export const agentGetProviderProfileRateLimitsV10 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchemaV1,
});

export const agentGetProviderProfileRateLimitsV20 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchema,
});

export const agentGetProviderProfileRateLimitsUpgradeV10ToV20 =
  defineUpgradePath<
    typeof agentGetProviderProfileRateLimitsV10,
    typeof agentGetProviderProfileRateLimitsV20
  >({
    from: { major: 1, minor: 0 },
    to: { major: 2, minor: 0 },
    // Request shape is identical across both majors - only the response's
    // `rateLimits.provider` enum grows (Hermes).
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });

export const agentGetProviderProfileRateLimitsDowngradeV20ToV10 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV20,
    typeof agentGetProviderProfileRateLimitsV10
  >({
    from: { major: 2, minor: 0 },
    to: { major: 1, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Grok is representable in the frozen provider enum (it predates Hermes),
      // so a grok-available snapshot degrades to the unavailable
      // `unsupported_provider` shape - the exact row a v1.0 host returns for
      // grok today - rather than being dropped. A Hermes rate-limit read stays
      // unrepresentable on the frozen v1.0 wire and still fails closed below.
      const rateLimits =
        response.rateLimits.available &&
        response.rateLimits.provider === "grok"
          ? {
              provider: "grok",
              available: false,
              reason: "unsupported_provider",
            }
          : response.rateLimits;
      // A v1.0 caller only ever reads pre-hermes rate limits, so the common
      // case reparses cleanly through the frozen schema. Fails closed
      // (rather than silently mis-decoding) for any provider unrepresentable
      // on the frozen v1.0 wire (Hermes today).
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV1.safeParse({
          ...response,
          rateLimits,
        });
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "DOWNGRADE_UNSUPPORTED",
            message:
              "Reading rate limits for this provider requires a newer Traycer client.",
          },
        };
      }
      return { ok: true, value: parsed.data };
    },
  });

// ─── `agent.configure@1.0` / `2.0` ─────────────────────────────────────────
//
// Released v1.0 atomically switches provider/profile/model while preserving
// the target's permission mode. V2.0 adds an explicit permission choice to the
// full future-run tuple. `null` is compatibility-only and is produced by the
// v1->v2 upgrade so old callers retain the preserve-current behavior.

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

export const agentConfigureRequestSchemaV20 =
  agentConfigureRequestSchema.extend({
    permissionMode: permissionModeSchema.nullable(),
  });
export type AgentConfigureRequestV20 = z.infer<
  typeof agentConfigureRequestSchemaV20
>;

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

/**
 * Frozen `agent.configure@1.0` settings/response, pinned to the pre-Hermes
 * harness id set (`guiHarnessIdSchemaV40`) so an already-shipped v1.0
 * caller's strict decode never sees `harnessId: "hermes"`. The v2.0 line
 * (below) carries it via the live, still-growing `agentConfigureSettingsSchema`
 * / `agentConfigureResponseSchema` above; `agentConfigureDowngradeV20ToV10`'s
 * response bridge fails closed (`DOWNGRADE_UNSUPPORTED`) instead of silently
 * mis-decoding a Hermes-configured agent for a v1.0 caller. Do NOT widen this
 * schema - extend the latest schema and use the existing v2 bridge instead.
 */
export const agentConfigureSettingsSchemaV1 = z.object({
  harnessId: guiHarnessIdSchemaV40,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
  permissionMode: permissionModeSchema,
  agentMode: agentModeSchema,
});
export type AgentConfigureSettingsV1 = z.infer<
  typeof agentConfigureSettingsSchemaV1
>;

export const agentConfigureResponseSchemaV1 = z.object({
  settings: agentConfigureSettingsSchemaV1,
  warnings: z.array(z.string()),
});
export type AgentConfigureResponseV1 = z.infer<
  typeof agentConfigureResponseSchemaV1
>;

export const agentConfigureV10 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchema,
  responseSchema: agentConfigureResponseSchemaV1,
});

export const agentConfigureV20 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchemaV20,
  responseSchema: agentConfigureResponseSchema,
});

export const agentConfigureUpgradeV10ToV20 = defineUpgradePath<
  typeof agentConfigureV10,
  typeof agentConfigureV20
>({
  from: { major: 1, minor: 0 },
  to: { major: 2, minor: 0 },
  upgradeRequest: (request) => ({ ...request, permissionMode: null }),
  upgradeResponse: (response) => response,
});

export const agentConfigureDowngradeV20ToV10 = defineDowngradePath<
  typeof agentConfigureV20,
  typeof agentConfigureV10
>({
  from: { major: 2, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before configuring this agent.",
    },
  }),
  downgradeResponse: (response) => {
    // `settings.harnessId` echoes the configured agent's harness; a v1.0
    // caller only ever configures a pre-hermes harness, so the common case
    // reparses cleanly through the frozen schema. A Hermes-configured
    // response (unreachable from a v1.0 REQUEST today, but this bridge must
    // still hold if that ever changes) cannot be represented on the frozen
    // v1.0 wire, so this fails closed instead of silently mis-decoding it.
    const parsed = agentConfigureResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring a Hermes agent requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});
