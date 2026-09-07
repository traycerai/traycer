import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  roleNameSchema,
  roleScopeSchema,
} from "@traycer/protocol/persistence/epic/role-claims";

// ─── Agent role claims ────────────────────────────────────────────────────
// `claimantAgentId` is an ATTRIBUTION, not a proof: the host must verify the named agent belongs to the authenticated user and this epic before honoring it.

/**
 * What a claim looks like on the wire: the stored record minus `userId`, which never needs to cross the boundary because every read is already filtered to the authenticated account.
 */
export const roleClaimWireSchema = z.object({
  claimId: z.uuid(),
  agentId: z.string().min(1),
  role: roleNameSchema,
  scope: roleScopeSchema,
  claimedAt: z.number().int().nonnegative(),
});
export type RoleClaimWire = z.infer<typeof roleClaimWireSchema>;

export const claimAgentRoleRequestSchema = z.object({
  epicId: z.string().min(1),
  claimantAgentId: z.string().min(1),
  role: roleNameSchema,
  scope: roleScopeSchema,
});
export type ClaimAgentRoleRequest = z.infer<typeof claimAgentRoleRequestSchema>;

// ─── Awareness ────────────────────────────────────────────────────────────

/** The sender identity every role-awareness injection is attributed to. */
export const TRAYCER_SYSTEM_SENDER_AGENT_ID = "traycer:system";

export function isReservedAgentId(id: string): boolean {
  return id === TRAYCER_SYSTEM_SENDER_AGENT_ID;
}

export const roleAwarenessEventSchema = z.object({
  kind: z.enum(["role-claimed", "role-relinquished"]),
  epicId: z.string().min(1),
  claim: roleClaimWireSchema,
  at: z.number().int().nonnegative(),
});
export type RoleAwarenessEvent = z.infer<typeof roleAwarenessEventSchema>;

/**
 * What actually happened when we tried to tell peers.
 * NOT in this list: a GUI harness that cannot take a mid-turn injection.
 */
const roleAwarenessFailureReasonSchema = z.enum([
  "sink-closed",
  "timeout",
  "delivery-error",
  "reserved-id-collision",
  "no-active-turn",
]);

const roleAwarenessFailureSchema = z.object({
  agentId: z.string(),
  reason: roleAwarenessFailureReasonSchema,
});

export const roleAwarenessDeliverySchema = z.object({
  deliveredTo: z.array(z.string()),
  unreachable: z.array(z.string()),
  failed: z.array(roleAwarenessFailureSchema),
});
export type RoleAwarenessDelivery = z.infer<typeof roleAwarenessDeliverySchema>;

export const claimAgentRoleResponseSchema = z.object({
  claim: roleClaimWireSchema,
  // False when this agent already held an identical claim: the existing claim comes back untouched rather than a duplicate being minted, so retries are safe.
  created: z.boolean(),
  // Other agents already holding this role/scope.
  overlapping: z.array(roleClaimWireSchema),
  // Best-effort report about who we managed to tell. Commits to nothing about
  // the registry, which is already durable by the time this is computed.
  awareness: roleAwarenessDeliverySchema,
});
export type ClaimAgentRoleResponse = z.infer<
  typeof claimAgentRoleResponseSchema
>;

export const listAgentRolesRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListAgentRolesRequest = z.infer<typeof listAgentRolesRequestSchema>;

export const listAgentRolesResponseSchema = z.object({
  claims: z.array(roleClaimWireSchema),
});
export type ListAgentRolesResponse = z.infer<
  typeof listAgentRolesResponseSchema
>;

export const relinquishAgentRoleRequestSchema = z.object({
  epicId: z.string().min(1),
  claimantAgentId: z.string().min(1),
  // A claim, never a role string: an agent may hold several, so only the id is
  // unambiguous.
  claimId: z.uuid(),
});
export type RelinquishAgentRoleRequest = z.infer<
  typeof relinquishAgentRoleRequestSchema
>;

export const relinquishAgentRoleResponseSchema = z.object({
  // Same best-effort report as `claim`. Empty when nothing was released - there
  // is no event to announce.
  awareness: roleAwarenessDeliverySchema,
  // False is a no-op, not an error: the claim was already gone (double relinquish is safe), or it belongs to another account - which is reported as not-found rather than as an authorization error, so a caller cannot probe.
  released: z.boolean(),
});
export type RelinquishAgentRoleResponse = z.infer<
  typeof relinquishAgentRoleResponseSchema
>;

