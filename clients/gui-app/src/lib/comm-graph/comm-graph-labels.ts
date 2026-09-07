/** Display labels for the open-string and closed-enum fields on an event row. */

const NOTICE_REASON_LABELS: Readonly<Record<string, string>> = {
  "turn-ended": "Turn ended",
  errored: "Agent errored",
  "awaiting-input": "Awaiting input",
};

export function commGraphNoticeReasonLabel(reason: string | null): string {
  if (reason === null) return "Notice";
  return NOTICE_REASON_LABELS[reason] ?? reason;
}

/** An agent's display name, falling back to its raw id. */
export function commGraphAgentLabel(
  agentId: string | null,
  agentNames: ReadonlyMap<string, string>,
): string {
  if (agentId === null) return "Unknown agent";
  return agentNames.get(agentId) ?? agentId;
}
