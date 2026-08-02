/**
 * Display labels for the open-string and closed-enum fields on an event row.
 *
 * `noticeReason` is an OPEN STRING by contract: the set is host-owned and has
 * grown before, and this log is HISTORICAL - a row captured by a build newer
 * than this client must still render. So the lookup switches on the values it
 * knows and falls back to the RAW STRING; it may never become an exhaustive
 * match, and may never drop a row.
 */

const NOTICE_REASON_LABELS: Readonly<Record<string, string>> = {
  "turn-ended": "Turn ended",
  errored: "Agent errored",
  "awaiting-input": "Awaiting input",
};

export function commGraphNoticeReasonLabel(reason: string | null): string {
  if (reason === null) return "Notice";
  return NOTICE_REASON_LABELS[reason] ?? reason;
}

/**
 * An agent's display name, falling back to its raw id.
 *
 * A row can name an agent this epic no longer projects (a half-edge to an agent
 * outside it), and the id is still more use than "unknown" - it is what a log
 * search or a bug report will carry.
 */
export function commGraphAgentLabel(
  agentId: string | null,
  agentNames: ReadonlyMap<string, string>,
): string {
  if (agentId === null) return "Unknown agent";
  return agentNames.get(agentId) ?? agentId;
}
