import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { BotAnnouncement } from "@traycer/protocol/persistence/epic/messages";
import { ChatBotMessage } from "@/components/chat/chat-bot-message";
import { ChatMessage } from "@/components/chat/chat-message";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
  type ChatBotTurnReceipt,
} from "@/components/chat/chat-bot-presentation-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A BOT'S CHANNEL ROWS AND A THREAD'S, EACH WITH THE RECEIPT OF THE TURN
 * THAT WROTE IT.
 *
 * The real `ChatMessage` rows of a bot's channel, under the channel's
 * presentation, and the post a thread opens on as the thread panel draws it
 * (`ChatBotMessage` with no hover actions) above a reply in that thread. The
 * presentation names a turn for the reply, the check-in announcement, the
 * running reply and the thread's rows, and none for the announcement the host
 * posted itself when the bot was created. Nothing is hovered or focused: the
 * spec reads what a row shows at rest. `?theme=dark` draws it dark.
 */
const theme = new URLSearchParams(window.location.search).get("theme");
useSettingsStore.getState().setTheme(theme === "dark" ? "dark" : "light");

const NOW = Date.now();
const MINUTE = 60_000;

/** The turn behind each row a turn wrote, by the row's message id. */
const TURNS: ReadonlyMap<string, Omit<ChatBotTurnReceipt, "open">> = new Map(
  Object.entries({
    "reply-1": {
      summary: "Thought for 4s, read 3 files",
      startedAt: NOW - 30 * MINUTE,
      endedAt: NOW - 30 * MINUTE + 42_000,
    },
    "checkin-1": {
      summary: "Ran 2 commands, read 1 file",
      startedAt: NOW - 20 * MINUTE,
      endedAt: NOW - 20 * MINUTE + 18_000,
    },
    "reply-running": {
      summary: null,
      startedAt: NOW - 75_000,
      endedAt: null,
    },
    "thread-post": {
      summary: "Thought for 6s, edited 2 files",
      startedAt: NOW - 15 * MINUTE,
      endedAt: NOW - 15 * MINUTE + 95_000,
    },
    "thread-reply": {
      summary: "Read 4 files",
      startedAt: NOW - 5 * MINUTE,
      endedAt: NOW - 5 * MINUTE + 12_000,
    },
  }),
);

function replyReceipt(
  messageIds: ReadonlyArray<string>,
): ChatBotTurnReceipt | null {
  for (const messageId of messageIds) {
    const turn = TURNS.get(messageId);
    if (turn !== undefined) return { ...turn, open: () => undefined };
  }
  return null;
}

const presentation: ChatBotPresentation = {
  botTitle: "Tracy",
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  questions: null,
  failedRequest: null,
  failedRecovery: null,
  replyReceipt,
  requestReceipt: null,
};

function row(input: {
  readonly messageId: string;
  readonly role: ChatMessageModel["role"];
  readonly text: string;
  readonly at: number;
  readonly senderLabel: string | null;
  readonly announcement: BotAnnouncement | null;
}): ChatMessageModel {
  const base: ChatMessageModel = {
    id: `row-${input.messageId}`,
    role: input.role,
    content: input.text,
    segments: [
      {
        id: `row-${input.messageId}:text`,
        kind: "text",
        markdown: input.text,
        isStreaming: false,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: input.at,
    completedAt: null,
    stopped: null,
    persistentMessageId: input.messageId,
    senderLabel: input.senderLabel,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
    sentAt: input.at,
  };
  return input.announcement === null
    ? base
    : { ...base, announcement: input.announcement };
}

const CHANNEL: ReadonlyArray<ChatMessageModel> = [
  row({
    messageId: "bot-created",
    role: "assistant",
    text: "Tracy is set up in this channel. Post here and Tracy answers.",
    at: NOW - 60 * MINUTE,
    senderLabel: null,
    announcement: { kind: "bot-created", link: null },
  }),
  row({
    messageId: "post-1",
    role: "user",
    text: "Can you check why the nightly build is red?",
    at: NOW - 31 * MINUTE,
    senderLabel: "Tess Teammate",
    announcement: null,
  }),
  row({
    messageId: "reply-1",
    role: "assistant",
    text: "The nightly build is red on the Windows signing step; the certificate expired yesterday.",
    at: NOW - 29 * MINUTE,
    senderLabel: null,
    announcement: null,
  }),
  row({
    messageId: "checkin-1",
    role: "assistant",
    text: "Check-in: the release branch is green again and the staging train left at 14:02.",
    at: NOW - 19 * MINUTE,
    senderLabel: null,
    announcement: { kind: "automation", link: null },
  }),
  row({
    messageId: "reply-running",
    role: "assistant",
    text: "Looking into the flaky host test now.",
    at: NOW - MINUTE,
    senderLabel: null,
    announcement: null,
  }),
];

const THREAD_POST = row({
  messageId: "thread-post",
  role: "assistant",
  text: "Proposal: move the nightly train to 02:00 so it no longer races the merge queue.",
  at: NOW - 13 * MINUTE,
  senderLabel: null,
  announcement: { kind: "proposal", link: null },
});

const THREAD_REPLY = row({
  messageId: "thread-reply",
  role: "assistant",
  text: "Done: the schedule now reads 02:00, and the next train leaves tonight.",
  at: NOW - 4 * MINUTE,
  senderLabel: null,
  announcement: null,
});

const NO_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

function Rows(props: {
  readonly instanceId: string;
  readonly messages: ReadonlyArray<ChatMessageModel>;
}): ReactElement {
  return (
    <ChatOpenStoreScopeProvider value={props.instanceId}>
      <ActivityGroupOpenStoreProvider store={null}>
        <A2AOpenStoreProvider store={null}>
          <ChatFindForceStoreProvider tileInstanceId={props.instanceId}>
            {props.messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                actions={null}
                backgroundToolBlockIds={NO_BACKGROUND_TOOL_BLOCK_IDS}
                nextStepActions={null}
              />
            ))}
          </ChatFindForceStoreProvider>
        </A2AOpenStoreProvider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}

export function Page(): ReactElement {
  return (
    <TooltipProvider>
      <ChatBotPresentationContext.Provider value={presentation}>
        <div className="flex min-h-safe-svh w-full flex-wrap gap-6 bg-background p-4 text-foreground">
          <section
            className="flex w-full max-w-xl flex-col"
            data-testid="fixture-channel"
          >
            <h2 className="px-3 pb-2 text-ui-xs text-muted-foreground uppercase">
              Channel
            </h2>
            <Rows instanceId="bot-row-receipts:channel" messages={CHANNEL} />
          </section>
          <section
            className="flex w-full max-w-md flex-col border-l border-border/60"
            data-testid="fixture-thread"
          >
            <h2 className="px-5 pb-2 text-ui-xs text-muted-foreground uppercase">
              Thread
            </h2>
            <div className="px-2" data-testid="bot-thread-anchor">
              <ChatBotMessage
                message={THREAD_POST}
                presentation={presentation}
                hoverActions={false}
              />
            </div>
            <Rows
              instanceId="bot-row-receipts:thread"
              messages={[THREAD_REPLY]}
            />
          </section>
        </div>
      </ChatBotPresentationContext.Provider>
    </TooltipProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("bot row receipts fixture root missing");
createRoot(root).render(<Page />);
