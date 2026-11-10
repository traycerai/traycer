import { isRecord } from "@/lib/editor/prosemirror-json";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";

/**
 * The message a member chose to reply to (Tracy Bots T166), as their box
 * keeps it until it sends: the message by its id, and its writer and first
 * line as the row showed them when Reply was chosen, so the box names it
 * after a restart or while the row is not loaded. What the send carries is
 * the id alone; the badge on the sent row reads the message as it is then.
 */
export interface BotReplyTarget {
  readonly messageId: string;
  readonly author: string;
  /** Its first line, cut to {@link BOT_REPLY_LINE_MAX}; `null` for a message with no text. */
  readonly line: string | null;
}

/**
 * The most of a first line a box keeps on this device. The box names the
 * message on one line that cuts it to its width, so nothing past the widest
 * line it draws is ever read; the cap keeps a long message's first line from
 * being stored whole.
 */
export const BOT_REPLY_LINE_MAX = 200;

/** A reply target for the row `messageId`, written by `author`, whose text is `text`. */
export function botReplyTargetOf(
  messageId: string,
  author: string,
  text: string | null,
): BotReplyTarget {
  return { messageId, author, line: boundedLine(firstLineOf(text)) };
}

/** A reply target read back from storage; `null` for anything that does not read as one. */
export function storedBotReplyTargetOf(value: unknown): BotReplyTarget | null {
  if (!isRecord(value)) return null;
  const { messageId, author, line } = value;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (typeof author !== "string") return null;
  if (line !== null && typeof line !== "string") return null;
  return { messageId, author, line: boundedLine(line) };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `line` cut to {@link BOT_REPLY_LINE_MAX} characters as a reader counts them, an ellipsis marking the cut. */
function boundedLine(line: string | null): string | null {
  if (line === null) return null;
  const characters = Array.from(
    graphemes.segment(line),
    (part) => part.segment,
  );
  if (characters.length <= BOT_REPLY_LINE_MAX) return line;
  return `${characters.slice(0, BOT_REPLY_LINE_MAX - 1).join("")}…`;
}
