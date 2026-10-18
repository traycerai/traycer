import { hostQueryKeys } from "./host-query-keys";

/**
 * Query keys for the `bot.subscribe` stream's cache slot (Tracy Bots).
 *
 * Scoped by the host the stream was opened against AND the bot: a bot's
 * snapshot differs per serving host (`boundHost.isThisHost`, and a host only
 * learns of cross-host changes on resubscribe), so two hosts' views of one
 * bot must not share a slot.
 */
export const botQueryKeys = {
  subscription: (args: { readonly hostId: string; readonly botId: string }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "bot",
      "subscription",
      args.botId,
    ] as const,
};
