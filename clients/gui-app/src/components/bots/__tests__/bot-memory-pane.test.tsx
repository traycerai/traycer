/**
 * What the bot knows (Tracy Bots T87), through the REAL `BotChannelView`,
 * profile card, `BotMemoryPanel` and `useBotMemory`: the card's row counts
 * the entries and opens them in the rail's one slot (the real open-thread
 * store, opened the way the tab opens it), and the pane lists what the
 * `bot.memory.subscribe` stream carries, live. The stream transport is a
 * scripted client; the channel's neighbouring reads are replaced as the
 * turn rail's suite replaces them.
 */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotMemory,
  BotMemoryEntry,
} from "@traycer/protocol/host/bot/schemas";
import { conversationRequestMessageId } from "@traycer/protocol/persistence/epic/messages";
import {
  BOT_ID,
  CHANNEL_ID,
  ENVIRONMENT_ID,
  OTHER_BOT_ID,
  POST_FIRST_LINE,
  REPLY_ID,
  THREAD_OPEN,
  THREAD_SESSION_ID,
  TRUNK_ID,
  botReply,
  buildScene,
  hostClientLocating,
  memberPost,
  scriptedSession,
  turnsAskedFor,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { MountedKnowingChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import { __resetBotMemorySessionsForTesting } from "@/hooks/bots/use-bot-memory";
import type { HostRpcRegistry } from "@/lib/host";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/** A stream client whose answer to "is `bot.memory.subscribe` served?" the test sets. */
class MemoryStreamClient extends MockWsStreamClient<StreamFrameEnvelope> {
  support: StreamMethodSupport = "supported";

  override getMethodSupport(): StreamMethodSupport {
    return this.support;
  }

  override subscribeMethodSupport(): () => void {
    return () => undefined;
  }
}

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  stream: null as MockWsStreamClient<StreamFrameEnvelope> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
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
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => mocks.stream,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => true,
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
vi.mock("@/components/chat/chat-messages", async () => {
  const { ChatExpansionTestProviders: Providers } =
    await import("@/components/chat/__tests__/chat-expansion-test-providers");
  const { ChatMessage } = await import("@/components/chat/chat-message");
  const noBackgroundToolBlockIds: ReadonlySet<string> = new Set();
  return {
    ChatMessages: (props: {
      messages: ReadonlyArray<ChatMessageModel>;
      instanceId: string;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div
          data-testid="chat-messages-stub"
          data-instance-id={props.instanceId}
        >
          {props.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              actions={null}
              backgroundToolBlockIds={noBackgroundToolBlockIds}
              nextStepActions={null}
            />
          ))}
        </div>
      </Providers>
    ),
  };
});

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

/** The member's post a memory was learned from, in the channel. */
const MEMORY_REQUEST = "req-memory";
const MEMORY_POST_LINE = "Remember: the nightly gates releases";

function entry(input: {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly botId: string;
  readonly chatId: string;
  readonly requestId: string | null;
  readonly at: number;
  readonly confirmedAt: number;
}): BotMemoryEntry {
  return {
    id: input.id,
    text: input.text,
    tags: [...input.tags],
    writtenBy: {
      botId: input.botId,
      chatId: input.chatId,
      requestId: input.requestId,
    },
    at: input.at,
    confirmedAt: input.confirmedAt,
  };
}

const NEVER_CONFIRMED = entry({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  text: "The Codex CLI bump is held",
  tags: [BOT_ID],
  botId: BOT_ID,
  chatId: TRUNK_ID,
  requestId: null,
  at: NOW - 3 * DAY,
  confirmedAt: NOW - 3 * DAY,
});
const FROM_POST = entry({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  text: "The nightly is the release gate",
  tags: [BOT_ID],
  botId: BOT_ID,
  chatId: TRUNK_ID,
  requestId: MEMORY_REQUEST,
  at: NOW - 2 * DAY,
  confirmedAt: NOW - HOUR,
});
const FROM_THREAD = entry({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  text: "CI flakes on the host shard",
  tags: [BOT_ID],
  botId: BOT_ID,
  chatId: THREAD_SESSION_ID,
  requestId: null,
  at: NOW - DAY,
  confirmedAt: NOW - DAY,
});
const SHARED = entry({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  text: "main receives development only",
  tags: ["all"],
  botId: OTHER_BOT_ID,
  chatId: "other-chat",
  requestId: null,
  at: NOW - 5 * DAY,
  confirmedAt: NOW - 5 * DAY,
});

function memoryOf(entries: readonly BotMemoryEntry[]): BotMemory {
  return {
    entries: [...entries],
    own: { entries: 3, chars: 300, ceiling: 8_000 },
    shared: { entries: 1, chars: 30, ceiling: 8_000 },
  };
}

const MEMORY = memoryOf([NEVER_CONFIRMED, FROM_POST, FROM_THREAD, SHARED]);

function streamClient(): MemoryStreamClient {
  if (!(mocks.stream instanceof MemoryStreamClient)) {
    throw new Error("no stream client");
  }
  return mocks.stream;
}

function memorySession() {
  const session = streamClient().getSession("bot.memory.subscribe", {
    botId: BOT_ID,
    environmentId: ENVIRONMENT_ID,
  });
  if (session === undefined) throw new Error("bot.memory.subscribe not open");
  return session;
}

function sendMemory(memory: BotMemory | null): void {
  memorySession().emitFrame({
    kind: "snapshot",
    memory,
    hasBinaryPayload: false,
  });
}

beforeEach(() => {
  useBotOpenThreadStore.setState({ byBotId: {} });
  const scene = buildScene();
  const channel = scriptedSession(CHANNEL_ID, [
    memberPost({
      messageId: "post-1",
      requestId: "req-post",
      lines: [POST_FIRST_LINE],
      timestamp: 1_000,
      resolvedBy: REPLY_ID,
    }),
    botReply({ messageId: REPLY_ID, text: "CI is green.", timestamp: 2_000 }),
    memberPost({
      messageId: conversationRequestMessageId(MEMORY_REQUEST),
      requestId: MEMORY_REQUEST,
      lines: [MEMORY_POST_LINE],
      timestamp: 3_000,
      resolvedBy: null,
    }),
  ]);
  mocks.sessions = { ...scene.sessions, [CHANNEL_ID]: channel.handle };
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(
    (request) => turnsAskedFor(scene.knownTurns, request),
    [],
  );
  mocks.stream = new MemoryStreamClient();
});

afterEach(() => {
  cleanup();
  __resetBotMemorySessionsForTesting();
  mocks.sessions = {};
  mocks.client = null;
  mocks.stream = null;
});

/** Opens the bot's full card from its name on its reply in the channel. */
async function openCard(user: UserEvent): Promise<HTMLElement> {
  const list = document.querySelector(
    `[data-instance-id="bot-channel:${BOT_ID}"]`,
  );
  if (!(list instanceof HTMLElement)) throw new Error("no channel list");
  const [name] = await within(list).findAllByText("Release Bot");
  await user.click(name);
  return screen.findByTestId("bot-profile-card");
}

/** `text` as a pattern that matches it literally. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memoryPane(): HTMLElement {
  return screen.getByRole("region", { name: "What Release Bot knows" });
}

function rowsOf(section: HTMLElement): HTMLElement[] {
  return within(section).queryAllByTestId("bot-memory-entry");
}

function textsOf(section: HTMLElement): string[] {
  return rowsOf(section).map(
    (row) => row.querySelector("p")?.textContent ?? "",
  );
}

function metaOf(row: HTMLElement | undefined): string {
  if (row === undefined) throw new Error("no such row");
  return within(row).getByTestId("bot-memory-entry-meta").textContent;
}

/** Opens the memory pane from the card, with `memory` on the stream. */
async function openPane(
  user: UserEvent,
  memory: BotMemory,
): Promise<HTMLElement> {
  const card = await openCard(user);
  sendMemory(memory);
  await user.click(await within(card).findByTestId("bot-profile-memory"));
  return memoryPane();
}

describe("the bot's profile card", () => {
  it("counts what the bot knows, its own and shared, and opens it in the rail, shutting the card", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);

    const card = await openCard(user);
    sendMemory(MEMORY);
    const row = await within(card).findByTestId("bot-profile-memory");
    expect(row.textContent).toBe("4 memories ›");

    await user.click(row);

    expect(screen.queryByTestId("bot-profile-card")).toBeNull();
    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "memory",
      back: null,
    });
    expect(memoryPane()).toBeTruthy();
  });

  it("draws no memory row on a host that does not serve it", async () => {
    streamClient().support = "unsupported";
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);

    const card = await openCard(user);

    expect(within(card).queryByTestId("bot-profile-memory")).toBeNull();
  });
});

