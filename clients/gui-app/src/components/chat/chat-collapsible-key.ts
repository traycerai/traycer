export type ChatCollapsibleKind =
  "subagent" | "activity-group" | "a2a-send" | "a2a-received";

export interface ChatCollapsibleKey {
  readonly tileInstanceId: string;
  readonly kind: ChatCollapsibleKind;
  readonly id: string;
}

export function createChatCollapsibleKey(
  tileInstanceId: string,
  kind: ChatCollapsibleKind,
  id: string,
): ChatCollapsibleKey {
  return { tileInstanceId, kind, id };
}

export function serializeChatCollapsibleKey(key: ChatCollapsibleKey): string {
  return JSON.stringify([key.tileInstanceId, key.kind, key.id]);
}

export function derivePromotedSubagentRenderId(segmentId: string): string {
  return `promoted:${segmentId}`;
}

export function deriveActivityGroupRenderId(
  firstChildSegmentId: string,
): string {
  return `activity:${firstChildSegmentId}`;
}

export function deriveSubagentCollapsibleKey(
  tileInstanceId: string,
  renderId: string,
): ChatCollapsibleKey {
  return createChatCollapsibleKey(tileInstanceId, "subagent", renderId);
}

export function deriveActivityGroupCollapsibleKey(
  tileInstanceId: string,
  groupId: string,
): ChatCollapsibleKey {
  return createChatCollapsibleKey(tileInstanceId, "activity-group", groupId);
}

export function deriveA2ASendCollapsibleKey(
  tileInstanceId: string,
  segmentId: string,
): ChatCollapsibleKey {
  return createChatCollapsibleKey(tileInstanceId, "a2a-send", segmentId);
}

export function deriveA2AReceivedCollapsibleKey(
  tileInstanceId: string,
  messageId: string,
): ChatCollapsibleKey {
  return createChatCollapsibleKey(tileInstanceId, "a2a-received", messageId);
}
