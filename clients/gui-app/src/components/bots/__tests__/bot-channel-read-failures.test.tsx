/**
 * What a bot's channel and its thread say when a read fails: the REAL
 * `BotChannelView`, its thread panel and message boxes over the real
 * `bot.conversation.list`, `bot.thread.list` and read-cursor reads, which a
 * fake host answers from a script. A failure that leaves rows already loaded
 * keeps them under a line saying why they may be out of date; one that leaves
 * none, or that the person must act on, draws in their place. The send boxes
 * wait while a read says a send would not arrive, and no read cursor moves
 * behind the channel's failure.
 */
import {
  doorbellHostDirectoryEntryMock,
  doorbellStreamAuthRevalidatorMock,
  doorbellStreamClientForMock,
  resetDoorbellHosts,
} from "@/providers/__tests__/cloud-recovery-doorbell-test-support";
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  CHANNEL_ID,
  THREAD_ID,
  THREAD_OPEN,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  CHANNEL_LIST,
  TAB_HOST_ID,
  appClientWithoutRetries,
  freshScript,
  hostClientAnswering,
  type HostScript,
} from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import {
  noticeText,
  flushObservers,
  refetchRead,
  settleCursorAdvances,
  renderRealChannel,
} from "@/components/bots/__tests__/bot-channel-cloud-harness";
import {
  boxWithin,
  findBoxInput,
  textOf,
  typeInto,
} from "@/components/bots/__tests__/bot-box-test-support";
import {
  hostFailure,
  transportFailure,
} from "@/lib/host/test-support/cloud-failure-reads";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";

