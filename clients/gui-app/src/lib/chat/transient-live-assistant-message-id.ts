const TRANSIENT_LIVE_ASSISTANT_MESSAGE_ID_PREFIX = "transient-live-assistant:";

export function transientLiveAssistantMessageId(turnId: string): string {
  return `${TRANSIENT_LIVE_ASSISTANT_MESSAGE_ID_PREFIX}${turnId}`;
}

export function isTransientLiveAssistantMessageId(messageId: string): boolean {
  return messageId.startsWith(TRANSIENT_LIVE_ASSISTANT_MESSAGE_ID_PREFIX);
}
