import type { ReactElement } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BotExchangeLinesContext,
  type BotExchangeLines,
} from "@/components/chat/bot-exchange-lines-context";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatMessages } from "@/components/chat/chat-messages";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { botExchangesOf, type BotExchange } from "@/lib/bots/bot-exchanges";
import {
  BOT_ID,
  DOCS_BOT_ID,
  RELEASE_BOT_ID,
  SENT_MIRROR,
  TRUNK_CHAT_ID,
  feedEvent,
} from "@/lib/bots/__tests__/bot-exchange-test-support";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "./legend-list-test-environment";

const NAMES: Readonly<Record<string, string>> = {
  [RELEASE_BOT_ID]: "Release Bot",
  [DOCS_BOT_ID]: "Docs Bot",
};
const NO_REWRITTEN: ReadonlySet<string> = new Set();

const PRESENTATION: ChatBotPresentation = {
  botTitle: "Tracy",
  threadLine: null,
  openThread: null,
  openAnnouncementThread: null,
  threadAnchorKinds: [],
  chooseOption: null,
  reply: null,
  questions: null,
  failedRequest: null,
  failedRecovery: null,
  replyReceipt: null,
  requestReceipt: null,
};

function row(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
  readonly streaming: boolean;
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
        isStreaming: input.streaming,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: input.createdAt,
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

const POST = row({
  id: "post-1",
  role: "user",
  text: "Can we get the release notes drafted?",
  createdAt: 1_000,
  streaming: false,
});
const REPLY = row({
  id: "reply-1",
  role: "assistant",
  text: "Release Bot has the notes drafted.",
  createdAt: 3_000,
  streaming: false,
});

function runningReply(text: string): ChatMessageModel {
  return row({
    id: "reply-2",
    role: "assistant",
    text,
    createdAt: 5_000,
    streaming: true,
  });
}

function sentTo(peer: string, timestamp: number): BotExchange {
  const [exchange] = botExchangesOf(
    [
      feedEvent({
        id: timestamp,
        kind: "a2a_message",
        timestamp,
        sender: TRUNK_CHAT_ID,
        receiver: `trunk-of-${peer}`,
        text: `to ${peer} at ${timestamp}`,
        responseId: `r-${timestamp}`,
        inReplyTo: null,
        peerEpicId: peer,
        origin: SENT_MIRROR,
      }),
    ],
    BOT_ID,
  );
  return exchange;
}

/**
 * Two historical runs: two messages with Release Bot between the post and the
 * first reply, two with Docs Bot between the replies.
 */
const EXCHANGES: ReadonlyArray<BotExchange> = [
  sentTo(RELEASE_BOT_ID, 1_500),
  sentTo(RELEASE_BOT_ID, 1_800),
  sentTo(DOCS_BOT_ID, 3_500),
  sentTo(DOCS_BOT_ID, 3_800),
];

/** `exchanges`, counting each element read through the proxy. */
function countingReads(exchanges: ReadonlyArray<BotExchange>): {
  readonly exchanges: ReadonlyArray<BotExchange>;
  readonly reads: () => number;
  readonly reset: () => void;
} {
  let reads = 0;
  return {
    exchanges: new Proxy(exchanges, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        const element: unknown = Reflect.get(target, property, receiver);
        return element;
      },
    }),
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

function Channel(props: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly lines: BotExchangeLines;
}): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  return (
    <TooltipProvider>
      <ChatBotPresentationContext value={PRESENTATION}>
        <BotExchangeLinesContext value={props.lines}>
          <div style={{ height: 700, width: 800 }}>
            <ChatMessages
              taskTitle="Tracy"
              taskId="channel-1"
              epicId={BOT_ID}
              hostId={null}
              messages={props.messages}
              transcriptWindow={null}
              onVisibleOrdinalRangeChange={() => undefined}
              onFindReadOrdinalChange={() => undefined}
              baselineEpoch={0}
              hydrationSequence={0}
              coldRewrittenMessageIds={NO_REWRITTEN}
              backgroundItems={[]}
              getMessageActions={() => null}
              nextStepActions={null}
              instanceId="bot-exchange-lines-streaming"
              visible
              systemOverlayActive={false}
              scrollRequest={null}
              onScrollRequestSettled={() => undefined}
              composerOverlayHeight={0}
              subagentDrillIn={subagentDrillIn}
            />
          </div>
        </BotExchangeLinesContext>
      </ChatBotPresentationContext>
    </TooltipProvider>
  );
}

describe("a bot's channel in the real ChatMessages while its reply streams", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("redraws no exchange line and reads no exchange for a token that changes only the running row's body", async () => {
    const counted = countingReads(EXCHANGES);
    const lines: BotExchangeLines = {
      exchanges: counted.exchanges,
      botTitle: "Tracy",
      peerName: (peerBotId) => NAMES[peerBotId] ?? null,
      openPair: () => undefined,
    };
    const view = render(
      <Channel
        messages={[POST, REPLY, runningReply("Docs Bot is checking")]}
        lines={lines}
      />,
    );
    await settleLegendList();

    const before = screen.getAllByTestId("bot-exchange-line");
    expect(
      before.map(
        (line) => within(line).getByTestId("bot-exchange-pair").textContent,
      ),
    ).toEqual([
      "Tracy ↔ Release Bot · 2 messages",
      "Tracy ↔ Docs Bot · 2 messages",
    ]);
    expect(counted.reads()).toBeGreaterThan(0);
    counted.reset();

    view.rerender(
      <Channel
        messages={[
          POST,
          REPLY,
          runningReply("Docs Bot is checking the two renamed settings"),
        ]}
        lines={lines}
      />,
    );
    await act(async () => {
      await settleLegendList();
    });

    expect(
      screen.getByText("Docs Bot is checking the two renamed settings"),
    ).toBeTruthy();
    const after = screen.getAllByTestId("bot-exchange-line");
    expect(after).toHaveLength(2);
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(counted.reads()).toBe(0);
  });
});
