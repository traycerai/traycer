/**
 * A bot's channel after the host's cloud reads failed: the REAL
 * `BotChannelView` over the real `bot.conversation.list` read, and the real
 * cloud-recovery doorbell watching the same cache. The host refuses the read
 * with `E_CLOUD_REQUEST_REFUSED`, the channel says it could not load, the
 * host's doorbell rings `recovered`, and the channel loads without Retry.
 */
import {
  doorbellHostDirectoryEntryMock,
  doorbellStreamAuthRevalidatorMock,
  doorbellStreamClientForMock,
  liveDoorbellsOf,
  resetDoorbellHosts,
  ringDoorbell,
} from "@/providers/__tests__/cloud-recovery-doorbell-test-support";
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import type { ReactElement, ReactNode } from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  BOT_ID,
  CHANNEL_ID,
  THREAD_OPEN,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  CHANNEL_FAILURE_COPY,
  CHANNEL_LIST,
  TAB_HOST_ID,
  appClientWithoutRetries,
  freshScript,
  hostClientAnswering,
  type HostScript,
} from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { createAppQueryClient } from "@/lib/query-client";
import {
  heldFailure,
  hostFailure,
} from "@/lib/host/test-support/cloud-failure-reads";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
// The doorbell dials the entry of the host whose read failed.
vi.mock(
  "@/hooks/host/use-host-directory-entry",
  () => doorbellHostDirectoryEntryMock,
);
vi.mock(
  "@/lib/host/stream-auth-revalidator",
  () => doorbellStreamAuthRevalidatorMock,
);
vi.mock(
  "@/hooks/host/use-host-stream-client-for",
  () => doorbellStreamClientForMock,
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => null,
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
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
  usePaneFocused: () => true,
  usePaneFocusProbe: () => () => true,
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
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/components/bots/bot-transcript-image-scope", () => ({
  BotTranscriptImageScope: (props: { children: ReactNode }) => props.children,
}));
vi.mock("@/components/bots/bot-chat-transcript", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/bots/bot-chat-transcript")
  >()),
  BotChatTranscript: () => null,
}));

let script: HostScript;
let queryClient: QueryClient;

const resolveMember: BotMemberResolver = () => null;

/** The channel under `queryClient`, with `extra` rendered beside it (a doorbell, say). */
function mountRealChannel(args: {
  readonly queryClient: QueryClient;
  readonly openThread: BotOpenThread | null;
  readonly extra: ReactElement | null;
}): void {
  mocks.client = hostClientAnswering(script, args.queryClient);
  render(
    <QueryClientProvider client={args.queryClient}>
      {args.extra}
      <BotTestRunnerHost>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              tiles={null}
              botId={BOT_ID}
              hostId={TAB_HOST_ID}
              boundHostId={TAB_HOST_ID}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              onOpenTurn={vi.fn()}
              onOpenSession={vi.fn()}
              landOn={null}
              openMemory={null}
              onOpenMemory={vi.fn()}
              environmentId="env-1"
              botNameOf={() => null}
              environmentBots={null}
              openExchange={null}
              exchangeRail={{ open: () => undefined, close: () => undefined }}
              resolveMember={resolveMember}
              tasks={[]}
              surfaceActions={null}
              openThread={args.openThread}
              onOpenThread={vi.fn()}
              setupHistory={null}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </BotTestRunnerHost>
    </QueryClientProvider>,
  );
}

function mountWithDoorbell(): void {
  queryClient = appClientWithoutRetries();
  mountRealChannel({
    queryClient,
    openThread: null,
    extra: <CloudRecoveryDoorbellMount />,
  });
}

/**
 * As `mountWithDoorbell`, over the app's own query client with its retry
 * policy (one retry of a failed host read), the retry delay set to zero.
 */
function mountWithDoorbellAndAppRetries(): void {
  queryClient = createAppQueryClient();
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retryDelay: 0 },
  });
  mountRealChannel({
    queryClient,
    openThread: null,
    extra: <CloudRecoveryDoorbellMount />,
  });
}

