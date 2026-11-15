/**
 * What a bot's memory changed (Tracy Bots T373), through the REAL
 * `BotChannelView`, `BotMemoryPanel` and the rail's store: the bot's memory
 * reading is the one `useBotMemory` hands both, and the lines and the focus
 * the pane opens with are what the view derives from its `changes`. Only the
 * virtualised message list is replaced, by a stub that runs the exchange and
 * memory collators on what the view provides and draws each row through the
 * real `<ChatMessage>`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotMemory,
  BotMemoryChange,
  BotMemoryEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { BotMemoryReading } from "@/hooks/bots/use-bot-memory";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { HostRpcRegistry } from "@/lib/host";
import {
  BOT_ID,
  CHANNEL_ID,
  THREAD_ID,
  THREAD_OPEN,
  TRUNK_ID,
  buildScene,
  hostClientLocating,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedKnowingChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
  reading: { kind: "loading" } as BotMemoryReading,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/bots/use-bot-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-memory")>()),
  useBotMemory: (): BotMemoryReading => mocks.reading,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
  useExistingChatSessionHandle: (
    _epicId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
    usePaneFocused: () => true,
  }),
);
vi.mock("@/hooks/bots/use-bot-conversation-list-query", () => ({
  useBotConversationListQuery: () => ({
    data: { conversations: [{ conversationId: CHANNEL_ID }] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: () => ({
    data: { threads: mocks.threads, threadAnchors: null },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock(
  "@/hooks/notifications/use-notification-mark-entity-read-mutation",
  () => ({
    useNotificationMarkEntityRead: () => ({ mutate: vi.fn() }),
  }),
);
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "light", themePreset: "neutral" }),
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => vi.fn(),
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { use, useState } = await import("react");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const { BotExchangeLinesContext } =
    await import("@/components/chat/bot-exchange-lines-context");
  const { BotMemoryLinesContext } =
    await import("@/components/chat/bot-memory-lines-context");
  const { createBotExchangeLineCollator } =
    await import("@/stores/chats/transcript-exchange-lines");
  const { createBotMemoryLineCollator } =
    await import("@/stores/chats/transcript-memory-lines");
  const { transcriptListRows } =
    await import("@/stores/chats/transcript-list-rows");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => {
      const [collateExchangeLines] = useState(createBotExchangeLineCollator);
      const [collateMemoryLines] = useState(createBotMemoryLineCollator);
      const rows = collateMemoryLines(
        collateExchangeLines(
          transcriptListRows({
            window: null,
            rendered: props.messages,
            splitLongTurns: false,
          }),
          use(BotExchangeLinesContext)?.exchanges ?? [],
        ),
        use(BotMemoryLinesContext)?.changes ?? [],
      );
      return (
        <Providers tileInstanceId={props.instanceId}>
          <div
            data-testid="chat-messages-stub"
            data-instance-id={props.instanceId}
          >
            {rows.map((row) =>
              row.kind === "hydrated" ? (
                <div
                  key={row.key}
                  data-testid="stub-row"
                  data-row-key={row.key}
                >
                  <ChatMessage
                    message={row.model}
                    actions={null}
                    backgroundToolBlockIds={noBackgroundToolBlockIds}
                    nextStepActions={null}
                  />
                </div>
              ) : null,
            )}
          </div>
        </Providers>
      );
    },
  };
});

const SHARED_ENTRY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const OWN_ENTRY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const UNCHANGED_ENTRY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";

function entry(input: {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
}): BotMemoryEntry {
  return {
    id: input.id,
    text: input.text,
    tags: [...input.tags],
    writtenBy: { botId: BOT_ID, chatId: TRUNK_ID, requestId: null },
    at: 1_000,
    confirmedAt: 1_000,
  };
}

function change(input: {
  readonly id: string;
  readonly at: number;
  readonly action: BotMemoryChange["action"];
  readonly memory: BotMemoryChange["memory"];
  readonly entryId: string;
  readonly threadId: string | null;
}): BotMemoryChange {
  return { ...input };
}

/** In the channel, between the member's post (1_000) and the bot's reply (2_000). */
const CHANNEL_CHANGE = change({
  id: "change-channel",
  at: 1_500,
  action: "add",
  memory: "shared",
  entryId: SHARED_ENTRY_ID,
  threadId: null,
});
/** In the thread, before its reply (3_000). */
const THREAD_CHANGE = change({
  id: "change-thread",
  at: 2_500,
  action: "update",
  memory: "own",
  entryId: OWN_ENTRY_ID,
  threadId: THREAD_ID,
});
/** In a thread the bot has no open surface for. */
const ELSEWHERE_CHANGE = change({
  id: "change-elsewhere",
  at: 2_600,
  action: "remove",
  memory: "shared",
  entryId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  threadId: "thread-elsewhere",
});

