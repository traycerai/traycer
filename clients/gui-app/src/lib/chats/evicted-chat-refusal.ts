/** What a person reads when a message to an evicted chat could not go. */
export const EVICTED_SEND_FAILED_MESSAGE = "Couldn't send this message.";

/**
 * Whether a chat's host refused because it could not bring back a chat it
 * dropped the records of (`epic.hydrateChat`'s typed refusals, which a rejected
 * message's ack may also carry): it could not reach the cloud copy, or the
 * chat was continued elsewhere. The message fails like any failed send.
 */
export function isEvictedChatRefusal(code: string | null): boolean {
  return (
    code === "CHAT_EVICTED_UNREACHABLE" || code === "CHAT_EVICTED_HEAD_MOVED"
  );
}