// ─── Awareness v1.1 (additive) ───────────────────────────────────────────
// Everything above this line is the released v1.0 wire surface and is FROZEN - no new field, no relaxed validation.
export const roleAwarenessDeliverySchemaV11 = z.object({
  deliveredTo: z.array(z.string()),
  deferredToPrompt: z.array(z.string()),
  unreachable: z.array(z.string()),
  failed: z.array(roleAwarenessFailureSchema),
});
export type RoleAwarenessDeliveryV11 = z.infer<
  typeof roleAwarenessDeliverySchemaV11
>;

/**
 * v1.0 has no concept of prompt deferral.
 * Host dispatch must call these helpers after canonical v1.1 validation and before the caller's v1.0 response schema parse - never via a preprocess wrapper on the released v1.0 contracts.
 */
export function downProjectRoleAwarenessDeliveryToV10(
  delivery: RoleAwarenessDeliveryV11,
): RoleAwarenessDelivery {
  return roleAwarenessDeliverySchema.parse({
    deliveredTo: delivery.deliveredTo,
    unreachable: [...delivery.unreachable, ...delivery.deferredToPrompt],
    failed: delivery.failed,
  });
}

export const claimAgentRoleResponseSchemaV11 = z.object({
  claim: roleClaimWireSchema,
  created: z.boolean(),
  overlapping: z.array(roleClaimWireSchema),
  awareness: roleAwarenessDeliverySchemaV11,
});
export type ClaimAgentRoleResponseV11 = z.infer<
  typeof claimAgentRoleResponseSchemaV11
>;

export function downProjectClaimResponseToV10(
  response: ClaimAgentRoleResponseV11,
): ClaimAgentRoleResponse {
  return claimAgentRoleResponseSchema.parse({
    claim: response.claim,
    created: response.created,
    overlapping: response.overlapping,
    awareness: downProjectRoleAwarenessDeliveryToV10(response.awareness),
  });
}

export const relinquishAgentRoleResponseSchemaV11 = z.object({
  awareness: roleAwarenessDeliverySchemaV11,
  released: z.boolean(),
});
export type RelinquishAgentRoleResponseV11 = z.infer<
  typeof relinquishAgentRoleResponseSchemaV11
>;

export function downProjectRelinquishResponseToV10(
  response: RelinquishAgentRoleResponseV11,
): RelinquishAgentRoleResponse {
  return relinquishAgentRoleResponseSchema.parse({
    awareness: downProjectRoleAwarenessDeliveryToV10(response.awareness),
    released: response.released,
  });
}

export const agentRolesClaimV10 = defineRpcContract({
  method: "agent.roles.claim",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: claimAgentRoleRequestSchema,
  // Released schema object identity is load-bearing for surface-compat and
  // freeze tests - do not wrap with preprocess.
  responseSchema: claimAgentRoleResponseSchema,
});

export const agentRolesListV10 = defineRpcContract({
  method: "agent.roles.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listAgentRolesRequestSchema,
  responseSchema: listAgentRolesResponseSchema,
});

export const agentRolesRelinquishV10 = defineRpcContract({
  method: "agent.roles.relinquish",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: relinquishAgentRoleRequestSchema,
  responseSchema: relinquishAgentRoleResponseSchema,
});

// Same requests and same major version as v1.0 - v1.1 only changes what the awareness report can say, never what a caller sends.
export const agentRolesClaimV11 = defineRpcContract({
  method: "agent.roles.claim",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: claimAgentRoleRequestSchema,
  responseSchema: claimAgentRoleResponseSchemaV11,
});

export const agentRolesRelinquishV11 = defineRpcContract({
  method: "agent.roles.relinquish",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: relinquishAgentRoleRequestSchema,
  responseSchema: relinquishAgentRoleResponseSchemaV11,
});

// Request is identical across minors.
export const agentRolesClaimUpgradeV10ToV11 = defineUpgradePath<
  typeof agentRolesClaimV10,
  typeof agentRolesClaimV11
>({
  from: agentRolesClaimV10.schemaVersion,
  to: agentRolesClaimV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    claim: response.claim,
    created: response.created,
    overlapping: response.overlapping,
    awareness: {
      deliveredTo: response.awareness.deliveredTo,
      deferredToPrompt: [],
      unreachable: response.awareness.unreachable,
      failed: response.awareness.failed,
    },
  }),
});

export const agentRolesRelinquishUpgradeV10ToV11 = defineUpgradePath<
  typeof agentRolesRelinquishV10,
  typeof agentRolesRelinquishV11
>({
  from: agentRolesRelinquishV10.schemaVersion,
  to: agentRolesRelinquishV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    released: response.released,
    awareness: {
      deliveredTo: response.awareness.deliveredTo,
      deferredToPrompt: [],
      unreachable: response.awareness.unreachable,
      failed: response.awareness.failed,
    },
  }),
});
