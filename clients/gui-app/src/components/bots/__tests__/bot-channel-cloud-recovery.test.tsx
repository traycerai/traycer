/**
 * A bot's channel after the host's cloud reads failed: the REAL
 * `BotChannelView` over the real `bot.conversation.list` read, and the real
 * cloud-recovery doorbell watching the same cache. The host refuses the read
 * with `E_CLOUD_REQUEST_REFUSED`, the channel says it could not load, the
 * host's doorbell rings `recovered`, and the channel loads without Retry.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import type { ReactElement, ReactNode } from "react";
import { cleanup, act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import {
  BOT_ID,
  CHANNEL_FAILURE_COPY,
  CHANNEL_ID,
  CHANNEL_LIST,
  OPEN_LISTED_THREAD,
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
import { hostFailure } from "@/lib/host/test-support/cloud-failure-reads";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  streamClients: new Map<string, FakeStreamClient>(),
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
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null ? null : { ...mockRemoteHostEntry, hostId },
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", async () => {
  const { FakeStreamClient: Fake } =
    await import("@traycer-clients/shared/host-transport/__testing__/fake-stream-client");
  return {
    useHostStreamClientFor: (target: { readonly hostId: string } | null) => {
      if (target === null) return null;
      const existing = mocks.streamClients.get(target.hostId);
      if (existing !== undefined) return existing;
      const created = new Fake(true);
      mocks.streamClients.set(target.hostId, created);
      return created;
    },
  };
});
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
  mocks.client = hostClientAnswering(script, queryClient);
  mountRealChannel({
    queryClient,
    openThread: null,
    extra: <CloudRecoveryDoorbellMount />,
  });
}

/** The doorbell `TAB_HOST_ID`'s host holds open for the channel's failed read. */
function liveDoorbell() {
  return mocks.streamClients
    .get(TAB_HOST_ID)
    ?.sessions.filter((session) => !session.closed)
    .at(-1);
}

function ringTabHost(): void {
  const session = liveDoorbell();
  if (session === undefined) throw new Error("no doorbell open to the host");
  act(() => {
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
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
  mocks.streamClients.clear();
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
    await waitFor(() => expect(liveDoorbell()).toBeDefined());
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);

    ringTabHost();

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
    expect(script.conversationListCalls).toBe(2);
  });

  it("does not ask again for a permanent failure, whatever the host rings", async () => {
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", "bot.conversation.list"));
    mountWithDoorbell();
    await screen.findByTestId("bot-channel-error");

    expect(liveDoorbell()).toBeUndefined();
    expect(script.conversationListCalls).toBe(1);
    expect(screen.getByTestId("bot-channel-error")).toBeDefined();
  });
});

/** The channel with no doorbell, so only what the view itself does with a failed refetch shows. */
function mountPlain(
  openThread: Parameters<typeof mountRealChannel>[0]["openThread"],
): void {
  queryClient = appClientWithoutRetries();
  mocks.client = hostClientAnswering(script, queryClient);
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
    mountPlain(OPEN_LISTED_THREAD);
    await screen.findByTestId("bot-channel");
    await waitFor(() => expect(script.threadListCalls).toBe(1));
    script.threadList = () =>
      Promise.reject(hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"));

    await refetchRead("bot.thread.list");

    expect(script.threadListCalls).toBe(2);
    expect(screen.queryByTestId("bot-thread-error")).toBeNull();
  });

  it("still says the thread could not load when the thread list refetch fails permanently", async () => {
    mountPlain(OPEN_LISTED_THREAD);
    await screen.findByTestId("bot-channel");
    await waitFor(() => expect(script.threadListCalls).toBe(1));
    script.threadList = () =>
      Promise.reject(hostFailure("FORBIDDEN", "bot.thread.list"));

    await refetchRead("bot.thread.list");

    expect(await screen.findByTestId("bot-thread-error")).toBeDefined();
  });
});
