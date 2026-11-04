import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * `epic.hydrateChat`: bring an evicted chat's records back onto its host.
 *
 * A host may drop a published chat's local records once the cloud holds them
 * (`epic.listChatRecords@1.4`'s `evicted`); the server pool then serves the
 * transcript. A message to that chat needs the records back on the host first.
 * The client asks for that here, on the chat's own host, while its tile keeps
 * reading from the pool, and sends the message once the host holds the chat
 * again.
 *
 * - `hydrated` - the records are back; the host has cleared its eviction fact,
 *   so the serving witness turns `live` and the tile moves to the host.
 * - `not-evicted` - the host held the records already (never evicted, or a
 *   concurrent call brought them back first). The same next step.
 *
 * Refusals are typed errors, and the chat stays evicted:
 *
 * - `CHAT_EVICTED_UNREACHABLE` - the host could not reach the cloud copy.
 * - `CHAT_EVICTED_HEAD_MOVED` - the cloud copy is no longer the one the host
 *   dropped: the chat was continued on another host.
 *
 * Optional, off the released floor: a host that predates it answers
 * `E_HOST_UNSUPPORTED`, and evicts no chat either.
 */
export const hydrateChatRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
);
export type HydrateChatRequest = z.infer<typeof hydrateChatRequestSchema>;

export const hydrateChatResponseSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["hydrated", "not-evicted"]),
  }),
);
export type HydrateChatResponse = z.infer<typeof hydrateChatResponseSchema>;
