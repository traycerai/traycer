/**
 * The bot's memory across a change of account, through the REAL
 * `useBotMemory`, the memory pane, the profile card and the auth store, over
 * a query client from `createAppQueryClient` and a scripted stream host. The
 * request context swaps before the store, as `AuthService` does, and the
 * stream binding stays the previous account's until the test rebuilds it, as
 * the hook's own effect does. What a render drew is read from records taken in
 * the render and at each commit, never only from the DOM at the end.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { Profiler, useLayoutEffect, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotMemory,
  BotMemoryEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  BOT_ID,
  CHANNEL_ID,
  ENVIRONMENT_ID,
  HOST_ID,
  POST_FIRST_LINE,
  REPLY_ID,
  botReply,
  buildScene,
  hostClientLocating,
  memberPost,
  scriptedSession,
  turnsAskedFor,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  holdBinding,
  scriptedRequestContext,
} from "@/components/bots/__tests__/bot-memory-account-scripts";
import {
  MemoryAccountStreamClient,
  resetMemoryAccountScripts,
  signInAs,
} from "@/components/bots/__tests__/bot-memory-account-test-support";
import { KnowingChannel } from "@/components/bots/__tests__/bot-turn-channel-harness";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  __resetBotMemorySessionsForTesting,
  useBotMemory,
} from "@/hooks/bots/use-bot-memory";
import type { HostRpcRegistry } from "@/lib/host";
import { botQueryKeys } from "@/lib/query-keys/bot-query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  threads: [] as BotThreadSummary[],
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

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
vi.mock("@/hooks/host/use-host-stream-client-for", async () => {
  const { streamClientBindingModule } =
    await import("@/components/bots/__tests__/bot-memory-account-scripts");
  return streamClientBindingModule;
});
vi.mock("@/lib/host", async (importOriginal) => {
  const { scriptedRequestContext } =
    await import("@/components/bots/__tests__/bot-memory-account-scripts");
  return {
    ...(await importOriginal<typeof import("@/lib/host")>()),
    useHostClient: () => scriptedRequestContext,
  };
});
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async () => {
  const { MEMORY_TARGET } =
    await import("@/components/bots/__tests__/bot-memory-account-scripts");
  return { useHostDirectoryEntry: () => MEMORY_TARGET };
});
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
      scrollRequest: { messageId?: string; requestId: number } | null;
    }) => (
      <Providers tileInstanceId={props.instanceId}>
        <div
          data-testid="chat-messages-stub"
          data-instance-id={props.instanceId}
          data-scroll-row-id={props.scrollRequest?.messageId ?? ""}
          data-scroll-request-id={props.scrollRequest?.requestId ?? ""}
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

const NOW = Date.now();

function entry(id: string, text: string): BotMemoryEntry {
  return {
    id,
    text,
    tags: [BOT_ID],
    writtenBy: { botId: BOT_ID, chatId: "trunk-chat", requestId: null },
    at: NOW,
    confirmedAt: NOW,
  };
}

function memoryOf(entries: readonly BotMemoryEntry[]): BotMemory {
  return {
    entries: [...entries],
    own: { entries: entries.length, chars: 100, ceiling: 8_000 },
    shared: { entries: 0, chars: 0, ceiling: 8_000 },
  };
}

const ALPHA_TEXT = "Alpha: staging deploys on Tuesdays";
const ALPHA_AGAIN_TEXT = "Alpha again: the nightly is the gate";
const BRAVO_TEXT = "Bravo: releases wait for QA";
const ALPHA = memoryOf([
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB1", ALPHA_TEXT),
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB2", "Alpha: the host shard flakes"),
]);
const ALPHA_AGAIN = memoryOf([
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB3", ALPHA_AGAIN_TEXT),
]);
const BRAVO = memoryOf([
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB4", BRAVO_TEXT),
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB5", "Bravo: main takes development only"),
  entry("01ARZ3NDEKTSV4RRFFQ69G5FB6", "Bravo: no Friday deploys"),
]);

const MEMORY_SLOT = {
  hostId: HOST_ID,
  botId: BOT_ID,
  environmentId: ENVIRONMENT_ID,
};

/** What each render of a reader read, and the page's text at each commit. */
interface Records {
  readings: string[];
  commits: string[];
}

let records: Records;
let clientA: MemoryAccountStreamClient;
let clientB: MemoryAccountStreamClient;
let queryClient: QueryClient;

/** A second reader of the same slot, recording each reading in its render. */
function Probe(): ReactNode {
  const reading = useBotMemory({
    hostId: HOST_ID,
    botId: BOT_ID,
    environmentId: ENVIRONMENT_ID,
    enabled: true,
  });
  records.readings.push(
    reading.kind === "ready"
      ? `ready:${reading.memory.entries.map((e) => e.text).join("|")}`
      : reading.kind,
  );
  return null;
}

