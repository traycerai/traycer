import type { OpenUserMessageSender } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  resolveSenderLabel,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";

/**
 * A member of a bot's environment as the member directory knows them: their
 * name, null when they have set none, and their picture, null when they have
 * none.
 */
export interface BotMember {
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

/**
 * A team bot's conversation carries messages from every member of the team,
 * and a bot chat has no epic collaborator list to name them from. This is
 * the seam the environment's member directory plugs into: given a sender's
 * user id it answers that member, or `null` when it does not know them.
 */
export type BotMemberResolver = (userId: string) => BotMember | null;

/** No member directory is readable, so another member shows as their id. */
export const UNRESOLVED_BOT_MEMBERS: BotMemberResolver = () => null;

/**
 * A user row's sender label in a bot channel, as Slack names every message's
 * sender: the viewer by their own account name ("You" when it has none),
 * another member by the name the directory gives, and the raw user id when
 * the directory does not know them or they have no name. Agent senders label
 * as in any other chat.
 */
export function botUserSenderLabel(
  sender: OpenUserMessageSender,
  context: SenderDisplayContext,
  resolveMember: BotMemberResolver,
): string {
  if (sender.type !== "user") return resolveSenderLabel(sender, context);
  return botMemberName(sender.userId, context.profile, resolveMember);
}

/** A member's name on a bot channel's row; see {@link botUserSenderLabel}. */
export function botMemberName(
  userId: string,
  viewer: SenderDisplayContext["profile"],
  resolveMember: BotMemberResolver,
): string {
  if (viewer?.userId === userId) {
    const own = viewer.userName.trim();
    return own.length > 0 ? own : "You";
  }
  return resolveMember(userId)?.displayName ?? userId;
}

/**
 * A user row's sender picture in a bot chat, the viewer's included; null
 * for an agent sender and for a member the directory has no picture of.
 */
export function botUserSenderAvatarUrl(
  sender: OpenUserMessageSender,
  resolveMember: BotMemberResolver,
): string | null {
  if (sender.type !== "user") return null;
  return resolveMember(sender.userId)?.avatarUrl ?? null;
}

/** A user row's sender in a bot chat, the viewer included; null for an agent sender. */
export function botUserSenderId(sender: OpenUserMessageSender): string | null {
  return sender.type === "user" ? sender.userId : null;
}

/**
 * Who made a team bot, for its Home row: "Created by you" for the viewer,
 * "Created by <name>" for a member the directory names, and null - no line
 * at all - for a personal bot, an erased creator, or a member the directory
 * does not name. Never a raw id.
 */
export function botCreatedByLabel(input: {
  readonly createdByUserId: string | null;
  readonly viewerUserId: string | null;
  readonly isTeamBot: boolean;
  readonly resolveMember: BotMemberResolver;
}): string | null {
  const { createdByUserId, viewerUserId, isTeamBot, resolveMember } = input;
  if (!isTeamBot || createdByUserId === null) return null;
  if (createdByUserId === viewerUserId) return "Created by you";
  const name = resolveMember(createdByUserId)?.displayName ?? null;
  return name === null ? null : `Created by ${name}`;
}
