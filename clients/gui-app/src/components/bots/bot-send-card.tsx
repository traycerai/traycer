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
import {
  sendQuestionStates,
  type BotSend,
  type BotSendQuestion,
} from "@/lib/bots/bot-send-tool";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";

/**
 * One of the bot's sends in its session, read-only (Tracy Bots T93): where it
 * went - the channel, or the session's thread named by its post - and what it
 * posted, its Markdown rendered as the channel renders it, a reply's choices and a question's options drawn as they read, with
 * nothing to press but the link to where it landed. What in a task a send
 * pointed at (T89) is named under its text, never acted on. Nothing is
 * answered here. Outside a bot's session it names no place and links
 * nowhere.
 *
 * Where the host stamped the post the send wrote on its call (T94), the link
 * goes to that post - in the channel, or its thread - and a question reads
 * the post as the channel holds it: each question settled says so as the
 * channel's card does (answered by whom, skipped, or settled by the bot),
 * and one still open says nothing. A send from before the stamp links to
 * the post a reply or question follows, the thread, or the channel, and a
 * question claims no state.
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
          <AskedQuestions
            questions={send.questions}
            receipt={send.receipt}
            access={access}
          />
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

/** A question's questions, read against the post it wrote where the host stamped it in a bot's session. */
function AskedQuestions(props: {
  readonly questions: ReadonlyArray<BotSendQuestion>;
  readonly receipt: BotSend["receipt"];
  readonly access: BotSessionAccess | null;
}): ReactNode {
  const { questions, receipt, access } = props;
  if (access === null || receipt === null) {
    return <SendQuestions questions={questions} states={null} />;
  }
  return (
    <ChannelPost
      botId={access.botId}
      hostId={access.hostId}
      conversationId={receipt.conversationId}
      messageId={receipt.messageId}
      fetchCold
    >
      {(post) => (
        <SendQuestions
          questions={questions}
          states={sendQuestionStates(post, access)}
        />
      )}
    </ChannelPost>
  );
}

/**
 * A question's questions as the bot asked them, and under each settled one
 * what the channel's card says of it; `states` is `null` where the post is
 * not read.
 */
function SendQuestions(props: {
  readonly questions: ReadonlyArray<BotSendQuestion>;
  readonly states: ReadonlyArray<string | null> | null;
}): ReactNode {
  const { questions, states } = props;
  return (
    <ol className="flex flex-col gap-1.5">
      {questions.map((question, index) => {
        const state = states?.[index] ?? null;
        return (
          <li
            key={question.text}
            data-testid="bot-send-question"
            className="flex flex-col gap-1"
          >
            <p className="whitespace-pre-wrap text-foreground">
              {question.text}
            </p>
            <SendOptions options={question.options} />
            {state === null ? null : (
              <p
                data-testid="bot-send-question-state"
                className="whitespace-pre-wrap text-ui-xs text-muted-foreground"
              >
                {state}
              </p>
            )}
          </li>
        );
      })}
    </ol>
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
 * The link to where a send landed: the post it wrote where the host stamped
 * it, else a reply's or question's post in the channel, the thread it went
 * to, or the channel. Nothing outside a bot's session.
 */
function SendLink(props: {
  readonly send: BotSend;
  readonly access: BotSessionAccess | null;
}): ReactNode {
  const { send, access } = props;
  if (access === null) return null;
  const thread = threadOf(send, access);
  const repliesTo = send.kind === "announce" ? null : send.repliesTo;
  const post = thread === null ? send.receipt : null;
  const go =
    thread !== null
      ? () => access.openThread(thread.threadId)
      : () => access.openChannel(post?.messageId ?? repliesTo);
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="ml-auto"
      data-testid="bot-send-open"
      onClick={go}
    >
      {sendLinkLabel(
        send,
        thread !== null,
        post !== null || repliesTo !== null,
      )}
    </Button>
  );
}

function sendLinkLabel(
  send: BotSend,
  inThread: boolean,
  opensPost: boolean,
): string {
  if (send.kind === "ask") {
    return inThread ? "Open in the thread" : "Open in the channel";
  }
  if (inThread) return "Open thread";
  return opensPost ? "Open post" : "Open channel";
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