beforeEach(() => {
  script = freshScript();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetHostConnectionRegistryForTest();
  resetDoorbellHosts();
  mocks.client = null;
  vi.restoreAllMocks();
});

describe("<BotChannelView /> after the host's cloud read failed", () => {
  it("loads the channel by itself once the host rings recovered, without Retry", async () => {
    script.conversationList = () =>
      Promise.reject(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.conversation.list"),
      );
    mountWithDoorbell();
    const panel = await screen.findByTestId("bot-channel-error");
    expect(panel.textContent).toContain(CHANNEL_FAILURE_COPY);
    await waitFor(() =>
      expect(liveDoorbellsOf(TAB_HOST_ID).at(-1)).toBeDefined(),
    );
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);

    ringDoorbell(TAB_HOST_ID);

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
    expect(script.conversationListCalls).toBe(2);
  });

  it("opens no doorbell for a permanent failure and asks once", async () => {
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", "bot.conversation.list"));
    mountWithDoorbell();
    await screen.findByTestId("bot-channel-error");

    expect(liveDoorbellsOf(TAB_HOST_ID)).toHaveLength(0);
    expect(script.conversationListCalls).toBe(1);
  });
});

/** The channel with no doorbell, so only what the view itself does with a failed refetch shows. */
function mountPlain(openThread: BotOpenThread | null): void {
  queryClient = appClientWithoutRetries();
  mountRealChannel({ queryClient, openThread, extra: null });
}

/**
 * Asks the read again and waits until what the answer changed is on screen:
 * TanStack hands observers their result through its own scheduler, so a check
 * made as soon as the refetch settles would look at the frame before it.
 */
async function refetchRead(
  method: "bot.conversation.list" | "bot.thread.list",
): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, method),
    });
    await new Promise<void>((resolve) => notifyManager.schedule(resolve));
  });
}