describe("what the bot knows, in the rail", () => {
  it("lists the bot's own entries newest-confirmed first, with when and where each was written and when it was confirmed", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    const own = within(pane).getByTestId("bot-memory-own");
    expect(textsOf(own)).toEqual([
      FROM_POST.text,
      FROM_THREAD.text,
      NEVER_CONFIRMED.text,
    ]);
    const [fromPost, fromThread, neverConfirmed] = rowsOf(own);
    expect(metaOf(fromPost)).toMatch(
      new RegExp(`^Confirmed .+ · written .+ from "${MEMORY_POST_LINE}"$`),
    );
    expect(metaOf(fromThread)).toMatch(
      new RegExp(
        `^Written .+ in thread "${escaped(POST_FIRST_LINE)}" · never confirmed since$`,
      ),
    );
    expect(metaOf(neverConfirmed)).toMatch(
      /^Written .+ in the channel · never confirmed since$/,
    );
    expect(
      within(pane).getByText(/reads them before every reply/).textContent,
    ).toBe(
      "Release Bot wrote these and reads them before every reply. To change one, tell Release Bot in the channel.",
    );
  });

  it("lists the shared entries below, each with the bot that wrote it, and a shared entry the bot also keeps only as its own", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const alsoOwn = entry({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      text: "The repository uses bun",
      tags: ["all", BOT_ID],
      botId: BOT_ID,
      chatId: TRUNK_ID,
      requestId: null,
      at: NOW - 4 * DAY,
      confirmedAt: NOW - 4 * DAY,
    });
    const pane = await openPane(user, memoryOf([...MEMORY.entries, alsoOwn]));

    expect(textsOf(within(pane).getByTestId("bot-memory-own"))).toContain(
      alsoOwn.text,
    );
    const shared = within(pane).getByTestId("bot-memory-shared");
    expect(within(shared).getByRole("heading").textContent).toBe(
      "Shared with every bot1 · tidied by the main bot",
    );
    expect(textsOf(shared)).toEqual([SHARED.text]);
    expect(metaOf(rowsOf(shared)[0])).toMatch(
      /^Written .+ by Audit Bot · never confirmed since$/,
    );
  });

  it("meters the bot's own memory against its ceiling, saying what happens when it fills", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    expect(within(pane).getByRole("meter").getAttribute("aria-valuenow")).toBe(
      "4",
    );
    expect(within(pane).getByTestId("bot-memory-meter-line").textContent).toBe(
      "Release Bot's own memories: 3, nearly empty. When it fills, Release Bot is asked to tidy them, removing the ones that no longer hold; nothing is dropped on its own.",
    );

    sendMemory({
      ...MEMORY,
      own: { entries: 3, chars: 3_600, ceiling: 8_000 },
    });
    await waitFor(() =>
      expect(
        within(pane).getByRole("meter").getAttribute("aria-valuenow"),
      ).toBe("45"),
    );
    expect(
      within(pane).getByTestId("bot-memory-meter-line").textContent,
    ).toMatch(/^Release Bot's own memories: 3, about half full\. /);
  });

  it("marks an entry written while it is open as new, and claims nothing of the entry it may have replaced", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    const replacement = entry({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
      text: "The Codex CLI bump is no longer held",
      tags: [BOT_ID],
      botId: BOT_ID,
      chatId: TRUNK_ID,
      requestId: MEMORY_REQUEST,
      at: NOW,
      confirmedAt: NOW,
    });
    // The bot removes the old entry, then writes the new one.
    sendMemory(memoryOf([FROM_POST, FROM_THREAD, SHARED]));
    sendMemory(memoryOf([FROM_POST, FROM_THREAD, SHARED, replacement]));

    const own = within(pane).getByTestId("bot-memory-own");
    await waitFor(() => expect(textsOf(own)[0]).toBe(replacement.text));
    const [fresh, ...rest] = rowsOf(own);
    expect(fresh.getAttribute("data-new")).toBe("true");
    expect(metaOf(fresh)).toMatch(
      new RegExp(`^New · Written .+ from "${MEMORY_POST_LINE}"$`),
    );
    expect(rest.map((row) => row.getAttribute("data-new"))).toEqual([
      null,
      null,
    ]);
  });

  it("finds the entries whose text holds what is typed", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    await user.type(within(pane).getByTestId("bot-memory-find"), "NIGHTLY");

    expect(textsOf(within(pane).getByTestId("bot-memory-own"))).toEqual([
      FROM_POST.text,
    ]);
    expect(within(pane).queryByTestId("bot-memory-shared")).toBeNull();
  });

  it("offers no way to edit, remove or add an entry", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    expect(
      within(pane)
        .getAllByRole("button")
        .map((button) => button.getAttribute("data-testid")),
    ).toEqual([
      "bot-memory-close",
      "bot-memory-where",
      "bot-memory-where",
      "bot-memory-where",
    ]);
    expect(
      within(pane)
        .getAllByRole("searchbox")
        .map((box) => box.getAttribute("data-testid")),
    ).toEqual(["bot-memory-find"]);
    expect(within(pane).queryAllByRole("textbox")).toEqual([]);
  });

  it("says when it could not load, and asks again on retry", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    sendMemory(null);
    const failure = await within(pane).findByTestId("bot-memory-error");
    expect(failure.textContent).toContain(
      "Couldn't load what Release Bot knows.",
    );
    const opened = streamClient().subscribeCallCount;

    await user.click(within(failure).getByRole("button", { name: "Retry" }));

    expect(streamClient().subscribeCallCount).toBe(opened + 1);
  });
});

