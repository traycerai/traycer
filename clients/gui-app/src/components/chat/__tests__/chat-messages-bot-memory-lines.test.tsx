import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import {
  BotExchangeLinesContext,
  type BotExchangeLines,
} from "@/components/chat/bot-exchange-lines-context";
import {
  BotMemoryLinesContext,
  type BotMemoryLines,
} from "@/components/chat/bot-memory-lines-context";
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
  RELEASE_BOT_ID,
  SENT_MIRROR,
  TRUNK_CHAT_ID,
  feedEvent,
} from "@/lib/bots/__tests__/bot-exchange-test-support";
import type { BotMemoryFocus } from "@/stores/bots/bot-open-thread-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "./legend-list-test-environment";

const NO_REWRITTEN: ReadonlySet<string> = new Set();

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

function row(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
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
});
const REPLY = row({
  id: "reply-1",
  role: "assistant",
  text: "Release Bot has the notes drafted.",
  createdAt: 3_000,
});

function added(input: {
  readonly id: string;
  readonly at: number;
  readonly entryId: string;
}): BotMemoryChange {
  return {
    id: input.id,
    at: input.at,
    action: "add",
    memory: "shared",
    entryId: input.entryId,
    threadId: null,
  };
}

const BETWEEN = added({ id: "change-1", at: 2_000, entryId: "entry-1" });

function exchangesAt(
  ...times: ReadonlyArray<number>
): ReadonlyArray<BotExchange> {
  return botExchangesOf(
    times.map((timestamp) =>
      feedEvent({
        id: timestamp,
        kind: "a2a_message",
        timestamp,
        sender: TRUNK_CHAT_ID,
        receiver: `trunk-of-${RELEASE_BOT_ID}`,
        text: "to Release Bot",
        responseId: `r-${timestamp}`,
        inReplyTo: null,
        peerEpicId: RELEASE_BOT_ID,
        origin: SENT_MIRROR,
      }),
    ),
    BOT_ID,
  );
}

const [EXCHANGE] = exchangesAt(1_800);

function exchangeLines(
  exchanges: ReadonlyArray<BotExchange>,
): BotExchangeLines {
  return {
    exchanges,
    botTitle: "Tracy",
    peerName: () => "Release Bot",
    openPair: () => undefined,
  };
}

function memoryLines(
  changes: ReadonlyArray<BotMemoryChange>,
  openMemory: (focus: BotMemoryFocus) => void,
): BotMemoryLines {
  return { changes, botTitle: "Tracy", openMemory };
}

function Channel(props: {
  readonly exchanges: BotExchangeLines | null;
  readonly memory: BotMemoryLines | null;
}): ReactElement {
  const subagentDrillIn = useSubagentDrillIn(true);
  return (
    <TooltipProvider>
      <ChatBotPresentationContext value={PRESENTATION}>
        <BotExchangeLinesContext value={props.exchanges}>
          <BotMemoryLinesContext value={props.memory}>
            <div style={{ height: 700, width: 800 }}>
              <ChatMessages
                taskTitle="Tracy"
                taskId="channel-1"
                epicId={BOT_ID}
                hostId={null}
                messages={[POST, REPLY]}
                transcriptWindow={null}
                onVisibleOrdinalRangeChange={() => undefined}
                onFindReadOrdinalChange={() => undefined}
                baselineEpoch={0}
                hydrationSequence={0}
                coldRewrittenMessageIds={NO_REWRITTEN}
                backgroundItems={[]}
                getMessageActions={() => null}
                nextStepActions={null}
                instanceId="bot-memory-lines"
                visible
                systemOverlayActive={false}
                scrollRequest={null}
                onScrollRequestSettled={() => undefined}
                composerOverlayHeight={0}
                subagentDrillIn={subagentDrillIn}
              />
            </div>
          </BotMemoryLinesContext>
        </BotExchangeLinesContext>
      </ChatBotPresentationContext>
    </TooltipProvider>
  );
}

async function mount(props: {
  readonly exchanges: BotExchangeLines | null;
  readonly memory: BotMemoryLines | null;
}): Promise<void> {
  render(<Channel {...props} />);
  await settleLegendList();
}