/** Moves the account in a layout effect: after the render, before passive effects. */
function SwitchInLayoutEffect(props: {
  readonly accounts: readonly string[];
}): ReactNode {
  const { accounts } = props;
  useLayoutEffect(() => {
    for (const account of accounts) signInAs(account);
  }, [accounts]);
  return null;
}

const B_THEN_BACK_TO_A: readonly string[] = ["account-b", "account-a"];
const TO_B: readonly string[] = ["account-b"];

function mount(extra: ReactNode): void {
  render(
    <QueryClientProvider client={queryClient}>
      <BotTestRunnerHost>
        <TooltipProvider>
          <Profiler
            id="memory"
            onRender={() => records.commits.push(document.body.textContent)}
          >
            {extra}
            <KnowingChannel />
            <Probe />
          </Profiler>
        </TooltipProvider>
      </BotTestRunnerHost>
    </QueryClientProvider>,
  );
}

/** The pane open, account A signed in and its client bound. */
function mountAsAccountA(extra: ReactNode): void {
  useBotOpenThreadStore
    .getState()
    .setRail(BOT_ID, { kind: "memory", back: null });
  signInAs("account-a");
  holdBinding(clientA, "account-a");
  mount(extra);
}

function emit(
  client: MemoryAccountStreamClient,
  index: number,
  memory: BotMemory,
): void {
  act(() => {
    client.memorySessions()[index].emitFrame({
      kind: "snapshot",
      memory,
      hasBinaryPayload: false,
    });
  });
}

/** The context swaps, then the store projects: one synchronous step in `AuthService`, so one act. */
function switchAccountTo(userId: string | null): void {
  act(() => signInAs(userId));
}

function pageHolds(text: string): boolean {
  return document.body.textContent.includes(text);
}

/** Where the records stood, so a case reads only what was drawn after it. */
function markRecords(): Records {
  return {
    readings: [...records.readings],
    commits: [...records.commits],
  };
}

function drawnSince(mark: Records, text: string): boolean {
  return (
    records.commits.slice(mark.commits.length).some((c) => c.includes(text)) ||
    records.readings.slice(mark.readings.length).some((r) => r.includes(text))
  );
}

function slotData(): BotMemory | undefined {
  return queryClient.getQueryData(botQueryKeys.memory(MEMORY_SLOT));
}

beforeEach(() => {
  records = { readings: [], commits: [] };
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
  ]);
  mocks.sessions = { ...scene.sessions, [CHANNEL_ID]: channel.handle };
  mocks.threads = scene.threads;
  mocks.client = hostClientLocating(
    (request) => turnsAskedFor(scene.knownTurns, request),
    [],
  );
  clientA = new MemoryAccountStreamClient();
  clientB = new MemoryAccountStreamClient();
  queryClient = createAppQueryClient();
});

afterEach(() => {
  cleanup();
  __resetBotMemorySessionsForTesting();
  resetMemoryAccountScripts();
  mocks.sessions = {};
  mocks.client = null;
});

