/** The client's one reading of `epic.chatPublicationState`'s `definitive` field. */

/** A reason the source chat's publication answer is frozen. */
export type ChatPublicationDefinitiveReason =
  | "chat-deleted"
  | "lineage-superseded"
  | "backup-halted"
  | "unexplained";

/**
 * `null` when the ordinary reading applies and the state may still move on its own; otherwise the reason, terminal by definition.
 */
export function chatPublicationDefinitiveReason(
  definitive: string | null | undefined,
): ChatPublicationDefinitiveReason | null {
  if (definitive === null || definitive === undefined) return null;
  if (definitive === "chat-deleted") return "chat-deleted";
  if (definitive === "lineage-superseded") return "lineage-superseded";
  if (definitive === "backup-halted") return "backup-halted";
  return "unexplained";
}

/**
 * Whether the reason invalidates the published head ITSELF, rather than merely freezing how far that head reaches.
 */
export function definitiveInvalidatesPublishedHead(
  reason: ChatPublicationDefinitiveReason,
): boolean {
  return reason === "chat-deleted" || reason === "lineage-superseded";
}
