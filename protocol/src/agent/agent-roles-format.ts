import type {
  ClaimAgentRoleResponse,
  ClaimAgentRoleResponseV11,
  ListAgentRolesResponse,
  RelinquishAgentRoleResponse,
  RelinquishAgentRoleResponseV11,
  RoleAwarenessDelivery,
  RoleAwarenessDeliveryV11,
  RoleClaimWire,
} from "@traycer/protocol/host/agent/roles";

export function formatClaimRoleResponse(
  response: ClaimAgentRoleResponse,
): string {
  const lines = formatClaimLines(response);
  lines.push(formatAwarenessSummary(response.awareness));
  return lines.join("\n");
}

export function formatListRolesResponse(
  response: ListAgentRolesResponse,
): string {
  if (response.claims.length === 0) {
    return "No roles are claimed in this Task yet.";
  }
  // The response array order IS the projection's deterministic order; the
  // formatter adds no re-sort so every surface renders the same sequence.
  const rows = response.claims.map(
    (claim) =>
      `- ${claimLabel(claim)} - held by agent ${claim.agentId} (claimId: ${claim.claimId})`,
  );
  return ["Roles currently claimed in this Task:", ...rows].join("\n");
}

export function formatRelinquishRoleResponse(
  response: RelinquishAgentRoleResponse,
): string {
  if (!response.released) {
    // Foreign-account and absent/already-released claim ids deliberately share
    // this one rendering - no existence oracle.
    return "No matching claim to relinquish - it may already be released.";
  }
  return [
    "Role relinquished.",
    formatAwarenessSummary(response.awareness),
  ].join("\n");
}

function claimLabel(claim: RoleClaimWire): string {
  return `\`${claim.role}\` over \`${claim.scope}\``;
}

function formatClaimLines(response: {
  readonly created: boolean;
  readonly claim: RoleClaimWire;
  readonly overlapping: RoleClaimWire[];
}): string[] {
  const lines = [
    response.created
      ? `Claimed role ${claimLabel(response.claim)}.`
      : `You already hold this role - existing claim returned unchanged (safe retry).`,
    `claimId: ${response.claim.claimId}`,
  ];
  if (response.overlapping.length > 0) {
    lines.push(
      `Overlap: ${response.overlapping
        .map((claim) => `${claimLabel(claim)} held by agent ${claim.agentId}`)
        .join(
          "; ",
        )}. Overlaps are allowed, but check whether this duplication is intentional.`,
    );
  }
  return lines;
}

function appendFailureSummary(
  parts: string[],
  failed: RoleAwarenessDelivery["failed"],
): void {
  if (failed.length === 0) {
    parts.push("failed 0");
    return;
  }
  const reasons = failed
    .map((entry) => `${entry.agentId}: ${entry.reason}`)
    .join(", ");
  parts.push(`failed ${failed.length} (${reasons})`);
}

function formatAwarenessSummary(delivery: RoleAwarenessDelivery): string {
  const parts = [
    `delivered ${delivery.deliveredTo.length}`,
    `unreachable ${delivery.unreachable.length}`,
  ];
  appendFailureSummary(parts, delivery.failed);
  return `Awareness: ${parts.join(" · ")}. The registry update is durable regardless.`;
}

// ─── v1.1 vocabulary (GUI tools + CLI share these formatters verbatim) ───
// Any surface rendering a v1.1 awareness report must use this word for the category, never "delivered".
const PROMPT_PENDING_LABEL = "prompt-pending";

/** Same shape as {@link formatAwarenessSummary}, extended with the prompt-pending bucket. */
function formatAwarenessSummaryV11(delivery: RoleAwarenessDeliveryV11): string {
  const parts = [
    `delivered ${delivery.deliveredTo.length}`,
    `${PROMPT_PENDING_LABEL} ${delivery.deferredToPrompt.length}`,
    `unreachable ${delivery.unreachable.length}`,
  ];
  appendFailureSummary(parts, delivery.failed);
  return `Awareness: ${parts.join(" · ")}. The registry update is durable regardless.`;
}

export function formatClaimRoleResponseV11(
  response: ClaimAgentRoleResponseV11,
): string {
  const lines = formatClaimLines(response);
  lines.push(formatAwarenessSummaryV11(response.awareness));
  return lines.join("\n");
}

export function formatRelinquishRoleResponseV11(
  response: RelinquishAgentRoleResponseV11,
): string {
  if (!response.released) {
    return "No matching claim to relinquish - it may already be released.";
  }
  return [
    "Role relinquished.",
    formatAwarenessSummaryV11(response.awareness),
  ].join("\n");
}
