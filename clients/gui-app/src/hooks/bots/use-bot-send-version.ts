import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  botConversationSendV13,
  botConversationSendV14,
  botConversationSendV15,
  botConversationSendV16,
} from "@traycer/protocol/host/bot/contracts";
import {
  BOT_HOST_TAKES_ANSWER_SETS,
  BOT_HOST_TAKES_IMAGES,
  BOT_HOST_TAKES_REPLIES,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/**
 * The `bot.conversation.send` line that retries a failed message
 * (`redeliver`) and replaces one with an edit (`supersedes`): an older host
 * would drop both and take the message as a new post.
 */
export const BOT_CONVERSATION_RETRY_VERSION = { major: 1, minor: 1 } as const;

/**
 * The `bot.conversation.send` line that answers or skips a bot's question
 * from its card (`answer`): an older host would drop it and take the answer
 * as a plain post, leaving the question open.
 */
export const BOT_CONVERSATION_ANSWER_VERSION = {
  major: 1,
  minor: 2,
} as const;

/**
 * The `bot.conversation.send` line that takes a call's words (`spoken`, and
 * `origin` for the thread a call opens): an older host would drop both and
 * take them as an ordinary post.
 */
export const BOT_CONVERSATION_CALL_VERSION =
  botConversationSendV13.schemaVersion;

/**
 * The `bot.conversation.send` line that carries a member's images
 * (`attachments`): an older host would drop them and take the text alone.
 */
export const BOT_CONVERSATION_IMAGES_VERSION =
  botConversationSendV14.schemaVersion;

/**
 * The `bot.conversation.send` line that takes a card's answers as one set
 * (`answers`, T167): an older host would drop them and take the text as a
 * plain post, leaving the questions open.
 */
export const BOT_CONVERSATION_ANSWER_SET_VERSION =
  botConversationSendV15.schemaVersion;

/**
 * The `bot.conversation.send` line that names the message a member chose to
 * reply to (`replyTo`, T166): an older host would drop it and post the
 * message without the badge that links the two.
 */
export const BOT_CONVERSATION_REPLY_VERSION =
  botConversationSendV16.schemaVersion;

/** Whether a host that negotiated `negotiated` for `bot.conversation.send` takes a send that needs `required`. */
export function botSendTakes(
  negotiated: SchemaVersion | null,
  required: SchemaVersion,
): boolean {
  return (
    negotiated !== null &&
    negotiated.major === required.major &&
    negotiated.minor >= required.minor
  );
}

/**
 * How a question card's answers reach the bot:
 * - `none`: the host serving the tab takes no answer from a card, which is
 *   drawn without actions, the person's draft kept, and its question is
 *   answered in its thread;
 * - `each`: each question is answered on its own;
 * - `together`: one Submit sends them all as one message. The tab's host takes
 *   that, and so does the bot's: it is the same host, or the bot's bound host
 *   said it does, as its thread list reports it.
 */
export type BotAnswerReach = "none" | "each" | "together";

export function useBotAnswerReach(input: {
  /** The host serving the tab. */
  readonly hostId: string;
  /** The host that runs the bot; `null` when none does. */
  readonly boundHostId: string | null;
  /** What that host said it takes, as its thread list reports it. */
  readonly boundHostTakes: readonly string[];
}): BotAnswerReach {
  const { hostId, boundHostId, boundHostTakes } = input;
  const negotiated = useHostMethodSchemaVersion(
    hostId,
    "bot.conversation.send",
  );
  if (!botSendTakes(negotiated, BOT_CONVERSATION_ANSWER_VERSION)) {
    return "none";
  }
  if (!botSendTakes(negotiated, BOT_CONVERSATION_ANSWER_SET_VERSION)) {
    return "each";
  }
  return boundHostId === hostId ||
    boundHostTakes.includes(BOT_HOST_TAKES_ANSWER_SETS)
    ? "together"
    : "each";
}

/**
 * What a message box does with images:
 * - `none`: the host serving the tab takes none, so the box takes no drop and
 *   no paste, and says nothing;
 * - `delivered`: they reach the bot;
 * - `held-back`: the tab's host takes them, the bot's bound host has not said
 *   it does. The box keeps them and says so, and Send carries the text alone.
 */
export type BotImageReach = "none" | "delivered" | "held-back";

export function useBotImageReach(input: {
  /** The host serving the tab. */
  readonly hostId: string;
  /** The host that runs the bot; `null` when none does. */
  readonly boundHostId: string | null;
  /** What that host said it takes, as its thread list reports it. */
  readonly boundHostTakes: readonly string[];
}): BotImageReach {
  const { hostId, boundHostId, boundHostTakes } = input;
  const taken = botSendTakes(
    useHostMethodSchemaVersion(hostId, "bot.conversation.send"),
    BOT_CONVERSATION_IMAGES_VERSION,
  );
  if (!taken) return "none";
  return boundHostId === hostId ||
    boundHostTakes.includes(BOT_HOST_TAKES_IMAGES)
    ? "delivered"
    : "held-back";
}

/**
 * Where a member's Reply (T166) reaches the bot:
 * - `none`: the host serving the tab takes no reply, so no row offers Reply,
 *   and a box that kept one from before shows none and sends without it;
 * - `delivered`: rows offer Reply, and the box's send names the message;
 * - `held-back`: the tab's host takes replies, the bot's bound host has not
 *   said it does. No row offers Reply; a box that kept one says so, and Send
 *   carries the message without it.
 */
export type BotReplyReach = "none" | "delivered" | "held-back";

export function useBotReplyReach(input: {
  /** The host serving the tab. */
  readonly hostId: string;
  /** The host that runs the bot; `null` when none does. */
  readonly boundHostId: string | null;
  /** What that host said it takes, as its thread list reports it. */
  readonly boundHostTakes: readonly string[];
}): BotReplyReach {
  const { hostId, boundHostId, boundHostTakes } = input;
  const taken = botSendTakes(
    useHostMethodSchemaVersion(hostId, "bot.conversation.send"),
    BOT_CONVERSATION_REPLY_VERSION,
  );
  if (!taken) return "none";
  return boundHostId === hostId ||
    boundHostTakes.includes(BOT_HOST_TAKES_REPLIES)
    ? "delivered"
    : "held-back";
}
