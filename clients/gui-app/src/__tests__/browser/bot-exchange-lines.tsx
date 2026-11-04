import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { epicCommunicationGraphEventSchema } from "@traycer/protocol/host/epic/communication-graph";
import { ChatMessages } from "@/components/chat/chat-messages";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import {
  BotExchangeLinesContext,
  type BotExchangeLines,
} from "@/components/chat/bot-exchange-lines-context";
import { BotExchangeLog } from "@/components/bots/bot-exchange-log";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { botExchangesOf, exchangeLogOf } from "@/lib/bots/bot-exchanges";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import "@/index.css";

/**
 * A BOT'S CHANNEL WITH ITS MESSAGES TO OTHER BOTS, AND ONE PAIR'S LOG BESIDE IT.
 *
 * The real `ChatMessages` draws a channel in the bot's layout: a member's
 * post, the bot's reply and a later post. The bot's Communication Graph feed
 * is seeded as wire rows (each parsed through the protocol's event schema),
 * and the production classifier turns them into the bot's exchanges: two runs
 * with Release Bot and Docs Bot around the reply, and a row to a task's agent
 * and a same-task row that are not exchanges. The list builder places the
 * runs as lines; the log for Tracy ↔ Release Bot is the production panel over
 * the same exchanges. The page follows the system's colour scheme, as the app does.
 */
const BOT_ID = "bot_01JC0000000000000000000000";
const RELEASE_BOT_ID = "bot_01JC0000000000000000000001";
const DOCS_BOT_ID = "bot_01JC0000000000000000000002";
const TRUNK = "trunk-tracy";
const RELEASE_TRUNK = "trunk-release";
const DOCS_TRUNK = "trunk-docs";
const AT = new Date(2026, 10, 3, 9, 12).getTime();
const MINUTE = 60_000;

function feedRow(input: {
  readonly id: number;
  readonly minutes: number;
  readonly sender: string;
  readonly receiver: string;
  readonly text: string;
  readonly responseId: string;
  readonly inReplyTo: string | null;
  readonly peerEpicId: string | null;
  readonly kind: "a2a_message" | "a2a_notice";
}): CommGraphEvent {
  const event = epicCommunicationGraphEventSchema.parse({
    id: input.id,
    kind: input.kind,
    timestamp: AT + input.minutes * MINUTE,
    senderAgentId: input.sender,
    receiverAgentId: input.receiver,
    responseId: input.responseId,
    inReplyTo: input.inReplyTo,
    expectReply: input.inReplyTo === null,
    messageText: input.text,
    noticeReason: input.kind === "a2a_notice" ? "turn-ended" : null,
    // As the host writes each side: Tracy's received copy is promoted from
    // the delivery onto the receiving session; a message Tracy sent is the
    // sending task's mirror, with no origin.
    ...(input.receiver === TRUNK
      ? {
          originKind: "gui_message",
          originChatId: input.receiver,
          originRefId: `receipt-${input.id}`,
        }
      : { originKind: null, originChatId: null, originRefId: null }),
    peerEpicId: input.peerEpicId,
  });
  return { ...event, hostId: "host-1" };
}

const FEED: ReadonlyArray<CommGraphEvent> = [
  feedRow({
    id: 1,
    minutes: 1,
    sender: TRUNK,
    receiver: RELEASE_TRUNK,
    text: "Simar wants release notes for **staging.204** before standup. Do you have a draft, and what is still open in that train?",
    responseId: "r-release-1",
    inReplyTo: null,
    peerEpicId: RELEASE_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 2,
    minutes: 1,
    sender: TRUNK,
    receiver: DOCS_TRUNK,
    text: "Check the two renamed settings in staging.204 against the docs.",
    responseId: "r-docs-1",
    inReplyTo: null,
    peerEpicId: DOCS_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 3,
    minutes: 2,
    sender: RELEASE_TRUNK,
    receiver: TRUNK,
    text: "Draft is at `docs/releases/staging-204.md`. Open: the Windows smoke on the last train, retried once, green now.",
    responseId: "r-release-1",
    inReplyTo: "r-release-1",
    peerEpicId: RELEASE_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 4,
    minutes: 2,
    sender: TRUNK,
    receiver: "task-agent-1",
    text: "A task's agent, not a bot: no line.",
    responseId: "r-task-1",
    inReplyTo: null,
    peerEpicId: "task-1",
    kind: "a2a_message",
  }),
  feedRow({
    id: 5,
    minutes: 2,
    sender: TRUNK,
    receiver: RELEASE_TRUNK,
    text: "Thanks. I will post it once Docs Bot confirms the two renamed settings.",
    responseId: "r-release-1",
    inReplyTo: null,
    peerEpicId: RELEASE_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 6,
    minutes: 9,
    sender: TRUNK,
    receiver: RELEASE_TRUNK,
    text: "Docs Bot confirmed. Add the two renamed settings to the notes and tell me when the draft is final.",
    responseId: "r-release-2",
    inReplyTo: null,
    peerEpicId: RELEASE_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 7,
    minutes: 9,
    sender: RELEASE_TRUNK,
    receiver: TRUNK,
    text: "Added. Final.",
    responseId: "r-release-2",
    inReplyTo: "r-release-2",
    peerEpicId: RELEASE_BOT_ID,
    kind: "a2a_message",
  }),
  feedRow({
    id: 8,
    minutes: 10,
    sender: TRUNK,
    receiver: "trunk-tracy-thread",
    text: "A same-task row: no line.",
    responseId: "r-same-1",
    inReplyTo: null,
    peerEpicId: null,
    kind: "a2a_message",
  }),
];

