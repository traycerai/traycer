/**
 * Why a chat's host could not bring back a chat it dropped the records of
 * (`epic.hydrateChat`'s typed refusals, which a rejected message's ack may
 * also carry):
 *
 * - `unreachable` - the host could not reach the cloud copy.
 * - `head-moved` - the cloud copy is no longer the one the host dropped: the
 *   chat was continued elsewhere.
 *
 * The composer says either inline, so neither raises a toast.
 */
export type EvictedChatRefusal = "unreachable" | "head-moved";

export function evictedChatRefusalOfCode(
  code: string | null,
): EvictedChatRefusal | null {
  if (code === "CHAT_EVICTED_UNREACHABLE") return "unreachable";
  if (code === "CHAT_EVICTED_HEAD_MOVED") return "head-moved";
  return null;
}