describe("the memory in the rail's one slot", () => {
  it("takes a thread's place, names it in the header, and brings it back", async () => {
    useBotOpenThreadStore
      .getState()
      .setRail(BOT_ID, { kind: "thread", ...THREAD_OPEN });
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();

    const pane = await openPane(user, MEMORY);

    expect(screen.queryByTestId("bot-thread-pane")).toBeNull();
    expect(within(pane).getByTestId("bot-memory-crumb").textContent).toBe(
      `Thread · ${POST_FIRST_LINE}`,
    );
    await user.click(within(pane).getByTestId("bot-memory-back"));

    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      ...THREAD_OPEN,
    });
    expect(screen.queryByTestId("bot-memory-pane")).toBeNull();
  });

  it("opens the thread an entry was learned in, in its place", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    await user.click(
      within(pane).getByRole("button", {
        name: `in thread "${POST_FIRST_LINE}"`,
      }),
    );

    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "thread",
      anchorMessageId: THREAD_OPEN.anchorMessageId,
      announcement: false,
      answer: false,
      sent: null,
    });
    expect(screen.queryByTestId("bot-memory-pane")).toBeNull();
    expect(screen.getByTestId("bot-thread-pane")).toBeTruthy();
  });

  it("shows the channel on the post an entry was learned from, leaving the rail", async () => {
    const user = userEvent.setup();
    render(<MountedKnowingChannel />);
    const pane = await openPane(user, MEMORY);

    await user.click(
      within(pane).getByRole("button", { name: `from "${MEMORY_POST_LINE}"` }),
    );

    expect(useBotOpenThreadStore.getState().byBotId[BOT_ID]).toBeUndefined();
    expect(screen.queryByTestId("bot-memory-pane")).toBeNull();
  });
});
