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
  providerIdSchemaV50,
  providerIdSchemaV60,
  providerIdSchemaV70,
  providerProfileRateLimitStatusSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  mapCursorAvailableToUnavailable,
  mapGrokAvailableToUnavailable,
  mapOpenCodeAvailableToUnavailable,
  providerRateLimitsSchema,
  providerRateLimitsSchemaV40,
  providerRateLimitsSchemaV50,
  providerRateLimitsSchemaV60,
  providerRateLimitsSchemaV70,
} from "@traycer/protocol/host/rate-limit/schemas";
import {
  agentFacingHarnessIdSchema,
  concreteProfileSelectionSchema,
  guiHarnessIdSchema,
  guiHarnessIdSchemaV40,
  guiHarnessIdSchemaV50,
  guiHarnessIdSchemaV60,
  guiHarnessIdSchemaV70,
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
 * strict decode never sees a post-v4.0 provider (`hermes`, `omp`). The v2.0
 * line adds them via the live, still-growing
 * `agentListProviderProfilesResponseSchema` above, with a v2->v1 downgrade
 * bridge that fails closed (`DOWNGRADE_UNSUPPORTED`) for a post-v4.0-only
 * provider id instead of silently mis-decoding it. Do NOT widen this schema -
 * extend the latest schema and use the v2 bridge instead.
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

/**
 * Frozen `agent.listProviderProfiles@2.0` response, pinned to the pre-omp
 * provider id set (`providerIdSchemaV50`) so an already-shipped v2.0 caller's
 * strict decode never sees `omp`.
 *
 * This line IS released - the v1.1.8 tags (2026-07-25) shipped it. Until then
 * it pointed at the live `agentListProviderProfilesResponseSchema`, which is
 * how `omp` first tried to ride v2.0. The v3.0 line now carries the live
 * schema, with a v3->v2 downgrade bridge that fails closed
 * (`DOWNGRADE_UNSUPPORTED`) for a post-v5.0-only provider id. Do NOT widen
 * this schema - extend the latest schema and use the v3 bridge instead.
 */
export const agentListProviderProfilesResponseSchemaV2 = z.object({
  providerId: providerIdSchemaV50,
  profiles: z.array(agentProviderProfileSummarySchema),
});
export type AgentListProviderProfilesResponseV2 = z.infer<
  typeof agentListProviderProfilesResponseSchemaV2
>;

export const agentListProviderProfilesV20 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchemaV2,
});

/**
 * Frozen `agent.listProviderProfiles@3.0` response, pinned to the
 * pre-Hugging-Face provider id set (`providerIdSchemaV60`) so an
 * already-shipped v3.0 caller's strict decode never sees `huggingface`.
 *
 * This line IS released - the v1.1.9 tags (2026-07-29) shipped it. Until then
 * it pointed at the live `agentListProviderProfilesResponseSchema`, which is
 * the same defect that let `omp` first try to ride v2.0. The v4.0 line now
 * carries the live schema, with a v4->v3 downgrade bridge that fails closed
 * (`DOWNGRADE_UNSUPPORTED`) for a post-v6.0-only provider id. Do NOT widen
 * this schema - extend the latest schema and use the v4 bridge instead.
 */
export const agentListProviderProfilesResponseSchemaV3 = z.object({
  providerId: providerIdSchemaV60,
  profiles: z.array(agentProviderProfileSummarySchema),
});
export type AgentListProviderProfilesResponseV3 = z.infer<
  typeof agentListProviderProfilesResponseSchemaV3
>;

export const agentListProviderProfilesV30 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchemaV3,
});

/**
 * Frozen `agent.listProviderProfiles@4.0` response, pinned to the pre-Reasonix
 * provider id set (`providerIdSchemaV70`) so an already-shipped v4.0 caller's
 * strict decode never sees `reasonix`.
 *
 * This line IS released - the v1.2.0 tags (2026-08-24) shipped it. Until then
 * it pointed at the live `agentListProviderProfilesResponseSchema`, which is
 * the same defect that let `omp` first try to ride v2.0 and `huggingface` v3.0.
 * The v5.0 line now carries the live schema, with a v5->v4 downgrade bridge
 * that fails closed (`DOWNGRADE_UNSUPPORTED`) for a post-v7.0-only provider id.
 * Do NOT widen this schema - extend the latest schema and use the v5 bridge
 * instead.
 */
export const agentListProviderProfilesResponseSchemaV4 = z.object({
  providerId: providerIdSchemaV70,
  profiles: z.array(agentProviderProfileSummarySchema),
});
export type AgentListProviderProfilesResponseV4 = z.infer<
  typeof agentListProviderProfilesResponseSchemaV4
>;

export const agentListProviderProfilesV40 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: agentListProviderProfilesRequestSchema,
  responseSchema: agentListProviderProfilesResponseSchemaV4,
});