const EXCHANGES = botExchangesOf(FEED, BOT_ID);

const NAMES: Readonly<Record<string, string>> = {
  [RELEASE_BOT_ID]: "Release Bot",
  [DOCS_BOT_ID]: "Docs Bot",
};

const LINES: BotExchangeLines = {
  exchanges: EXCHANGES,
  botTitle: "Tracy",
  peerName: (peerBotId) => NAMES[peerBotId] ?? null,
  openPair: () => undefined,
};

function row(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly minutes: number;
}): ChatMessageModel {
  const model: ChatMessageModel = {
    id: input.id,
    role: input.role,
    content: input.text,
    segments: [
      {
        id: `${input.id}:text`,
        kind: "text",
        markdown: input.text,
        isStreaming: false,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: AT + input.minutes * MINUTE,
    completedAt: null,
    showCompletionFooter: false,
    stopped: null,
    persistentMessageId: input.id,
    senderLabel: input.role === "user" ? "Simar" : null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
  return input.role === "user"
    ? { ...model, senderUserId: "user-simar" }
    : model;
}

const MESSAGES: ReadonlyArray<ChatMessageModel> = [
  row({
    id: "post-1",
    role: "user",
    text: "Can we get the release notes drafted for staging.204 before the standup?",
    minutes: 0,
  }),
  row({
    id: "reply-1",
    role: "assistant",
    text: "Release Bot has the notes for staging.204 drafted; Docs Bot is checking the two renamed settings. I will post the draft here when both are in.",
    minutes: 3,
  }),
];

const PRESENTATION: ChatBotPresentation = {
  botTitle: "Tracy",
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  questions: null,
  failedRequest: null,
  failedRecovery: null,
  replyReceipt: null,
  requestReceipt: null,
};

const IDENTITY = { botId: BOT_ID, title: "Tracy", owner: null } as const;
const NO_REWRITTEN: ReadonlySet<string> = new Set();

export function Channel(): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  return (
    <ChatBotPresentationContext.Provider value={PRESENTATION}>
      <BotExchangeLinesContext value={LINES}>
        <ChatMessages
          taskTitle="Tracy"
          taskId="channel-1"
          epicId={BOT_ID}
          hostId={null}
          messages={MESSAGES}
          transcriptWindow={null}
          onVisibleOrdinalRangeChange={() => undefined}
          onFindReadOrdinalChange={() => undefined}
          baselineEpoch={0}
          hydrationSequence={0}
          coldRewrittenMessageIds={NO_REWRITTEN}
          backgroundItems={[]}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId="bot-exchange-lines-channel"
          visible
          systemOverlayActive={false}
          scrollRequest={null}
          onScrollRequestSettled={() => undefined}
          composerOverlayHeight={0}
          subagentDrillIn={subagentDrillIn}
        />
      </BotExchangeLinesContext>
    </ChatBotPresentationContext.Provider>
  );
}

export function Harness(): ReactElement {
  return (
    <TooltipProvider>
      <BotIdentityContext value={IDENTITY}>
        <div className="flex h-full min-h-0 w-full bg-background text-foreground">
          <section
            data-testid="fixture-channel"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <Channel />
          </section>
          <aside className="flex min-h-0 w-2/5 flex-col border-l border-border/60">
            <BotExchangeLog
              botId={BOT_ID}
              botTitle="Tracy"
              peerBotId={RELEASE_BOT_ID}
              peerName="Release Bot"
              entries={exchangeLogOf(EXCHANGES, RELEASE_BOT_ID)}
              loading={false}
              onClose={() => undefined}
            />
          </aside>
        </div>
      </BotIdentityContext>
    </TooltipProvider>
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Harness />);