describe("a bot's memory changes in the real ChatMessages", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("draws a memory line between the rows it falls between, its segment named and labelled", async () => {
    await mount({
      exchanges: null,
      memory: memoryLines([BETWEEN], () => undefined),
    });

    const line = screen.getByTestId("bot-memory-line");
    const segment = within(line).getByTestId("bot-memory-line-segment");
    expect(segment.textContent).toBe("Common memory · 1 added");
    expect(segment.getAttribute("aria-label")).toBe(
      "Open common memory: 1 added",
    );
    const post = screen.getByText("Can we get the release notes drafted?");
    const reply = screen.getByText("Release Bot has the notes drafted.");
    expect(post.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(line.compareDocumentPosition(reply)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("opens the memory the segment names, focused on the entries the line names", async () => {
    const openMemory = vi.fn<(focus: BotMemoryFocus) => void>();
    await mount({
      exchanges: null,
      memory: memoryLines([BETWEEN], openMemory),
    });

    fireEvent.click(screen.getByTestId("bot-memory-line-segment"));

    expect(openMemory).toHaveBeenCalledExactlyOnceWith({
      memory: "shared",
      entryIds: ["entry-1"],
    });
  });

  it("keeps a memory line and an exchange line at adjacent times as two lines", async () => {
    await mount({
      exchanges: exchangeLines([EXCHANGE]),
      memory: memoryLines([BETWEEN], () => undefined),
    });

    const exchange = screen.getByTestId("bot-exchange-line");
    const memory = screen.getByTestId("bot-memory-line");
    expect(exchange).not.toBe(memory);
    expect(exchange.contains(memory)).toBe(false);
    expect(memory.contains(exchange)).toBe(false);
    expect(
      within(exchange).queryByTestId("bot-memory-line-segment"),
    ).toBeNull();
    expect(within(memory).queryByTestId("bot-exchange-pair")).toBeNull();
  });

  it("draws exchange, memory, exchange between two messages in the order they happened, each line at its own time", async () => {
    await mount({
      exchanges: exchangeLines(exchangesAt(1_500, 2_500)),
      memory: memoryLines([BETWEEN], () => undefined),
    });

    const lines = screen
      .getAllByTestId(/^bot-(exchange|memory)-line$/)
      .map((line) => line.getAttribute("data-testid"));
    expect(lines).toEqual([
      "bot-exchange-line",
      "bot-memory-line",
      "bot-exchange-line",
    ]);
    const [first, memory, last] = screen.getAllByTestId(
      /^bot-(exchange|memory)-line$/,
    );
    const post = screen.getByText("Can we get the release notes drafted?");
    const reply = screen.getByText("Release Bot has the notes drafted.");
    expect(post.compareDocumentPosition(first)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(first.compareDocumentPosition(memory)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(memory.compareDocumentPosition(last)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(last.compareDocumentPosition(reply)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(first).getByTestId("bot-exchange-pair")).toBeTruthy();
    expect(within(last).getByTestId("bot-exchange-pair")).toBeTruthy();
    expect(
      [first, memory, last].map((line) =>
        within(line)
          .getByTestId("chat-message-timestamp")
          .getAttribute("datetime"),
      ),
    ).toEqual(
      [1_500, 2_000, 2_500].map((time) => new Date(time).toISOString()),
    );
  });

  it("draws a later exchange after a trailing memory line as a new exchange line", async () => {
    const trailing = added({ id: "change-trailing", at: 3_500, entryId: "e9" });
    const memory = memoryLines([trailing], () => undefined);
    const view = render(
      <Channel exchanges={exchangeLines(exchangesAt(3_400))} memory={memory} />,
    );
    await settleLegendList();
    view.rerender(
      <Channel
        exchanges={exchangeLines(exchangesAt(3_400, 3_600))}
        memory={memory}
      />,
    );
    await settleLegendList();

    const lines = screen
      .getAllByTestId(/^bot-(exchange|memory)-line$/)
      .map((line) => line.getAttribute("data-testid"));
    expect(lines).toEqual([
      "bot-exchange-line",
      "bot-memory-line",
      "bot-exchange-line",
    ]);
  });

  it("draws no memory line without the memory context", async () => {
    await mount({ exchanges: null, memory: null });

    expect(screen.getByText("Release Bot has the notes drafted.")).toBeTruthy();
    expect(screen.queryByTestId("bot-memory-line")).toBeNull();
  });
});
