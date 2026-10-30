import { use, type ReactNode } from "react";
import {
  CircleCheck,
  FileText,
  Globe,
  Megaphone,
  MessageCircleQuestion,
  Send,
} from "lucide-react";
import type { BotSurfaceKind } from "@traycer/protocol/persistence/epic/messages";
import { Button } from "@/components/ui/button";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { TextSegment } from "@/components/chat/segments/text-segment";
import {
  BotSessionContext,
  type BotSessionAccess,
} from "@/components/bots/bot-session-context";
import type { BotSend } from "@/lib/bots/bot-send-tool";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";

/**
 * One of the bot's sends in its session, read-only (Tracy Bots T93): where it
 * went - the channel, or the session's thread named by its post - and what it
 * posted, its Markdown rendered as the channel renders it, a reply's choices and a question's options drawn as they read, with
 * nothing to press but the link to where it landed: the post a reply or
 * question follows, the thread, or the channel. What in a task a send
 * pointed at (T89) is named under its text, never acted on. A question is
 * drawn as the bot asked it and claims no state - neither open nor answered
 * nor settled: the tool call does not name the post it wrote, so the
 * settlement arrives with the host stamping that post on the call. Nothing
 * is answered here. Outside a bot's session it names no place and links
 * nowhere.
 */
export function BotSendCard(props: {
  readonly id: string;
  readonly send: BotSend;
  readonly findUnitId: string | null;
}): ReactNode {
  const { id, send, findUnitId } = props;
  const access = use(BotSessionContext);
  const Icon = SEND_ICONS[send.kind];
  return (
    <div
      data-testid="bot-send-card"
      data-kind={send.kind}
      data-block-id={id}
      className="flex max-w-prose flex-col gap-1.5 rounded-md border-l-2 border-primary/60 bg-foreground/3 px-3 py-2 text-ui-sm"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <SendPlace send={send} access={access} />
        <SendLink send={send} access={access} />
      </div>
      <div data-chat-find-unit={findUnitId ?? undefined}>
        {send.kind === "ask" ? (
          <ol className="flex flex-col gap-1.5">
            {send.questions.map((question) => (
              <li
                key={question.text}
                data-testid="bot-send-question"
                className="flex flex-col gap-1"
              >
                <p className="whitespace-pre-wrap text-foreground">
                  {question.text}
                </p>
                <SendOptions options={question.options} />
              </li>
            ))}
          </ol>
        ) : (
          <>
            <div data-testid="bot-send-text" className="text-foreground">
              <TextSegment
                findUnitId={null}
                markdown={send.text}
                isStreaming={false}
                nextStepActions={null}
              />
            </div>
            {send.kind === "reply" ? (
              <SendOptions options={send.options} />
            ) : null}
          </>
        )}
      </div>
      {send.kind === "ask" || send.surface === null ? null : (
        <SendSurface kind={send.surface} />
      )}
    </div>
  );
}

const SEND_ICONS = {
  reply: Send,
  ask: MessageCircleQuestion,
  announce: Megaphone,
} as const;

const SEND_VERBS = {
  reply: "Replied",
  ask: "Asked",
  announce: "Posted",
} as const;

/** The session's thread, where its reply or question went; `null` for the channel's. */
function threadOf(
  send: BotSend,
  access: BotSessionAccess | null,
): BotSessionAccess["thread"] {
  if (send.kind === "announce" || access === null) return null;
  return access.thread;
}

function SendPlace(props: {
  readonly send: BotSend;
  readonly access: BotSessionAccess | null;
}): ReactNode {
  const { send, access } = props;
  const verb = SEND_VERBS[send.kind];
  if (access === null) {
    return <span data-testid="bot-send-place">{verb}</span>;
  }
  const thread = threadOf(send, access);
  if (thread === null) {
    return <span data-testid="bot-send-place">{`${verb} in the channel`}</span>;
  }
  const label = `${verb} in the thread`;
  if (thread.post === null) {
    return <span data-testid="bot-send-place">{label}</span>;
  }
  return (
    <ChannelPost
      botId={access.botId}
      hostId={access.hostId}
      conversationId={thread.post.conversationId}
      messageId={thread.post.messageId}
      fetchCold
    >
      {(post) => {
        const line = firstLineOf(postTextOf(post));
        return (
          <span data-testid="bot-send-place" className="min-w-0 truncate">
            {line === null ? label : `${label} · ${line}`}
          </span>
        );
      }}
    </ChannelPost>
  );
}

/**
 * The link to where a send landed: a reply's or question's post in the
 * channel, the thread it went to, or the channel. Nothing outside a bot's
 * session.
 */
function SendLink(props: {
  readonly send: BotSend;
  readonly access: BotSessionAccess | null;
}): ReactNode {
  const { send, access } = props;
  if (access === null) return null;
  const thread = threadOf(send, access);
  const repliesTo = send.kind === "announce" ? null : send.repliesTo;
  const go =
    thread === null
      ? () => access.openChannel(repliesTo)
      : () => access.openThread(thread.threadId);
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="ml-auto"
      data-testid="bot-send-open"
      onClick={go}
    >
      {sendLinkLabel(send, thread !== null, repliesTo !== null)}
    </Button>
  );
}

function sendLinkLabel(
  send: BotSend,
  inThread: boolean,
  followsPost: boolean,
): string {
  if (send.kind === "ask") {
    return inThread ? "Open in the thread" : "Open in the channel";
  }
  if (inThread) return "Open thread";
  return followsPost ? "Open post" : "Open channel";
}

const SURFACE_LABELS = {
  question: { Icon: MessageCircleQuestion, label: "An agent's question" },
  approval: { Icon: CircleCheck, label: "An agent's approval" },
  browser: { Icon: Globe, label: "A browser session" },
  artifact: { Icon: FileText, label: "An artifact" },
} as const;

/** What in a task the send pointed at, named; it is shown and acted on in the channel. */
function SendSurface(props: { readonly kind: BotSurfaceKind }): ReactNode {
  const { Icon, label } = SURFACE_LABELS[props.kind];
  return (
    <p
      data-testid="bot-send-surface"
      data-surface-kind={props.kind}
      className="flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-ui-xs text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </p>
  );
}

/** A reply's choices or a question's options, as the person reads them; nothing presses them here. */
function SendOptions(props: {
  readonly options: ReadonlyArray<string>;
}): ReactNode {
  if (props.options.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Options">
      {props.options.map((option) => (
        <li
          key={option}
          data-testid="bot-send-option"
          className="rounded-md border border-dashed border-border px-2 py-0.5 text-ui-xs text-muted-foreground"
        >
          {option}
        </li>
      ))}
    </ul>
  );
}
