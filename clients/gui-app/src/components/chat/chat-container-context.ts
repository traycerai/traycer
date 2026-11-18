import { createContext, use } from "react";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * The CONTAINER a transcript's chats belong to, for the segments that key a
 * read or a navigation by it: an Epic's id inside an Epic session, a bot's id
 * inside a bot tab (Tracy Bots), whose chats the host keys by the bot id.
 *
 * The Epic session provider is ONE source of the id, not the only one. A
 * transcript that is not inside an Epic session names its container here;
 * a segment reads {@link useChatContainerId} and gets the surface's answer,
 * never a throw. A segment that needs the EPIC (its artifact projection, its
 * canvas) still asks the session - `useMaybeOpenEpicHandle` /
 * `EpicSessionGate` - and renders its inert form when there is none.
 */
export const ChatContainerContext = createContext<string | null>(null);

/** The surface's container id, else the open Epic's, else `null`. */
export function useChatContainerId(): string | null {
  const surfaceContainerId = use(ChatContainerContext);
  const openEpic = useMaybeOpenEpicHandle();
  return surfaceContainerId ?? openEpic?.epicId ?? null;
}