const mocks = vi.hoisted(() => ({
  client: null as HostRequester<HostRpcRegistry> | null,
  /** The name the directory has for the host; the unnamed host reads "the host". */
  hostLabel: "the host",
}));

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);
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
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: mocks.hostLabel,
    unavailability: null,
    basis: "directory",
    hostKind: "remote",
  }),
}));
// The read cursors are the person's, so their read waits for a viewer.
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-viewer",
}));
// Signing in is the auth layer's; the sign-in button only needs a mutation to press.
vi.mock("@/hooks/auth/use-auth-sign-in-mutation", () => ({
  useAuthSignInMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
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

const CHANNEL_READ = "bot.conversation.list";
const THREAD_READ = "bot.thread.list";
const CHANNEL_BOX = "Message Release Bot";
const THREAD_BOX = "Reply in the thread";
const NAMED_HOST = "Ada's Mac";

/** The three failures a read keeps its rows through, by what the person is told. */
const KEPT_ROWS_FAILURES = [
  {
    failure: "server",
    error: (method: string): Error => hostFailure("RPC_ERROR", method),
    waits: false,
  },
  {
    failure: "reconnecting",
    error: (method: string): Error =>
      hostFailure("E_CLOUD_UNREACHABLE", method),
    waits: true,
  },
  {
    failure: "host-not-answering",
    error: (method: string): Error => transportFailure(method),
    waits: true,
  },
] as const;

let script: HostScript;
let queryClient: QueryClient;

function mount(openThread: BotOpenThread | null): void {
  queryClient = appClientWithoutRetries();
  mocks.client = hostClientAnswering(script, queryClient);
  renderRealChannel({ queryClient, openThread, tiles: null, extra: null });
}

function channelSend(): HTMLElement {
  return screen.getByTestId("bot-channel-composer-send");
}

beforeEach(() => {
  script = freshScript();
  mocks.hostLabel = "the host";
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  cleanup();
  queryClient.clear();
  resetHostConnectionRegistryForTest();
  resetDoorbellHosts();
  mocks.client = null;
  vi.restoreAllMocks();
});

describe("<BotChannelView /> when the channel's read fails after it loaded", () => {
  it.each([
    {
      ...KEPT_ROWS_FAILURES[0],
      line: /^Couldn't check for new messages\. Showing what loaded at .+\.Retry$/,
    },
    {
      ...KEPT_ROWS_FAILURES[1],
      line: /^Reconnecting… Showing what loaded at .+\. You can send once reconnected\.Retry$/,
    },
    {
      ...KEPT_ROWS_FAILURES[2],
      line: /^Ada's Mac isn't responding\. Showing what loaded at .+\. You can send once it answers\.Retry$/,
    },
  ])(
    "keeps the channel under a line for a $failure failure, with the draft kept and Send waiting only where it would not arrive",
    async ({ failure, error, waits, line }) => {
      mocks.hostLabel = NAMED_HOST;
      mount(null);
      const box = await findBoxInput(CHANNEL_BOX);
      typeInto(box, "Ship it");
      script.conversationList = () => Promise.reject(error(CHANNEL_READ));

      await refetchRead(queryClient, CHANNEL_READ);

      const stale = screen.getByTestId("bot-channel-stale");
      expect(stale.getAttribute("data-failure")).toBe(failure);
      expect(noticeText(stale)).toMatch(line);
      expect(screen.getByTestId("bot-channel")).toBeDefined();
      expect(screen.queryByTestId("bot-channel-error")).toBeNull();
      expect(textOf(box)).toBe("Ship it");
      expect(channelSend().hasAttribute("disabled")).toBe(waits);
    },
  );

  it("says the host is 'The host' when the directory has no name for it", async () => {
    mount(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(transportFailure(CHANNEL_READ));

    await refetchRead(queryClient, CHANNEL_READ);

    expect(screen.getByTestId("bot-channel-stale").textContent).toMatch(
      /^The host isn't responding\. /,
    );
  });

  it("disables Retry while its re-ask is in flight, and lets the channel load without the line once it answers", async () => {
    mount(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(hostFailure("RPC_ERROR", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    const answer = Promise.withResolvers<void>();
    script.conversationList = () => answer.promise.then(() => CHANNEL_LIST);

    fireEvent.click(
      within(screen.getByTestId("bot-channel-stale")).getByRole("button", {
        name: "Retry",
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByTestId("bot-channel-stale"))
          .getByRole("button", { name: "Retry" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    await act(async () => {
      answer.resolve();
      await queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, CHANNEL_READ),
      });
    });
    await waitFor(() =>
      expect(screen.queryByTestId("bot-channel-stale")).toBeNull(),
    );
  });
});

describe("<BotChannelView /> when the channel's read fails with nothing loaded", () => {
  it.each([
    {
      ...KEPT_ROWS_FAILURES[0],
      message: "Couldn't load this channel.",
    },
    {
      ...KEPT_ROWS_FAILURES[1],
      message: "Reconnecting…",
    },
    {
      ...KEPT_ROWS_FAILURES[2],
      message: "The host isn't responding.",
    },
  ])(
    "says a $failure failure in place of the channel, with Retry",
    async ({ failure, error, message }) => {
      script.conversationList = () => Promise.reject(error(CHANNEL_READ));
      mount(null);

      const state = await screen.findByTestId("bot-channel-error");

      expect(state.getAttribute("data-failure")).toBe(failure);
      expect(noticeText(state)).toBe(`${message}Retry`);
      expect(screen.queryByTestId("bot-channel")).toBeNull();
    },
  );
});

describe("<BotChannelView /> when the channel's read is refused after it loaded", () => {
  it("says the person is signed out, with a way to sign in, and draws no rows", async () => {
    mount(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(hostFailure("UNAUTHORIZED", CHANNEL_READ));

    await refetchRead(queryClient, CHANNEL_READ);

    const state = screen.getByTestId("bot-channel-error");
    expect(state.getAttribute("data-failure")).toBe("signed-out");
    expect(state.textContent).toBe(
      "You're signed out. Sign in to see this channel.Sign in",
    );
    expect(within(state).getByTestId("signin-button")).toBeDefined();
    expect(screen.queryByTestId("bot-channel")).toBeNull();
  });

  it("says the person has no access, and asks again on Check again", async () => {
    mount(null);
    await screen.findByTestId("bot-channel");
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    const state = screen.getByTestId("bot-channel-error");
    expect(state.getAttribute("data-failure")).toBe("access-refused");
    expect(state.textContent).toBe(
      "You don't have access to this channel anymore.Check again",
    );
    expect(screen.queryByTestId("bot-channel")).toBeNull();
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByTestId("bot-channel")).toBeDefined();
    expect(screen.queryByTestId("bot-channel-error")).toBeNull();
  });

  it.each(["E_HOST_UNSUPPORTED", "E_CLOUD_CREDENTIAL_WITHDRAWN"] as const)(
    "says the host cannot open the channel after %s, with nothing to press",
    async (code) => {
      mount(null);
      await screen.findByTestId("bot-channel");
      script.conversationList = () =>
        Promise.reject(hostFailure(code, CHANNEL_READ));

      await refetchRead(queryClient, CHANNEL_READ);

      const state = screen.getByTestId("bot-channel-error");
      expect(state.getAttribute("data-failure")).toBe("cannot-serve");
      expect(state.textContent).toBe("The host can't open this channel.");
      expect(within(state).queryByRole("button")).toBeNull();
      expect(screen.queryByTestId("bot-channel")).toBeNull();
    },
  );
});

describe("<BotChannelView /> when the thread list's read fails after it loaded", () => {
  async function mountWithThreadBox(): Promise<{
    readonly panel: HTMLElement;
    readonly box: HTMLElement;
  }> {
    mocks.hostLabel = NAMED_HOST;
    mount(THREAD_OPEN);
    const panel = await screen.findByTestId("bot-thread-panel");
    await within(panel).findByRole("group", { name: THREAD_BOX });
    const box = boxWithin(panel, THREAD_BOX);
    typeInto(box, "Not yet");
    return { panel, box };
  }

  it.each([
    {
      ...KEPT_ROWS_FAILURES[0],
      line: /^Couldn't check for new replies\. Showing what loaded at .+\.Retry$/,
    },
    {
      ...KEPT_ROWS_FAILURES[1],
      line: /^Reconnecting… Showing what loaded at .+\. You can send once reconnected\.Retry$/,
    },
    {
      ...KEPT_ROWS_FAILURES[2],
      line: /^Ada's Mac isn't responding\. Showing what loaded at .+\. You can send once it answers\.Retry$/,
    },
  ])(
    "keeps the thread under a line for a $failure failure, with the draft kept and Send waiting only where it would not arrive",
    async ({ failure, error, waits, line }) => {
      const { panel, box } = await mountWithThreadBox();
      script.threadList = () => Promise.reject(error(THREAD_READ));

      await refetchRead(queryClient, THREAD_READ);

      const stale = within(panel).getByTestId("bot-thread-stale");
      expect(stale.getAttribute("data-failure")).toBe(failure);
      expect(noticeText(stale)).toMatch(line);
      expect(within(panel).queryByTestId("bot-thread-error")).toBeNull();
      expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
      expect(textOf(box)).toBe("Not yet");
      expect(
        within(panel)
          .getByTestId("bot-thread-composer-send")
          .hasAttribute("disabled"),
      ).toBe(waits);
    },
  );

  it("holds the thread's Send while the channel's read says it would not arrive, and adds a thread line only for a cause the channel's does not say", async () => {
    const { panel } = await mountWithThreadBox();
    script.conversationList = () =>
      Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    const threadSend = (): HTMLElement =>
      within(panel).getByTestId("bot-thread-composer-send");
    expect(
      screen.getByTestId("bot-channel-stale").getAttribute("data-failure"),
    ).toBe("reconnecting");
    expect(threadSend().hasAttribute("disabled")).toBe(true);
    expect(within(panel).queryByTestId("bot-thread-stale")).toBeNull();

    script.threadList = () =>
      Promise.reject(hostFailure("E_CLOUD_UNREACHABLE", THREAD_READ));
    await refetchRead(queryClient, THREAD_READ);
    expect(within(panel).queryByTestId("bot-thread-stale")).toBeNull();

    script.threadList = () =>
      Promise.reject(hostFailure("RPC_ERROR", THREAD_READ));
    await refetchRead(queryClient, THREAD_READ);
    expect(
      within(panel)
        .getByTestId("bot-thread-stale")
        .getAttribute("data-failure"),
    ).toBe("server");
  });

  it("asks the thread list again with the channel line's Retry when both fail for one cause, so the thread has no line of its own once the channel recovers", async () => {
    const { panel } = await mountWithThreadBox();
    const answering = script.threadList;
    script.conversationList = () =>
      Promise.reject(hostFailure("RPC_ERROR", CHANNEL_READ));
    script.threadList = () =>
      Promise.reject(hostFailure("RPC_ERROR", THREAD_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    await refetchRead(queryClient, THREAD_READ);
    expect(
      screen.getByTestId("bot-channel-stale").getAttribute("data-failure"),
    ).toBe("server");
    expect(within(panel).queryByTestId("bot-thread-stale")).toBeNull();
    const channelAsks = script.conversationListCalls;
    const threadAsks = script.threadListCalls;
    // The host's thread list answers again; only the channel line's Retry asks it.
    script.threadList = answering;

    fireEvent.click(
      within(screen.getByTestId("bot-channel-stale")).getByRole("button", {
        name: "Retry",
      }),
    );

    await waitFor(() => {
      expect(script.conversationListCalls).toBe(channelAsks + 1);
      expect(script.threadListCalls).toBe(threadAsks + 1);
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await flushObservers();
    expect(screen.getByTestId("bot-channel-stale")).toBeDefined();

    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    await refetchRead(queryClient, CHANNEL_READ);

    expect(screen.queryByTestId("bot-channel-stale")).toBeNull();
    expect(within(panel).queryByTestId("bot-thread-stale")).toBeNull();
    expect(within(panel).queryByTestId("bot-thread-error")).toBeNull();
  });

  it("replaces the thread with the refusal when the list is refused as forbidden, and leaves the channel", async () => {
    const { panel } = await mountWithThreadBox();
    script.threadList = () =>
      Promise.reject(hostFailure("FORBIDDEN", THREAD_READ));

    await refetchRead(queryClient, THREAD_READ);

    const state = within(panel).getByTestId("bot-thread-error");
    expect(state.getAttribute("data-failure")).toBe("access-refused");
    expect(state.textContent).toBe(
      "You don't have access to this thread anymore.Check again",
    );
    expect(within(panel).queryByTestId("bot-thread-composer-send")).toBeNull();
    expect(screen.getByTestId("bot-channel")).toBeDefined();
  });
});

describe("<BotChannelView /> read cursors behind a channel that failed", () => {
  /** The cursor read has answered and its advance, if any, has been asked. */
  async function cursorsRead(): Promise<void> {
    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll({
            queryKey: hostQueryKeys.methodScope(
              TAB_HOST_ID,
              "bot.readCursor.read",
            ),
          })
          .some((query) => query.state.status === "success"),
      ).toBe(true),
    );
    await settleCursorAdvances(queryClient);
  }

  /** Mounts over a channel the host refuses; the cursors, read, say both conversations have unread rows. */
  async function mountRefusedChannel(
    openThread: BotOpenThread | null,
  ): Promise<void> {
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", CHANNEL_READ));
    mount(openThread);
    await screen.findByTestId("bot-channel-error");
    await cursorsRead();
  }

  async function recoverChannel(): Promise<void> {
    script.conversationList = () => Promise.resolve(CHANNEL_LIST);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByTestId("bot-channel");
  }

  it("does not advance the channel's cursor over a newer row while the channel's failure is drawn, and does once the channel is back", async () => {
    mount(null);
    await screen.findByTestId("bot-channel");
    await waitFor(() => expect(script.advances).toHaveLength(1));
    script.conversationList = () =>
      Promise.reject(hostFailure("FORBIDDEN", CHANNEL_READ));
    await refetchRead(queryClient, CHANNEL_READ);
    expect(screen.getByTestId("bot-channel-error")).toBeDefined();

    // A newer row arrives; the person is looking at the failure, not at it.
    script.readCursor = () => ({
      cursors: {},
      latest: { [CHANNEL_ID]: { messageId: "channel-newer", seq: 5 } },
    });
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, "bot.readCursor.read"),
      });
    });
    await settleCursorAdvances(queryClient);
    expect(script.advances).toHaveLength(1);

    await recoverChannel();

    await waitFor(() =>
      expect(script.advances.map((ask) => ask.seq)).toEqual([4, 5]),
    );
  });

  it("does not advance the open thread's cursor while the channel's failure is drawn", async () => {
    await mountRefusedChannel(THREAD_OPEN);
    expect(script.advances).toEqual([]);

    await recoverChannel();

    // Beside an open thread the channel is not the one on screen.
    await waitFor(() =>
      expect(script.advances.map((ask) => ask.conversationId)).toEqual([
        THREAD_ID,
      ]),
    );
  });
});
