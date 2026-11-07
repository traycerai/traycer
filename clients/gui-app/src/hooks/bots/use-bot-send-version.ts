import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  botConversationSendV13,
  botConversationSendV14,
} from "@traycer/protocol/host/bot/contracts";
import { BOT_HOST_TAKES_IMAGES } from "@traycer/protocol/host/bot/conversation-schemas";
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
 * Whether the host serving the tab takes a question card's answer. A card on
 * one that does not is drawn without actions, the person's draft kept, and
 * its question is answered in its thread.
 */
export function useBotSendTakesAnswers(hostId: string): boolean {
  return botSendTakes(
    useHostMethodSchemaVersion(hostId, "bot.conversation.send"),
    BOT_CONVERSATION_ANSWER_VERSION,
  );
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
