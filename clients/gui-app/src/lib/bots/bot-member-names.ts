import type { OpenUserMessageSender } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  resolveSenderLabel,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";

/**
 * A team bot's conversation carries messages from every member of the team,
 * and a bot chat has no epic collaborator list to name them from. This is
 * the seam a member directory plugs into: given a sender's user id it answers
 * that member's display name, or `null` when it does not know them.
 */
export type BotMemberNameResolver = (userId: string) => string | null;

/** No member directory is readable yet, so another member shows as their id. */
export const UNRESOLVED_BOT_MEMBER_NAMES: BotMemberNameResolver = () => null;

/**
 * A user row's sender label in a bot chat: "You" for the viewer, the
 * resolver's name for another member, and the raw user id when the resolver
 * does not know them. Agent senders label as in any other chat.
 */
export function botUserSenderLabel(
  sender: OpenUserMessageSender,
  context: SenderDisplayContext,
  resolveMemberName: BotMemberNameResolver,
): string {
  if (sender.type === "user" && context.profile?.userId !== sender.userId) {
    return resolveMemberName(sender.userId) ?? sender.userId;
  }
  return resolveSenderLabel(sender, context);
}