export const agentListProviderProfilesV50 = defineRpcContract({
  method: "agent.listProviderProfiles",
  schemaVersion: { major: 5, minor: 0 } as const,
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
  // `providerId` enum grows (Hermes, omp).
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
    // (rather than silently mis-decoding) for any provider unrepresentable on
    // the frozen v1.0 wire (Hermes and omp today) - the message deliberately
    // names no single provider so it stays honest as the enum grows.
    const parsed =
      agentListProviderProfilesResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesUpgradeV20ToV30 = defineUpgradePath<
  typeof agentListProviderProfilesV20,
  typeof agentListProviderProfilesV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  // Request shape is identical across both majors - only the response's
  // `providerId` enum grows (omp).
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListProviderProfilesDowngradeV30ToV20 = defineDowngradePath<
  typeof agentListProviderProfilesV30,
  typeof agentListProviderProfilesV20
>({
  from: { major: 3, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // A v2.0 caller only ever lists a pre-omp provider, so the common case
    // reparses cleanly through the frozen schema. Fails closed (rather than
    // silently mis-decoding) for any provider unrepresentable on the frozen
    // v2.0 wire (omp today). Unlike the list-shaped catalog methods, this
    // response carries exactly one provider - there is nothing to filter out,
    // so the only honest options are pass-through or refuse.
    const parsed =
      agentListProviderProfilesResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV30ToV10 = defineDowngradePath<
  typeof agentListProviderProfilesV30,
  typeof agentListProviderProfilesV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule as the v3->v2 bridge, against the narrower v1.0
    // enum: anything post-v4.0 (Hermes, omp) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesUpgradeV30ToV40 = defineUpgradePath<
  typeof agentListProviderProfilesV30,
  typeof agentListProviderProfilesV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // Request shape is identical across both majors - only the response's
  // `providerId` enum grows (huggingface).
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListProviderProfilesDowngradeV40ToV30 = defineDowngradePath<
  typeof agentListProviderProfilesV40,
  typeof agentListProviderProfilesV30
>({
  from: { major: 4, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // A v3.0 caller only ever lists a pre-Hugging-Face provider, so the common
    // case reparses cleanly through the frozen schema. Fails closed (rather
    // than silently mis-decoding) for any provider unrepresentable on the
    // frozen v3.0 wire. This response carries exactly one provider - there is
    // nothing to filter out, so the only honest options are pass-through or
    // refuse. The message deliberately names no provider so it stays honest as
    // the enum grows.
    const parsed =
      agentListProviderProfilesResponseSchemaV3.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV40ToV20 = defineDowngradePath<
  typeof agentListProviderProfilesV40,
  typeof agentListProviderProfilesV20
>({
  from: { major: 4, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule as the v4->v3 bridge, against the narrower v2.0
    // enum: anything post-v5.0 (omp, huggingface) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV40ToV10 = defineDowngradePath<
  typeof agentListProviderProfilesV40,
  typeof agentListProviderProfilesV10
>({
  from: { major: 4, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule against the narrowest enum: anything post-v4.0
    // (Hermes, omp, huggingface) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesUpgradeV40ToV50 = defineUpgradePath<
  typeof agentListProviderProfilesV40,
  typeof agentListProviderProfilesV50
>({
  from: { major: 4, minor: 0 },
  to: { major: 5, minor: 0 },
  // Request shape is identical across both majors - only the response's
  // `providerId` enum grows (reasonix).
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentListProviderProfilesDowngradeV50ToV40 = defineDowngradePath<
  typeof agentListProviderProfilesV50,
  typeof agentListProviderProfilesV40
>({
  from: { major: 5, minor: 0 },
  to: { major: 4, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // A v4.0 caller only ever lists a pre-Reasonix provider, so the common case
    // reparses cleanly through the frozen schema. Fails closed (rather than
    // silently mis-decoding) for any provider unrepresentable on the frozen
    // v4.0 wire. This response carries exactly one provider - there is nothing
    // to filter out, so the only honest options are pass-through or refuse. The
    // message deliberately names no provider so it stays honest as the enum
    // grows.
    const parsed =
      agentListProviderProfilesResponseSchemaV4.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV50ToV30 = defineDowngradePath<
  typeof agentListProviderProfilesV50,
  typeof agentListProviderProfilesV30
>({
  from: { major: 5, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule as the v5->v4 bridge, against the narrower v3.0
    // enum: anything post-v6.0 (huggingface, reasonix) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV3.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV50ToV20 = defineDowngradePath<
  typeof agentListProviderProfilesV50,
  typeof agentListProviderProfilesV20
>({
  from: { major: 5, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule against the narrower v2.0 enum: anything post-v5.0
    // (omp, huggingface, reasonix) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentListProviderProfilesDowngradeV50ToV10 = defineDowngradePath<
  typeof agentListProviderProfilesV50,
  typeof agentListProviderProfilesV10
>({
  from: { major: 5, minor: 0 },
  to: { major: 1, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Same fail-closed rule against the narrowest enum: anything post-v4.0
    // (Hermes, omp, huggingface, reasonix) is unrepresentable here.
    const parsed =
      agentListProviderProfilesResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Listing this provider's profiles requires a newer Traycer client.",
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
 * v1.0 caller's strict decode never sees a post-v4.0 provider (`hermes`,
 * `omp`). The v2.0 line adds them via the live, still-growing
 * `agentGetProviderProfileRateLimitsResponseSchema` above, with a v2->v1
 * downgrade bridge that fails closed (`DOWNGRADE_UNSUPPORTED`) for such a
 * rate-limit read instead of silently mis-decoding it. Do NOT widen this
 * schema - extend the latest schema and use the v2 bridge instead.
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

/**
 * Frozen `agent.getProviderProfileRateLimits@2.0` response, pinned to the
 * pre-omp `rateLimits.provider` enum (`providerRateLimitsSchemaV50`, whose
 * `available: false` arm carries `providerIdSchemaV50`) so an already-shipped
 * v2.0 caller's strict decode never sees `omp`.
 *
 * This line IS released - the v1.1.8 tags (2026-07-25) shipped it. Note the
 * frozen union here KEEPS the grok available arm (unlike the v1.0 one): grok
 * rate limits predate those tags, so v2.0 really did ship with it. The v3.0
 * line carries the live schema, with a v3->v2 downgrade bridge that fails
 * closed (`DOWNGRADE_UNSUPPORTED`). Do NOT widen this schema - extend the
 * latest schema and use the v3 bridge instead.
 */
export const agentGetProviderProfileRateLimitsResponseSchemaV2 = z.object({
  rateLimits: providerRateLimitsSchemaV50,
  usageUpdatedAt: z.number().nullable(),
});
export type AgentGetProviderProfileRateLimitsResponseV2 = z.infer<
  typeof agentGetProviderProfileRateLimitsResponseSchemaV2
>;

export const agentGetProviderProfileRateLimitsV20 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchemaV2,
});

/**
 * Frozen `agent.getProviderProfileRateLimits@3.0` response, pinned to the
 * pre-Hugging-Face `rateLimits.provider` enum (`providerRateLimitsSchemaV60`,
 * whose `available: false` arm carries `providerIdSchemaV60`) so an
 * already-shipped v3.0 caller's strict decode never sees `huggingface`.
 *
 * This line IS released - the v1.1.9 tags (2026-07-29) shipped it. Until then
 * it pointed at the live schema, which is how a new provider id could grow an
 * already-shipped line. The frozen union here KEEPS the grok available arm
 * (grok rate limits long predate those tags). The v4.0 line carries the live
 * schema, with a v4->v3 downgrade bridge that fails closed
 * (`DOWNGRADE_UNSUPPORTED`). Do NOT widen this schema - extend the latest
 * schema and use the v4 bridge instead.
 */
export const agentGetProviderProfileRateLimitsResponseSchemaV3 = z.object({
  rateLimits: providerRateLimitsSchemaV60,
  usageUpdatedAt: z.number().nullable(),
});
export type AgentGetProviderProfileRateLimitsResponseV3 = z.infer<
  typeof agentGetProviderProfileRateLimitsResponseSchemaV3
>;

export const agentGetProviderProfileRateLimitsV30 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchemaV3,
});

/**
 * Frozen `agent.getProviderProfileRateLimits@4.0` response, pinned to the
 * pre-Reasonix `rateLimits.provider` enum (`providerRateLimitsSchemaV70`, whose
 * `available: false` arm carries `providerIdSchemaV70`) so an already-shipped
 * v4.0 caller's strict decode never sees `reasonix`.
 *
 * This line IS released - the v1.2.0 tags (2026-08-24) shipped it. Its comment
 * used to read "`4` is the newest major and no released peer has ever
 * negotiated it", which is exactly the sentence that stops being true the
 * moment a tag ships, and exactly how `omp` first tried to ride v2.0. The v5.0
 * line now carries the live schema, with a v5->v4 downgrade bridge that fails
 * closed (`DOWNGRADE_UNSUPPORTED`). Do NOT widen this schema - extend the
 * latest schema and use the v5 bridge instead.
 */
export const agentGetProviderProfileRateLimitsResponseSchemaV4 = z.object({
  rateLimits: providerRateLimitsSchemaV70,
  usageUpdatedAt: z.number().nullable(),
});
export type AgentGetProviderProfileRateLimitsResponseV4 = z.infer<
  typeof agentGetProviderProfileRateLimitsResponseSchemaV4
>;

export const agentGetProviderProfileRateLimitsV40 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchemaV4,
});

// The LIVE line: ranges over `providerRateLimitsSchema` rather than a frozen
// snapshot, because `5` is the newest major and no released peer has ever
// negotiated it (the newest released baseline tops out at `4`). It stops being
// the live line the moment a tag ships it - see the v4.0 block above for what
// that costs when it is missed.
export const agentGetProviderProfileRateLimitsResponseSchemaV5 = z.object({
  rateLimits: providerRateLimitsSchema,
  usageUpdatedAt: z.number().nullable(),
});

export const agentGetProviderProfileRateLimitsV50 = defineRpcContract({
  method: "agent.getProviderProfileRateLimits",
  schemaVersion: { major: 5, minor: 0 } as const,
  requestSchema: agentGetProviderProfileRateLimitsRequestSchema,
  responseSchema: agentGetProviderProfileRateLimitsResponseSchemaV5,
});

export const agentGetProviderProfileRateLimitsUpgradeV10ToV20 =
  defineUpgradePath<
    typeof agentGetProviderProfileRateLimitsV10,
    typeof agentGetProviderProfileRateLimitsV20
  >({
    from: { major: 1, minor: 0 },
    to: { major: 2, minor: 0 },
    // Request shape is identical across both majors - only the response's
    // `rateLimits.provider` enum grows (Hermes, omp).
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
      // `unsupported_provider` shape (via the shared bridge map) - the exact row
      // a v1.0 host returns for grok today - rather than being dropped. A
      // post-v4.0 provider's rate-limit read (Hermes, omp) stays
      // unrepresentable on the frozen v1.0 wire and still fails closed below.
      const rateLimits = mapGrokAvailableToUnavailable(response.rateLimits);
      // A v1.0 caller only ever reads pre-hermes rate limits, so the common
      // case reparses cleanly through the frozen schema. Fails closed
      // (rather than silently mis-decoding) for any provider unrepresentable
      // on the frozen v1.0 wire (Hermes and omp today).
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

export const agentGetProviderProfileRateLimitsUpgradeV20ToV30 =
  defineUpgradePath<
    typeof agentGetProviderProfileRateLimitsV20,
    typeof agentGetProviderProfileRateLimitsV30
  >({
    from: { major: 2, minor: 0 },
    to: { major: 3, minor: 0 },
    // Request shape is identical across both majors - only the response's
    // `rateLimits.provider` enum grows (omp).
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });

export const agentGetProviderProfileRateLimitsDowngradeV30ToV20 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV30,
    typeof agentGetProviderProfileRateLimitsV20
  >({
    from: { major: 3, minor: 0 },
    to: { major: 2, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // No grok degrade here: the frozen v2.0 union keeps the grok available
      // arm (grok rate limits predate the v1.1.8 tags), so a grok snapshot
      // reparses as-is. Only `omp` is unrepresentable, and this response
      // carries exactly one provider - so fail closed rather than mis-decode.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV2.safeParse(response);
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

export const agentGetProviderProfileRateLimitsDowngradeV30ToV10 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV30,
    typeof agentGetProviderProfileRateLimitsV10
  >({
    from: { major: 3, minor: 0 },
    to: { major: 1, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Unlike the v3->v2 bridge this one DOES degrade grok: the frozen v1.0
      // union predates the grok available arm, so a grok-available snapshot
      // becomes the `unsupported_provider` row a v1.0 host returns for grok
      // today (shared map) rather than being dropped. Post-v4.0 providers
      // (Hermes, omp) stay unrepresentable and still fail closed.
      const rateLimits = mapGrokAvailableToUnavailable(response.rateLimits);
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

export const agentGetProviderProfileRateLimitsUpgradeV30ToV40 =
  defineUpgradePath<
    typeof agentGetProviderProfileRateLimitsV30,
    typeof agentGetProviderProfileRateLimitsV40
  >({
    from: { major: 3, minor: 0 },
    to: { major: 4, minor: 0 },
    // Request shape is identical across both majors - only the response's
    // `rateLimits.provider` enum grows (huggingface).
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });

export const agentGetProviderProfileRateLimitsDowngradeV40ToV30 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV40,
    typeof agentGetProviderProfileRateLimitsV30
  >({
    from: { major: 4, minor: 0 },
    to: { major: 3, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // No grok degrade here: the frozen v3.0 union keeps the grok available
      // arm, so a grok snapshot reparses as-is. Only a post-v6.0 provider is
      // unrepresentable, and this response carries exactly one provider - so
      // fail closed rather than mis-decode. The message names no provider so
      // it stays honest as the enum grows.
      //
      // Cursor DOES degrade rather than fail closed: `"cursor"` is in the
      // frozen v6.0 provider enum, so the unavailable row is representable
      // here, and an older client is better served by an honest "usage isn't
      // available" than by an error it cannot act on.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV3.safeParse({
          ...response,
          rateLimits: mapCursorAvailableToUnavailable(
            mapOpenCodeAvailableToUnavailable(response.rateLimits),
          ),
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

export const agentGetProviderProfileRateLimitsDowngradeV40ToV20 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV40,
    typeof agentGetProviderProfileRateLimitsV20
  >({
    from: { major: 4, minor: 0 },
    to: { major: 2, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Same rule as the v4->v3 bridge against the narrower v2.0 enum: the
      // frozen v2.0 union keeps grok, so only post-v5.0 providers (omp,
      // huggingface) fail closed here. Cursor degrades for the same reason it
      // does there - `"cursor"` is in the frozen v5.0 provider enum too.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV2.safeParse({
          ...response,
          rateLimits: mapCursorAvailableToUnavailable(
            mapOpenCodeAvailableToUnavailable(response.rateLimits),
          ),
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

export const agentGetProviderProfileRateLimitsDowngradeV40ToV10 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV40,
    typeof agentGetProviderProfileRateLimitsV10
  >({
    from: { major: 4, minor: 0 },
    to: { major: 1, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Unlike the v4->v3 / v4->v2 bridges this one DOES degrade grok: the
      // frozen v1.0 union predates the grok available arm, so a grok-available
      // snapshot becomes the `unsupported_provider` row a v1.0 host returns for
      // grok today (shared map). Post-v4.0 providers (Hermes, omp, huggingface)
      // stay unrepresentable and still fail closed. Cursor degrades here too:
      // `"cursor"` is in the frozen v4.0 provider enum.
      const rateLimits = mapGrokAvailableToUnavailable(
        mapCursorAvailableToUnavailable(
          mapOpenCodeAvailableToUnavailable(response.rateLimits),
        ),
      );
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


export const agentGetProviderProfileRateLimitsUpgradeV40ToV50 =
  defineUpgradePath<
    typeof agentGetProviderProfileRateLimitsV40,
    typeof agentGetProviderProfileRateLimitsV50
  >({
    from: { major: 4, minor: 0 },
    to: { major: 5, minor: 0 },
    // Request shape is identical across both majors - only the response's
    // `rateLimits.provider` enum grows (reasonix).
    upgradeRequest: (request) => request,
    upgradeResponse: (response) => response,
  });

export const agentGetProviderProfileRateLimitsDowngradeV50ToV40 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV50,
    typeof agentGetProviderProfileRateLimitsV40
  >({
    from: { major: 5, minor: 0 },
    to: { major: 4, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // NO degrade maps here, unlike every bridge below: the frozen v4.0 union
      // keeps every available arm the live union carries at this cut (grok,
      // huggingface, opencode and cursor all shipped on 4.0), so an available
      // snapshot reparses as-is. Only a post-v7.0 provider is unrepresentable,
      // and it can only ever arrive on the `available: false` arm - Reasonix
      // exposes no queryable quota API and is outside
      // `rateLimitCapableProviderIdSchema`. This response carries exactly one
      // provider, so fail closed rather than mis-decode. The message names no
      // provider so it stays honest as the enum grows.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV4.safeParse(response);
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

export const agentGetProviderProfileRateLimitsDowngradeV50ToV30 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV50,
    typeof agentGetProviderProfileRateLimitsV30
  >({
    from: { major: 5, minor: 0 },
    to: { major: 3, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Same shape as the v4->v3 bridge: the frozen v3.0 union keeps grok, so
      // only OpenCode/cursor degrade, and anything post-v6.0 (huggingface,
      // reasonix) fails closed.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV3.safeParse({
          ...response,
          rateLimits: mapCursorAvailableToUnavailable(
            mapOpenCodeAvailableToUnavailable(response.rateLimits),
          ),
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

export const agentGetProviderProfileRateLimitsDowngradeV50ToV20 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV50,
    typeof agentGetProviderProfileRateLimitsV20
  >({
    from: { major: 5, minor: 0 },
    to: { major: 2, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Same rule against the narrower v2.0 enum: the frozen v2.0 union keeps
      // grok, so only post-v5.0 providers (omp, huggingface, reasonix) fail
      // closed. Cursor and OpenCode degrade as they do above.
      const parsed =
        agentGetProviderProfileRateLimitsResponseSchemaV2.safeParse({
          ...response,
          rateLimits: mapCursorAvailableToUnavailable(
            mapOpenCodeAvailableToUnavailable(response.rateLimits),
          ),
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

export const agentGetProviderProfileRateLimitsDowngradeV50ToV10 =
  defineDowngradePath<
    typeof agentGetProviderProfileRateLimitsV50,
    typeof agentGetProviderProfileRateLimitsV10
  >({
    from: { major: 5, minor: 0 },
    to: { major: 1, minor: 0 },
    downgradeRequest: (request) => ({ ok: true, value: request }),
    downgradeResponse: (response) => {
      // Like the v4->v1 bridge this one also degrades grok: the frozen v1.0
      // union predates the grok available arm. Post-v4.0 providers (Hermes,
      // omp, huggingface, reasonix) stay unrepresentable and fail closed.
      const rateLimits = mapGrokAvailableToUnavailable(
        mapCursorAvailableToUnavailable(
          mapOpenCodeAvailableToUnavailable(response.rateLimits),
        ),
      );
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
  /**
   * RETAINED even though Epic Mode was removed from the product. `agent.configure`
   * v3.0 is itself RELEASED, and its baseline requires this key on the response -
   * a released peer parsing a payload built from this tree would fail outright if
   * it were dropped. The host states the one remaining mode. It goes when the
   * released floor passes this version, together with the equally-blocked
   * `chatActiveTurn.agentMode` and `createAgentRequestSchemaV30.agentMode`.
   */
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
 * caller's strict decode never sees a post-v4.0 `harnessId` (`hermes`,
 * `omp`). The v2.0 line (below) carries them via the live, still-growing
 * `agentConfigureSettingsSchema` / `agentConfigureResponseSchema` above;
 * `agentConfigureDowngradeV20ToV10`'s response bridge fails closed
 * (`DOWNGRADE_UNSUPPORTED`) instead of silently mis-decoding such an agent for
 * a v1.0 caller. Do NOT widen this schema - extend the latest schema and use
 * the existing v2 bridge instead.
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

/**
 * Frozen `agent.configure@2.0` settings/response, pinned to the pre-omp
 * harness id set (`guiHarnessIdSchemaV50`) so an already-shipped v2.0 caller's
 * strict decode never sees `harnessId: "omp"`.
 *
 * This line IS released - the v1.1.8 tags (2026-07-25) shipped it. The v3.0
 * line (below) carries the live `agentConfigureSettingsSchema` /
 * `agentConfigureResponseSchema`; `agentConfigureDowngradeV30ToV20`'s response
 * bridge fails closed (`DOWNGRADE_UNSUPPORTED`) instead of silently
 * mis-decoding an omp-configured agent for a v2.0 caller. Do NOT widen this
 * schema - extend the latest schema and use the v3 bridge instead.
 *
 * Only the RESPONSE is frozen. `agentConfigureRequestSchemaV20` keeps the live
 * harness enum because the request is a client→host slot: a released client
 * simply never sends `omp`, and widening what the host accepts breaks nobody.
 */
export const agentConfigureSettingsSchemaV2 = z.object({
  harnessId: guiHarnessIdSchemaV50,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
  permissionMode: permissionModeSchema,
  agentMode: agentModeSchema,
});
export type AgentConfigureSettingsV2 = z.infer<
  typeof agentConfigureSettingsSchemaV2
>;

export const agentConfigureResponseSchemaV2 = z.object({
  settings: agentConfigureSettingsSchemaV2,
  warnings: z.array(z.string()),
});
export type AgentConfigureResponseV2 = z.infer<
  typeof agentConfigureResponseSchemaV2
>;

export const agentConfigureV20 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchemaV20,
  responseSchema: agentConfigureResponseSchemaV2,
});

/**
 * Frozen `agent.configure@3.0` settings/response, pinned to the
 * pre-Hugging-Face harness id set (`guiHarnessIdSchemaV60`) so an
 * already-shipped v3.0 caller's strict decode never sees
 * `harnessId: "huggingface"`.
 *
 * This line IS released - the v1.1.9 tags (2026-07-29) shipped it. The v4.0
 * line (below) carries the live `agentConfigureSettingsSchema` /
 * `agentConfigureResponseSchema`; `agentConfigureDowngradeV40ToV30`'s response
 * bridge fails closed (`DOWNGRADE_UNSUPPORTED`) instead of silently
 * mis-decoding a Hugging-Face-configured agent for a v3.0 caller. Do NOT widen
 * this schema - extend the latest schema and use the v4 bridge instead.
 *
 * Only the RESPONSE is frozen. `agentConfigureRequestSchemaV20` keeps the live
 * harness enum because the request is a client→host slot: a released client
 * simply never sends `huggingface`, and widening what the host accepts breaks
 * nobody.
 */
export const agentConfigureSettingsSchemaV3 = z.object({
  harnessId: guiHarnessIdSchemaV60,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
  permissionMode: permissionModeSchema,
  agentMode: agentModeSchema,
});
export type AgentConfigureSettingsV3 = z.infer<
  typeof agentConfigureSettingsSchemaV3
>;

export const agentConfigureResponseSchemaV3 = z.object({
  settings: agentConfigureSettingsSchemaV3,
  warnings: z.array(z.string()),
});
export type AgentConfigureResponseV3 = z.infer<
  typeof agentConfigureResponseSchemaV3
>;

export const agentConfigureV30 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 3, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchemaV20,
  responseSchema: agentConfigureResponseSchemaV3,
});

/**
 * Frozen `agent.configure@4.0` settings/response, pinned to the pre-Reasonix
 * harness id set (`guiHarnessIdSchemaV70`) so an already-shipped v4.0 caller's
 * strict decode never sees `harnessId: "reasonix"`.
 *
 * This line IS released - the v1.2.0 tags (2026-08-24) shipped it. Until then
 * it pointed at the live `agentConfigureSettingsSchema` /
 * `agentConfigureResponseSchema`. The v5.0 line (below) carries the live
 * schemas; `agentConfigureDowngradeV50ToV40`'s response bridge fails closed
 * (`DOWNGRADE_UNSUPPORTED`) instead of silently mis-decoding a
 * Reasonix-configured agent for a v4.0 caller. Do NOT widen this schema -
 * extend the latest schema and use the v5 bridge instead.
 *
 * Only the RESPONSE is frozen. `agentConfigureRequestSchemaV20` keeps the live
 * harness enum because the request is a client→host slot: a released client
 * simply never sends `reasonix`, and widening what the host accepts breaks
 * nobody.
 */
export const agentConfigureSettingsSchemaV4 = z.object({
  harnessId: guiHarnessIdSchemaV70,
  model: z.string().min(1),
  profileSelection: concreteProfileSelectionSchema,
  reasoningEffort: z.string().nullable(),
  fastMode: z.boolean(),
  permissionMode: permissionModeSchema,
  agentMode: agentModeSchema,
});
export type AgentConfigureSettingsV4 = z.infer<
  typeof agentConfigureSettingsSchemaV4
>;

export const agentConfigureResponseSchemaV4 = z.object({
  settings: agentConfigureSettingsSchemaV4,
  warnings: z.array(z.string()),
});
export type AgentConfigureResponseV4 = z.infer<
  typeof agentConfigureResponseSchemaV4
>;

export const agentConfigureV40 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 4, minor: 0 } as const,
  requestSchema: agentConfigureRequestSchemaV20,
  responseSchema: agentConfigureResponseSchemaV4,
});

export const agentConfigureV50 = defineRpcContract({
  method: "agent.configure",
  schemaVersion: { major: 5, minor: 0 } as const,
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
    // reparses cleanly through the frozen schema. A post-v4.0-harness
    // response (Hermes or omp - unreachable from a v1.0 REQUEST today, but
    // this bridge must still hold if that ever changes) cannot be represented
    // on the frozen v1.0 wire, so this fails closed instead of silently
    // mis-decoding it. The message names no single harness so it stays honest
    // as the enum grows.
    const parsed = agentConfigureResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureUpgradeV20ToV30 = defineUpgradePath<
  typeof agentConfigureV20,
  typeof agentConfigureV30
>({
  from: { major: 2, minor: 0 },
  to: { major: 3, minor: 0 },
  // Request shape is identical across both majors (v3.0 reuses
  // `agentConfigureRequestSchemaV20`) - only the response's `harnessId` enum
  // grows (omp). Both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentConfigureDowngradeV30ToV20 = defineDowngradePath<
  typeof agentConfigureV30,
  typeof agentConfigureV20
>({
  from: { major: 3, minor: 0 },
  to: { major: 2, minor: 0 },
  // Unlike the v2->v1 bridge this request downgrade succeeds: v3.0 added no
  // request field, so a v3.0 request is already a valid v2.0 one.
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // `settings.harnessId` echoes the configured agent's harness; a v2.0
    // caller only ever configures a pre-omp harness, so the common case
    // reparses cleanly through the frozen schema. An omp-configured response
    // (unreachable from a v2.0 REQUEST today, but this bridge must still hold
    // if that ever changes) cannot be represented on the frozen v2.0 wire, so
    // this fails closed instead of silently mis-decoding it.
    const parsed = agentConfigureResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureUpgradeV30ToV40 = defineUpgradePath<
  typeof agentConfigureV30,
  typeof agentConfigureV40
>({
  from: { major: 3, minor: 0 },
  to: { major: 4, minor: 0 },
  // Request shape is identical across both majors (both reuse
  // `agentConfigureRequestSchemaV20`) - only the response's `harnessId` enum
  // grows (huggingface). Both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentConfigureDowngradeV40ToV30 = defineDowngradePath<
  typeof agentConfigureV40,
  typeof agentConfigureV30
>({
  from: { major: 4, minor: 0 },
  to: { major: 3, minor: 0 },
  // Like the v3->v2 bridge this request downgrade succeeds: v4.0 added no
  // request field, so a v4.0 request is already a valid v3.0 one.
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // `settings.harnessId` echoes the configured agent's harness; a v3.0
    // caller only ever configures a pre-Hugging-Face harness, so the common
    // case reparses cleanly through the frozen schema. A response on a
    // post-v6.0 harness (unreachable from a v3.0 REQUEST today, but this
    // bridge must still hold if that ever changes) cannot be represented on
    // the frozen v3.0 wire, so this fails closed instead of silently
    // mis-decoding it. The message names no harness so it stays honest as the
    // enum grows.
    const parsed = agentConfigureResponseSchemaV3.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV40ToV20 = defineDowngradePath<
  typeof agentConfigureV40,
  typeof agentConfigureV20
>({
  from: { major: 4, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v5.0 harness (omp, huggingface) - see the
    // v4->v3 bridge above for the full reasoning.
    const parsed = agentConfigureResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV40ToV10 = defineDowngradePath<
  typeof agentConfigureV40,
  typeof agentConfigureV10
>({
  from: { major: 4, minor: 0 },
  to: { major: 1, minor: 0 },
  // Same refusal as the v3->v1 bridge: v1.0 has no `permissionMode` field, so
  // the explicit choice a v2.0+ caller makes cannot be carried to a v1.0 host.
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before configuring this agent.",
    },
  }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v4.0 harness (Hermes, omp, huggingface).
    const parsed = agentConfigureResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureUpgradeV40ToV50 = defineUpgradePath<
  typeof agentConfigureV40,
  typeof agentConfigureV50
>({
  from: { major: 4, minor: 0 },
  to: { major: 5, minor: 0 },
  // Request shape is identical across both majors (both reuse
  // `agentConfigureRequestSchemaV20`) - only the response's `harnessId` enum
  // grows (reasonix). Both upgrades are identity.
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const agentConfigureDowngradeV50ToV40 = defineDowngradePath<
  typeof agentConfigureV50,
  typeof agentConfigureV40
>({
  from: { major: 5, minor: 0 },
  to: { major: 4, minor: 0 },
  // Like the v4->v3 bridge this request downgrade succeeds: v5.0 added no
  // request field, so a v5.0 request is already a valid v4.0 one.
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // `settings.harnessId` echoes the configured agent's harness; a v4.0
    // caller only ever configures a pre-Reasonix harness, so the common case
    // reparses cleanly through the frozen schema. A response on a post-v7.0
    // harness (unreachable from a v4.0 REQUEST today, but this bridge must
    // still hold if that ever changes) cannot be represented on the frozen
    // v4.0 wire, so this fails closed instead of silently mis-decoding it. The
    // message names no harness so it stays honest as the enum grows.
    const parsed = agentConfigureResponseSchemaV4.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV50ToV30 = defineDowngradePath<
  typeof agentConfigureV50,
  typeof agentConfigureV30
>({
  from: { major: 5, minor: 0 },
  to: { major: 3, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v6.0 harness (huggingface, reasonix) - see the
    // v5->v4 bridge above for the full reasoning.
    const parsed = agentConfigureResponseSchemaV3.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV50ToV20 = defineDowngradePath<
  typeof agentConfigureV50,
  typeof agentConfigureV20
>({
  from: { major: 5, minor: 0 },
  to: { major: 2, minor: 0 },
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v5.0 harness (omp, huggingface, reasonix).
    const parsed = agentConfigureResponseSchemaV2.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV50ToV10 = defineDowngradePath<
  typeof agentConfigureV50,
  typeof agentConfigureV10
>({
  from: { major: 5, minor: 0 },
  to: { major: 1, minor: 0 },
  // Same refusal as every other bridge onto v1.0: v1.0 has no
  // `permissionMode` field, so the explicit choice a v2.0+ caller makes cannot
  // be carried to a v1.0 host.
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before configuring this agent.",
    },
  }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v4.0 harness (Hermes, omp, huggingface,
    // reasonix).
    const parsed = agentConfigureResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});

export const agentConfigureDowngradeV30ToV10 = defineDowngradePath<
  typeof agentConfigureV30,
  typeof agentConfigureV10
>({
  from: { major: 3, minor: 0 },
  to: { major: 1, minor: 0 },
  // Same refusal as the v2->v1 bridge: v1.0 has no `permissionMode` field, so
  // the explicit choice a v2.0+ caller makes cannot be carried to a v1.0 host.
  downgradeRequest: () => ({
    ok: false,
    error: {
      code: "DOWNGRADE_UNSUPPORTED",
      message:
        "Selecting an agent permission mode requires a newer Traycer host. Upgrade the host before configuring this agent.",
    },
  }),
  downgradeResponse: (response) => {
    // Fails closed for any post-v4.0 harness (Hermes, omp) - see the v2->v1
    // bridge above for the full reasoning.
    const parsed = agentConfigureResponseSchemaV1.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message:
            "Configuring an agent on this harness requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
});
