import { hostQueryKeys } from "./host-query-keys";

/**
 * Query keys for the bot streams' cache slots (Tracy Bots).
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
  /**
   * The `bot.memory.subscribe` stream's slot (T87): the bot's memory as one
   * host reads it from one environment's room.
   */
  memory: (args: {
    readonly hostId: string;
    readonly botId: string;
    readonly environmentId: string;
  }) =>
    [
      ...hostQueryKeys.scope(args.hostId),
      "bot",
      "memory",
      args.botId,
      args.environmentId,
    ] as const,
};
