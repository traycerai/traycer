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
//
// An agent designates itself with a role over a Task-local scope, and peers
// read the registry to avoid duplicating responsibility. Distinct from
// `epic.batchUpdateRoles`, which is the collaborator ACL - these claims grant
// no permissions.
//
// Registered in `hostRpcRegistry` as of Sprint 02 - in the SAME change as the
// resolvers. Advertising a method whose resolver does not exist negotiates fine
// and then dies at dispatch with "Unknown method", which is exactly how
// `agent.tui.listHarnesses` shipped broken; the host's resolver-coverage
// tripwire now makes that unshippable.
//
// The request shapes carry no field naming an agent other than the caller -
// no target/owner/assignee. `claimantAgentId` is an ATTRIBUTION, not a proof:
// the host must verify the named agent belongs to the authenticated user and
// this epic before honoring it. The authenticated account is the authorization
// boundary.

/** What a claim looks like on the wire: the stored record minus `userId`,
 * which never needs to cross the boundary because every read is already
 * filtered to the authenticated account. */
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

/**
 * The sender identity every role-awareness injection is attributed to.
 *
 * This is a RESERVED id, and the reservation is enforced by the host: the
 * agent-creation paths that accept a caller-supplied id reject it before
 * persistence. That enforcement is load-bearing rather than cosmetic - the
 * persisted sender envelope is agent-shaped (there is no `system` variant in
 * `userMessageSenderSchema`), so this id IS the system provenance. If a real
 * agent could be named this, every system notice the platform sends would be
 * forgeable.
 */
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
 *
 * The words are deliberately narrow, because the transports cannot support
 * anything wider:
 *
 * - `deliveredTo` - TUI: the frame was handed to an OPEN socket. GUI: the
 *   durable commit point was reached. It does NOT mean the peer received,
 *   parsed, or read it - no transport here offers an acknowledgment.
 * - `unreachable` - classified out at snapshot; nothing was attempted. An idle
 *   GUI agent (waking it would be worse than letting it read roles from its
 *   next prompt), a TUI agent with no connected monitor, or a monitor that
 *   negotiated `@1.0` and so never agreed to receive this frame.
 *
 *   NOT in this list: a GUI harness that cannot take a mid-turn injection. It
 *   still receives the event on its queue and sees it when its current turn
 *   ends - a turn late, but delivered.
 * - `failed` - attempted, and did not land.
 *
 * Awareness failure NEVER rolls back the registry: a claim is durable
 * responsibility; a broadcast is a courtesy to whoever happened to be
 * listening.
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
  // False when this agent already held an identical claim: the existing claim
  // comes back untouched rather than a duplicate being minted, so retries are
  // safe.
  created: z.boolean(),
  // Other agents already holding this role/scope. Overlap is allowed - v1 has
  // no uniqueness lock - so the claimant is TOLD about duplication instead of
  // being blocked by it. Account- and liveness-filtered like every other read.
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
  // False is a no-op, not an error: the claim was already gone (double
  // relinquish is safe), or it belongs to another account - which is reported
  // as not-found rather than as an authorization error, so a caller cannot
  // probe for the existence of another account's claims.
  released: z.boolean(),
});
export type RelinquishAgentRoleResponse = z.infer<
  typeof relinquishAgentRoleResponseSchema
>;

// ─── Awareness v1.1 (additive) ───────────────────────────────────────────
//
// Everything above this line is the released v1.0 wire surface and is
// FROZEN - no new field, no relaxed validation. `agent.roles.list` has no
// v1.1: listing reads the durable registry directly and is unaffected by
// prompt-cutover awareness, so it never earns a minor bump here.
//
// `deferredToPrompt` names agents whose fresh-query prompt cutover was still
// open when this mutation routed: the in-flight attempt reads the
// authoritative registry if it reaches cutover; otherwise the next fresh
// query does. It is deliberately NOT folded into `deliveredTo` - no event was
// queued and no model read anything, so claiming delivery would be false.
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
 * v1.0 has no concept of prompt deferral. A v1.0-negotiated caller still gets
 * a truthful answer by folding `deferredToPrompt` into `unreachable`: both
 * already mean "nothing was delivered; the registry heals on a later fresh
 * prompt" on that surface, so the fold loses no promise the v1.0 contract
 * ever made. This only ever moves ids between the two array fields both
 * versions already have - it invents no `failed` reason.
 *
 * The generic RPC dispatcher only Zod-strips newer-minor fields for
 * within-major callers, which would *drop* deferred ids. Host dispatch must
 * call these helpers after canonical v1.1 validation and before the caller's
 * v1.0 response schema parse - never via a preprocess wrapper on the released
 * v1.0 contracts.
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

// Same requests and same major version as v1.0 - v1.1 only changes what the
// awareness report can say, never what a caller sends. Installed into the
// registry with latestMinor 1; host dispatch folds deferred→unreachable for
// negotiated v1.0 after canonical v1.1 validation.
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

// Request is identical across minors. Response upgrade synthesizes an empty
// deferred bucket so an older stored/v1.0-shaped body can be read as v1.1;
// live hosts return canonical v1.1 and down-project for older callers instead.
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
