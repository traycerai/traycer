import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { harnessIdSchema } from "./agent/shared";
import { HOST_NOTIFICATION_STOPPED_REASONS } from "./notifications/payloads";

export const FALLBACK_RUNG_KINDS = [
  "profile",
  "tier",
  "wait",
  "notify",
] as const;
export const fallbackRungKindSchema = z.enum(FALLBACK_RUNG_KINDS);
export type FallbackRungKind = z.infer<typeof fallbackRungKindSchema>;

// A nonzero cancellation window is required even for headless chats. The wait
// cap defaults to a session-scale limit, with at most a week configurable.
export const FALLBACK_POLICY_LIMITS = {
  minGraceWindowSeconds: 5,
  maxGraceWindowSeconds: 300,
  minWaitMinutes: 1,
  maxWaitMinutes: 10_080,
} as const;

export const fallbackLadderSchema = z
  .array(fallbackRungKindSchema)
  .max(FALLBACK_RUNG_KINDS.length)
  .refine((rungs) => new Set(rungs).size === rungs.length, {
    message: "Fallback rungs must be unique",
  });

export const tierCandidateSchema = z.object({
  harnessId: harnessIdSchema,
  // Store family intent; resolution against the live catalog is host-owned.
  modelFamily: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).nullable(),
});
export type TierCandidate = z.infer<typeof tierCandidateSchema>;

export const tierGroupSchema = z.object({
  id: z.string().trim().min(1),
  candidates: z.array(tierCandidateSchema),
});
export type TierGroup = z.infer<typeof tierGroupSchema>;

export const fallbackPolicySchema = z.object({
  enabled: z.boolean(),
  // Empty is valid: exhaustion always notifies, even without an explicit rung.
  ladder: fallbackLadderSchema,
  reasonOverrides: z
    .partialRecord(
      z.enum(HOST_NOTIFICATION_STOPPED_REASONS),
      z.union([fallbackLadderSchema, z.literal("off")]),
    )
    .optional(),
  graceWindowSeconds: z
    .number()
    .int()
    .min(FALLBACK_POLICY_LIMITS.minGraceWindowSeconds)
    .max(FALLBACK_POLICY_LIMITS.maxGraceWindowSeconds),
  maxWaitMinutes: z
    .number()
    .int()
    .min(FALLBACK_POLICY_LIMITS.minWaitMinutes)
    .max(FALLBACK_POLICY_LIMITS.maxWaitMinutes),
  returnToPreferred: z.enum(["prompt", "auto", "stay"]),
  tierGroups: z
    .array(tierGroupSchema)
    .refine(
      (groups) =>
        new Set(groups.map((group) => group.id)).size === groups.length,
      { message: "Tier group IDs must be unique" },
    ),
});
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

/** Fresh data on every read; no caller can mutate another user's defaults. */
export function createDefaultFallbackPolicy(): FallbackPolicy {
  return {
    enabled: false,
    ladder: ["profile", "tier", "wait", "notify"],
    graceWindowSeconds: 15,
    maxWaitMinutes: 360,
    returnToPreferred: "prompt",
    // Tier seeding owns the distinction between never seeded and user emptied.
    tierGroups: [],
  };
}

export const providersFallbackPolicyGetRequestSchema = z.object({});
export type ProvidersFallbackPolicyGetRequest = z.infer<
  typeof providersFallbackPolicyGetRequestSchema
>;

export const providersFallbackPolicyGetResponseSchema = z.object({
  policy: fallbackPolicySchema,
  // Settings can render and offer an explicit repair when stored data is bad.
  storedPolicyUnreadable: z.boolean(),
  // Derived from active traversals, never part of the persisted policy.
  inFlightCount: z.number().int().nonnegative(),
});
export type ProvidersFallbackPolicyGetResponse = z.infer<
  typeof providersFallbackPolicyGetResponseSchema
>;

export const providersFallbackPolicySetRequestSchema = z.object({
  policy: fallbackPolicySchema,
});
export type ProvidersFallbackPolicySetRequest = z.infer<
  typeof providersFallbackPolicySetRequestSchema
>;

export const providersFallbackPolicySetResponseSchema = z.object({
  policy: fallbackPolicySchema,
});
export type ProvidersFallbackPolicySetResponse = z.infer<
  typeof providersFallbackPolicySetResponseSchema
>;

// These are new optional methods. Any later enum expansion must freeze this
// released line's vocabulary before adding the next method version.
export const providersFallbackPolicyGetV10 = defineRpcContract({
  method: "providers.fallbackPolicy.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicyGetRequestSchema,
  responseSchema: providersFallbackPolicyGetResponseSchema,
});

export const providersFallbackPolicySetV10 = defineRpcContract({
  method: "providers.fallbackPolicy.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicySetRequestSchema,
  responseSchema: providersFallbackPolicySetResponseSchema,
});