describe("the bot's memory when the account changes", () => {
  it("draws nothing of the previous account in any render or commit, and reads loading until the new account's snapshot arrives", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const mark = markRecords();

    switchAccountTo("account-b");
    act(() => holdBinding(clientB, "account-b"));

    expect(records.readings.length).toBeGreaterThan(mark.readings.length);
    expect(records.commits.length).toBeGreaterThan(mark.commits.length);
    expect(drawnSince(mark, "Alpha")).toBe(false);
    expect(records.readings.at(-1)).toBe("loading");
  });

  it("then draws the new account's entries when its snapshot arrives", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    switchAccountTo("account-b");
    act(() => holdBinding(clientB, "account-b"));

    emit(clientB, 0, BRAVO);

    expect(await screen.findByText(BRAVO_TEXT)).toBeTruthy();
    expect(pageHolds("Alpha")).toBe(false);
  });

  it("drops a frame from the previous account's session delivered after the switch", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    switchAccountTo("account-b");
    act(() => holdBinding(clientB, "account-b"));
    const mark = markRecords();

    expect(clientA.memorySessions()[0].closed).toBe(true);
    emit(clientA, 0, ALPHA_AGAIN);

    expect(pageHolds(ALPHA_AGAIN_TEXT)).toBe(false);
    expect(drawnSince(mark, ALPHA_AGAIN_TEXT)).toBe(false);
    expect(slotData()).toBeUndefined();
  });

  it("gives a reader that joins after the switch nothing of the previous account to replay", async () => {
    const user = userEvent.setup();
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const mark = markRecords();
    switchAccountTo("account-b");
    act(() => holdBinding(clientB, "account-b"));

    const list = document.querySelector(
      `[data-instance-id="bot-channel:${BOT_ID}"]`,
    );
    if (!(list instanceof HTMLElement)) throw new Error("no channel list");
    const [name] = await within(list).findAllByText("Release Bot");
    await user.click(name);
    await screen.findByTestId("bot-profile-card");

    expect(drawnSince(mark, ALPHA_TEXT)).toBe(false);
    expect(drawnSince(mark, "2 memories")).toBe(false);
    emit(clientB, 0, BRAVO);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("bot-profile-card")).getByTestId(
          "bot-profile-memory",
        ).textContent,
      ).toBe("3 memories ›"),
    );
  });

  it("opens a fresh session for a reader that A, B, A in one batch leaves on the same client, and draws nothing of the first lifetime until it answers", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const opened = clientA.memorySessions().length;

    act(() => {
      signInAs("account-b");
      signInAs("account-a");
    });

    expect(clientA.memorySessions()).toHaveLength(opened + 1);
    expect(pageHolds(ALPHA_TEXT)).toBe(false);
    expect(records.readings.at(-1)).toBe("loading");
    emit(clientA, opened, ALPHA_AGAIN);
    expect(await screen.findByText(ALPHA_AGAIN_TEXT)).toBeTruthy();
    expect(pageHolds(ALPHA_TEXT)).toBe(false);
  });

  it("opens nothing on the previous account's held client and draws nothing from it", async () => {
    const user = userEvent.setup();
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const opened = clientA.memorySessions().length;

    switchAccountTo("account-b");
    const list = document.querySelector(
      `[data-instance-id="bot-channel:${BOT_ID}"]`,
    );
    if (!(list instanceof HTMLElement)) throw new Error("no channel list");
    const [name] = await within(list).findAllByText("Release Bot");
    await user.click(name);
    await screen.findByTestId("bot-profile-card");
    emit(clientA, 0, ALPHA_AGAIN);

    expect(clientA.memorySessions()).toHaveLength(opened);
    expect(clientB.memorySessions()).toHaveLength(0);
    expect(pageHolds(ALPHA_TEXT)).toBe(false);
    expect(pageHolds(ALPHA_AGAIN_TEXT)).toBe(false);
    expect(slotData()).toBeUndefined();
  });

  it("keeps the session and its entries for the same user re-projected, with no loading reading", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const opened = clientA.memorySessions().length;
    const renderedBefore = records.readings.length;

    act(() => scriptedRequestContext.set("account-a"));
    act(() => {
      useAuthStore.setState({
        contextMetadata: { userId: "account-a", username: "renamed" },
      });
    });

    expect(clientA.memorySessions()).toHaveLength(opened);
    expect(pageHolds(ALPHA_TEXT)).toBe(true);
    expect(records.readings.slice(renderedBefore)).not.toContain("loading");
  });

  it("empties the entries and opens nothing when signed out", async () => {
    mountAsAccountA(null);
    emit(clientA, 0, ALPHA);
    await screen.findByText(ALPHA_TEXT);
    const opened = clientA.memorySessions().length;
    const mark = markRecords();

    switchAccountTo(null);
    act(() => holdBinding(null, null));

    expect(pageHolds(ALPHA_TEXT)).toBe(false);
    expect(drawnSince(mark, "Alpha")).toBe(false);
    expect(clientA.memorySessions()).toHaveLength(opened);
    expect(records.readings.at(-1)).toBe("loading");
  });

  it("drops the first frame of a session opened under a lifetime that moved before its effect ran", () => {
    clientA.frameOnNextAttach = ALPHA;

    mountAsAccountA(<SwitchInLayoutEffect accounts={TO_B} />);

    expect(clientA.memorySessions()).toHaveLength(1);
    expect(slotData()).toBeUndefined();
    expect(drawnSince({ readings: [], commits: [] }, "Alpha")).toBe(false);
  });

  it("opens a fresh session for a reader whose session was opened under a lifetime that moved, on the same client, and draws its answer", async () => {
    clientA.frameOnNextAttach = ALPHA;

    mountAsAccountA(<SwitchInLayoutEffect accounts={B_THEN_BACK_TO_A} />);

    expect(clientA.memorySessions()).toHaveLength(2);
    expect(drawnSince({ readings: [], commits: [] }, "Alpha")).toBe(false);
    emit(clientA, 1, ALPHA_AGAIN);
    expect(await screen.findByText(ALPHA_AGAIN_TEXT)).toBeTruthy();
  });
});