describe("<BotChannelView /> keeps what it loaded when a refetch fails", () => {
  it("keeps the channel when the refetch is refused by the host's egress budget", async () => {
    mountPlain(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.conversation.list"),
      );

    await refetchRead("bot.conversation.list");

    expect(script.conversationListCalls).toBe(2);
    expect(screen.getByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
  });

  it("keeps the channel when the cloud gave no verdict on the refetch", async () => {
    mountPlain(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(
        hostFailure("E_CLOUD_UNREACHABLE", "bot.conversation.list"),
      );

    await refetchRead("bot.conversation.list");

    expect(script.conversationListCalls).toBe(2);
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
  });

  it("still says the channel could not load when the refetch fails permanently", async () => {
    mountPlain(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", "bot.conversation.list"));

    await refetchRead("bot.conversation.list");

    expect(
      (await screen.findByTestId("bot-channel-error")).textContent,
    ).toContain(CHANNEL_FAILURE_COPY);
  });

  it("keeps an open thread when the thread list refetch is refused", async () => {
    mountPlain(THREAD_OPEN);
    await screen.findByTestId("bot-channel");
    await waitFor(() => expect(script.threadListCalls).toBe(1));
    script.threadList = () =>
      Promise.reject(hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"));

    await refetchRead("bot.thread.list");

    expect(script.threadListCalls).toBe(2);
    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
  });

  it("still says the thread could not load when the thread list refetch fails permanently", async () => {
    mountPlain(THREAD_OPEN);
    await screen.findByTestId("bot-channel");
    await waitFor(() => expect(script.threadListCalls).toBe(1));
    script.threadList = () =>
      Promise.reject(hostFailure("FORBIDDEN", "bot.thread.list"));

    await refetchRead("bot.thread.list");

    expect(await screen.findByTestId("bot-thread-error")).toBeDefined();
  });
});

describe("<BotChannelView /> when Retry is pressed while the host still refuses the read", () => {
  /** What the channel panel says, as one string: its message and its Retry. */
  const PANEL_TEXT = `${CHANNEL_FAILURE_COPY}Retry`;

  it("shows the loading state while the press is answered, then the same panel, and loads by itself when the host rings", async () => {
    script.conversationList = () =>
      Promise.reject(
        hostFailure("E_CLOUD_UNREACHABLE", "bot.conversation.list"),
      );
    mountWithDoorbellAndAppRetries();
    const panel = await screen.findByTestId("bot-channel-error");
    expect(panel.textContent).toBe(PANEL_TEXT);
    await waitFor(() =>
      expect(liveDoorbellsOf(TAB_HOST_ID).at(-1)).toBeDefined(),
    );
    const asksBeforeRetry = script.conversationListCalls;

    // The press's own ask is held, so the screen between press and answer can
    // be looked at; its retry, and the refusal that follows, answer at once.
    const pressAnswer = heldFailure(
      hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.conversation.list"),
    );
    script.conversationList = () =>
      script.conversationListCalls === asksBeforeRetry + 1
        ? pressAnswer.answer().then(() => CHANNEL_LIST)
        : Promise.reject(
            hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.conversation.list"),
          );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The press shows work in progress, not a dead button.
    const loading = await screen.findByTestId("bot-channel-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();

    pressAnswer.release();

    // The host refused the press and its retry: the same panel, nothing added.
    const again = await screen.findByTestId("bot-channel-error");
    expect(again.textContent).toBe(PANEL_TEXT);
    expect(script.conversationListCalls).toBe(asksBeforeRetry + 2);
    expect(screen.queryByTestId("bot-channel-loading")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(false);

    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    ringDoorbell(TAB_HOST_ID);

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
    expect(screen.queryByTestId("bot-channel-loading")).toBeNull();
  });
});

describe("<BotChannelView /> when the host rings while a read's attempt is still in flight", () => {
  /** The channel read fails (twice, with the app's one retry) and the doorbell is open. */
  async function strandedChannel(): Promise<number> {
    script.conversationList = () =>
      Promise.reject(
        hostFailure("E_CLOUD_UNREACHABLE", "bot.conversation.list"),
      );
    mountWithDoorbellAndAppRetries();
    await screen.findByTestId("bot-channel-error");
    await waitFor(() =>
      expect(liveDoorbellsOf(TAB_HOST_ID).at(-1)).toBeDefined(),
    );
    return script.conversationListCalls;
  }

  const refusal = (): Error =>
    hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.conversation.list");

  it("loads by itself when the ring arrives before the final refusal settles", async () => {
    const before = await strandedChannel();
    const finalRefusal = heldFailure(refusal());
    // The first ring's ask is refused at once; its app retry is the held one.
    script.conversationList = () =>
      script.conversationListCalls === before + 2
        ? finalRefusal.answer().then(() => CHANNEL_LIST)
        : Promise.reject(refusal());
    ringDoorbell(TAB_HOST_ID);
    await waitFor(() => expect(script.conversationListCalls).toBe(before + 2));

    // The floor passes while the final refusal is still in flight.
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    ringDoorbell(TAB_HOST_ID);
    act(() => {
      finalRefusal.release();
    });

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
    expect(script.conversationListCalls).toBe(before + 3);
  });

  it("loads when the ring arrives after the final refusal has settled", async () => {
    const before = await strandedChannel();
    script.conversationList = () => Promise.reject(refusal());
    ringDoorbell(TAB_HOST_ID);
    await waitFor(() => expect(script.conversationListCalls).toBe(before + 2));
    await waitFor(() =>
      expect(screen.queryByTestId("bot-channel-loading")).toBeNull(),
    );
    expect(screen.getByTestId("bot-channel-error")).toBeDefined();

    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    ringDoorbell(TAB_HOST_ID);

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(script.conversationListCalls).toBe(before + 3);
  });
});