function memoryWith(changes: ReadonlyArray<BotMemoryChange>): BotMemory {
  return {
    entries: [
      entry({
        id: SHARED_ENTRY_ID,
        text: "The nightly is the release gate",
        tags: ["all"],
      }),
      entry({
        id: OWN_ENTRY_ID,
        text: "CI flakes on the host shard",
        tags: [BOT_ID],
      }),
      entry({
        id: UNCHANGED_ENTRY_ID,
        text: "The Codex CLI bump is held",
        tags: [BOT_ID],
      }),
    ],
    own: { entries: 2, chars: 60, ceiling: 8_000 },
    shared: { entries: 1, chars: 30, ceiling: 8_000 },
    changes: [...changes],
  };
}

function holdReady(changes: ReadonlyArray<BotMemoryChange>): void {
  mocks.reading = { kind: "ready", memory: memoryWith(changes) };
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  useBotOpenThreadStore.setState({ byBotId: {} });
  const scene = buildScene();
  mocks.sessions = scene.sessions;
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(() => ({ turns: [] }), []);
  mocks.reading = { kind: "loading" };
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
  mocks.client = null;
});

function openThread(): void {
  useBotOpenThreadStore.setState({
    byBotId: { [BOT_ID]: { kind: "thread", ...THREAD_OPEN } },
  });
}

function list(instanceId: string): HTMLElement {
  const element = document.querySelector(`[data-instance-id="${instanceId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${instanceId}`);
  return element;
}

const CHANNEL_LIST = `bot-channel:${BOT_ID}`;
const THREAD_LIST = `bot-thread:${THREAD_ID}`;

function segmentsIn(instanceId: string): ReadonlyArray<string> {
  return within(list(instanceId))
    .queryAllByTestId("bot-memory-line-segment")
    .map((segment) => segment.textContent);
}

function focusOf(pane: HTMLElement): Readonly<Record<string, string>> {
  return Object.fromEntries(
    within(pane)
      .getAllByTestId("bot-memory-entry")
      .map((row) => [
        row.getAttribute("data-entry-id") ?? "",
        row.getAttribute("data-focused") ?? "no",
      ]),
  );
}

describe("a bot's channel and threads with what its memory changed", () => {
  it("draws the channel's changes in the channel and an open thread's own changes in the thread, neither drawing the other's", async () => {
    holdReady([CHANNEL_CHANGE, THREAD_CHANGE, ELSEWHERE_CHANGE]);
    openThread();
    render(<MountedKnowingChannel />);

    await within(list(THREAD_LIST)).findByTestId("bot-memory-line");

    expect(segmentsIn(CHANNEL_LIST)).toEqual(["Common memory · 1 added"]);
    expect(segmentsIn(THREAD_LIST)).toEqual([
      "Release Bot's memory · 1 updated",
    ]);
  });

  it("draws no line for a memory the host could not read", async () => {
    mocks.reading = { kind: "failed", retry: vi.fn() };
    render(<MountedKnowingChannel />);

    await within(list(CHANNEL_LIST)).findAllByTestId("stub-row");
    expect(screen.queryByTestId("bot-memory-line")).toBeNull();
  });

  it("draws no line for a memory from a host that records no changes", async () => {
    holdReady([]);
    render(<MountedKnowingChannel />);

    await within(list(CHANNEL_LIST)).findAllByTestId("stub-row");
    expect(screen.queryByTestId("bot-memory-line")).toBeNull();
  });
});

describe("opening a memory line", () => {
  it("opens What Release Bot knows from a channel line, marking the entry the line names and leaving no thread to go back to", async () => {
    holdReady([CHANNEL_CHANGE]);
    render(<MountedKnowingChannel />);

    await userEvent
      .setup()
      .click(
        await within(list(CHANNEL_LIST)).findByTestId(
          "bot-memory-line-segment",
        ),
      );

    const pane = await screen.findByTestId("bot-memory-panel");
    expect(pane.getAttribute("aria-label")).toBe("What Release Bot knows");
    expect(focusOf(pane)).toEqual({
      [SHARED_ENTRY_ID]: "true",
      [OWN_ENTRY_ID]: "no",
      [UNCHANGED_ENTRY_ID]: "no",
    });
    expect(screen.queryByTestId("bot-memory-back")).toBeNull();
  });

  it("opens the memory from a thread's line with the thread to go back to", async () => {
    holdReady([THREAD_CHANGE]);
    openThread();
    render(<MountedKnowingChannel />);

    await userEvent
      .setup()
      .click(
        await within(list(THREAD_LIST)).findByTestId("bot-memory-line-segment"),
      );

    const pane = await screen.findByTestId("bot-memory-panel");
    expect(focusOf(pane)[OWN_ENTRY_ID]).toBe("true");
    expect(within(pane).getByTestId("bot-memory-back")).toBeTruthy();
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toMatchObject({
      kind: "memory",
      back: { anchorMessageId: THREAD_OPEN.anchorMessageId },
    });
  });
});
