import type { SchemaVersion } from "@traycer/protocol/framework/index";
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
