import { useContext, type ReactElement, type ReactNode } from "react";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import { cn } from "@/lib/utils";
import {
  ChatBotRepliesContext,
  type ChatBotReplies,
} from "./chat-bot-presentation-context";

/**
 * When a row draws its badge. `when-apart` draws none while the message it
 * answers is the row directly above, as WhatsApp and iMessage keep a simple
 * back-and-forth unmarked: the bot's own replies (Tracy Bots T165, rule 3).
 * `always` draws it there too: a reply the member chose, which always shows
 * what it answers.
 */
export type ChatReplyBadgeAdjacency = "when-apart" | "always";

/** The message a badge names: read, being read, or unreadable. */
export type ChatReplyBadgeAnswered =
  | {
      readonly kind: "message";
      readonly author: string;
      /** Its first line; `null` for a message with no text. */
      readonly line: string | null;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" };

/**
 * A reply's badge (Tracy Bots T165): one line above the row, a hook from the
 * row's picture, then the answered message's writer and its first line, cut
 * to one line. Choosing it shows the message. While the message is read the
 * line holds its place, and a message that cannot be read says only that,
 * since a reply names its message by id alone.
 */
export function ChatReplyBadge(props: {
  readonly answered: ChatReplyBadgeAnswered;
  /** Shows the answered message; `null` where it cannot be shown. */
  readonly onOpen: (() => void) | null;
}): ReactElement {
  const { answered, onOpen } = props;
  const hook = (
    <span
      aria-hidden="true"
      className="mt-2 h-2 w-5 shrink-0 rounded-tl-md border-t-2 border-l-2 border-border"
    />
  );
  const rowClassName =
    "ml-4.5 flex min-w-0 max-w-full items-center gap-1.5 self-start text-ui-xs text-muted-foreground";
  if (answered.kind === "loading") {
    return (
      <div className={rowClassName} data-testid="bot-reply-badge-loading">
        {hook}
        <span
          role="status"
          aria-label="Loading message"
          className="h-3 w-40 max-w-full animate-pulse rounded-sm bg-foreground/10"
        />
      </div>
    );
  }
  if (answered.kind === "unavailable") {
    return (
      <div className={rowClassName} data-testid="bot-reply-badge-unavailable">
        {hook}
        <span className="truncate">Message unavailable</span>
      </div>
    );
  }
  const content = (
    <>
      {hook}
      <span className="shrink-0 font-semibold text-foreground">
        {answered.author}
      </span>
      {answered.line === null ? null : (
        <span className="min-w-0 truncate">{answered.line}</span>
      )}
    </>
  );
  if (onOpen === null) {
    return (
      <div className={rowClassName} data-testid="bot-reply-badge">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={
        answered.line === null
          ? `Replying to ${answered.author}`
          : `Replying to ${answered.author}: ${answered.line}`
      }
      className={cn(
        rowClassName,
        "rounded-sm text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
      )}
      data-testid="bot-reply-badge"
      onClick={onOpen}
    >
      {content}
    </button>
  );
}

/**
 * The badge of a row in a bot's channel or thread that answers a message:
 * `null` outside such a list, for a row not stored yet, and under the
 * adjacency rule. The answered message is read from the list's own
 * conversation (fetched when the list has not loaded it), or from the
 * channel for the post a thread opens on.
 */
export function ChatReplyBadgeSlot(props: {
  /** The row's own message id; `null` for a row not stored yet. */
  readonly rowMessageId: string | null;
  /** The message the row answers. */
  readonly answeredId: string;
  readonly adjacency: ChatReplyBadgeAdjacency;
  /**
   * On a member's answers to a bot's card (T167): how many questions they
   * answer, said after the card's first line. `null` on any other reply.
   */
  readonly questionCount: number | null;
}): ReactNode {
  const { rowMessageId, answeredId, adjacency, questionCount } = props;
  const replies = useContext(ChatBotRepliesContext);
  if (replies === null || rowMessageId === null) return null;
  if (
    adjacency === "when-apart" &&
    replies.above(rowMessageId) === answeredId
  ) {
    return null;
  }
  const opening =
    replies.opening?.messageId === answeredId ? replies.opening : null;
  const show = showAnswered(replies, opening, answeredId);
  return (
    <ChannelPost
      botId={replies.botId}
      hostId={replies.hostId}
      conversationId={opening?.conversationId ?? replies.conversationId}
      messageId={answeredId}
      fetchCold
    >
      {(post, missing) => (
        <ChatReplyBadge
          answered={answeredOf(post, missing, replies, questionCount)}
          onOpen={post === null ? null : show}
        />
      )}
    </ChannelPost>
  );
}

/** Shows the answered message: the opening post in place, else a landing on the list's row. */
function showAnswered(
  replies: ChatBotReplies,
  opening: ChatBotReplies["opening"],
  answeredId: string,
): (() => void) | null {
  if (opening !== null) return opening.show;
  const open = replies.open;
  if (open === null) return null;
  return () => open(answeredId);
}

function answeredOf(
  post: OpenMessage | null,
  missing: boolean,
  replies: ChatBotReplies,
  questionCount: number | null,
): ChatReplyBadgeAnswered {
  if (post === null) return { kind: missing ? "unavailable" : "loading" };
  const author =
    post.role === "assistant"
      ? replies.botTitle
      : replies.memberName(
          post.sender.type === "user" ? post.sender.userId : null,
        );
  const first = firstLineOf(postTextOf(post));
  if (questionCount === null) return { kind: "message", author, line: first };
  const count =
    questionCount === 1 ? "1 question" : `${questionCount} questions`;
  return { kind: "message", author, line: cardLine(first, count) };
}

/**
 * A card's first line with how many questions were answered: "Three things
 * before I start: 3 questions". A line that already ends in a colon keeps
 * one, and one that ends a sentence takes the count after a space.
 */
function cardLine(first: string | null, count: string): string {
  const stem = first?.replace(/[\s:]+$/u, "") ?? "";
  if (stem.length === 0) return count;
  return /[.!?]$/u.test(stem) ? `${stem} ${count}` : `${stem}: ${count}`;
}
