import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  retainBotNotificationTranscript,
  settleBotNotificationLanding,
} from "@/lib/notifications/bot-notification-opening";
import { useEffect, type ReactNode } from "react";
import {
  useMergedNotificationRows,
  useMergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import { ALL_NOTIFICATION_CATEGORIES } from "@/lib/notifications/notification-category";
import {
  BOT,
  CHANNEL,
  botMember,
  rowShowing,
  showsCount,
} from "@/components/notifications/__tests__/notification-bot-members-test-support";
import {
  bindingFor,
  loadCloudFeed,
  loadHostFeed,
  markedCloudReadIds,
  markedReadIds,
  renderPopover,
  signInAs,
  type StubHostBinding,
} from "@/components/notifications/__tests__/notification-popover-host-test-support";

/**
 * Marking a folded reply group read is marking every reply behind it read, as
 * the group stood when the reader acted: the host is asked for each backing
 * row, and nothing is written for a feed or account that has since gone.
 */

const hostRequestMock = vi.hoisted(() => vi.fn());

const hostBindingState = vi.hoisted(() => ({
  current: null as StubHostBinding | null,
}));

const feedMode = vi.hoisted(() => ({
  value: "local" as "local" | "cloud",
}));

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingState.current };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostIdRef.value,
}));

vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => activeHostIdRef.value,
  useNotificationResolveHost: () => ({
    hostId: activeHostIdRef.value,
    client: hostBindingState.current?.hostClient ?? null,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  };
});

vi.mock("@/lib/notifications/notification-feed-mode", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/lib/notifications/notification-feed-mode")
    >();
  return {
    ...actual,
    useNotificationFeedMode: () => feedMode.value,
    useNotificationFeedModeSettling: () => false,
  };
});

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

function markReadRequests(): ReadonlyArray<string> {
  return markedReadIds(hostRequestMock.mock.calls);
}

function markReadTickOf(text: string): HTMLElement {
  return within(rowShowing(text)).getByTestId("notification-mark-read");
}

/** Waits until the mark-read mutation has left its held state and finished. */
async function mutationSettled(client: QueryClient): Promise<void> {
  await waitFor(() => {
    const mutations = client.getMutationCache().getAll();
    expect(mutations.length).toBeGreaterThan(0);
    expect(
      mutations.every(
        (mutation) =>
          mutation.state.status === "success" ||
          mutation.state.status === "error",
      ),
    ).toBe(true);
  });
}

function unreadBackingIds(): ReadonlyArray<string> {
  return Object.values(useHostNotificationsStore.getState().byId)
    .filter((entry) => entry.readAt === null)
    .map((entry) => entry.id)
    .sort();
}

beforeEach(() => {
  feedMode.value = "local";
  useCloudNotificationsStore.getState().reset();
  signInAs("user-a");
  hostRequestMock.mockReset();
  hostRequestMock.mockImplementation((method: string) =>
    Promise.resolve(
      method === "host.notifications.markRead" ? { ok: true } : {},
    ),
  );
  window.localStorage.clear();
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useNotificationsPopoverStore.setState({
    open: false,
    unreadOnly: false,
    categories: ALL_NOTIFICATION_CATEGORIES,
  });
  activeHostIdRef.value = mockLocalHostEntry.hostId;
  hostBindingState.current = bindingFor(hostRequestMock);
});

afterEach(() => {
  onlineManager.setOnline(true);
  feedMode.value = "local";
  useCloudNotificationsStore.getState().reset();
  cleanup();
  useAuthStore.getState().setSignedOut();
  hostBindingState.current = null;
  __resetHostNotificationsStoreForTests();
});

describe("marking a folded group of reply notifications read", () => {
  it("asks the host to mark a single reply read when nothing folds with it", async () => {
    loadHostFeed([
      botMember("solo", 100, "only reply", { threadId: "thread-a" }),
    ]);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");

    fireEvent.click(markReadTickOf("only reply"));

    await waitFor(() => {
      expect(markReadRequests()).toEqual(["solo"]);
    });
  });

  it("asks the host to mark every reply behind the group read, not just the one it shows", async () => {
    loadHostFeed([
      botMember("m3", 300, "gamma newest", { threadId: "thread-a" }),
      botMember("m2", 200, "beta middle", { threadId: "thread-a" }),
      botMember("m1", 100, "alpha oldest", { threadId: "thread-a" }),
    ]);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");

    fireEvent.click(markReadTickOf("gamma newest"));

    await waitFor(() => {
      expect(markReadRequests()).toEqual(["m1", "m2", "m3"]);
    });
  });

  it("leaves another thread's replies unread", async () => {
    loadHostFeed([
      botMember("a2", 300, "thread a newest", { threadId: "thread-a" }),
      botMember("b1", 250, "thread b only", { threadId: "thread-b" }),
      botMember("a1", 100, "thread a oldest", { threadId: "thread-a" }),
    ]);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");

    fireEvent.click(markReadTickOf("thread a newest"));

    await waitFor(() => {
      expect(markReadRequests()).toEqual(["a1", "a2"]);
    });
  });

  it("marks both feed rows read when two carry one message, which counts once", async () => {
    loadHostFeed([
      botMember("d3", 300, "second message", {
        threadId: "thread-a",
        messageId: "message-2",
      }),
      botMember("d2", 200, "first message again", {
        threadId: "thread-a",
        messageId: "message-1",
      }),
      botMember("d1", 100, "first message", {
        threadId: "thread-a",
        messageId: "message-1",
      }),
    ]);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");
    expect(showsCount(rowShowing("second message"), 2)).toBe(true);

    fireEvent.click(markReadTickOf("second message"));

    await waitFor(() => {
      expect(markReadRequests()).toEqual(["d1", "d2", "d3"]);
    });
  });
});

describe("a mark-read held before it is dispatched", () => {
  const GROUP = [
    botMember("m3", 300, "gamma newest", { threadId: "thread-a" }),
    botMember("m2", 200, "beta middle", { threadId: "thread-a" }),
    botMember("m1", 100, "alpha oldest", { threadId: "thread-a" }),
  ];

  /** Clicks the group's tick while the client is offline: the mutation holds before its own dispatch. */
  async function holdGroupMarkRead(): Promise<QueryClient> {
    loadHostFeed(GROUP);
    const client = renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");
    act(() => {
      onlineManager.setOnline(false);
    });
    fireEvent.click(markReadTickOf("gamma newest"));
    await waitFor(() => {
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(true);
    });
    expect(markReadRequests()).toEqual([]);
    return client;
  }

  function release(): void {
    act(() => {
      onlineManager.setOnline(true);
    });
  }

  it("marks every captured reply read once released, when the feed has not changed", async () => {
    const client = await holdGroupMarkRead();

    release();
    await mutationSettled(client);

    expect(markReadRequests()).toEqual(["m1", "m2", "m3"]);
    expect(unreadBackingIds()).toEqual([]);
  });

  it("writes nothing for the previous account when another account's feed replaces it first", async () => {
    const client = await holdGroupMarkRead();

    act(() => {
      signInAs("user-b");
      __resetHostNotificationsStoreForTests();
      loadHostFeed([
        botMember("n1", 400, "second account reply", { threadId: "thread-a" }),
      ]);
    });
    release();
    await mutationSettled(client);

    expect(markReadRequests()).toEqual([]);
    expect(unreadBackingIds()).toEqual(["n1"]);
  });

  it("writes nothing for rows a replacement snapshot has since re-issued under the same ids", async () => {
    const client = await holdGroupMarkRead();

    act(() => {
      loadHostFeed(
        GROUP.map((entry) => ({ ...entry, updatedAt: entry.updatedAt + 1 })),
      );
    });
    release();
    await mutationSettled(client);

    expect(markReadRequests()).toEqual([]);
    expect(unreadBackingIds()).toEqual(["m1", "m2", "m3"]);
  });
});

describe("marking a folded group read in the cloud feed", () => {
  const GROUP = [
    botMember("c3", 300, "gamma newest", { threadId: "thread-a" }),
    botMember("c2", 200, "beta middle", { threadId: "thread-a" }),
    botMember("c1", 100, "alpha oldest", { threadId: "thread-a" }),
  ];

  function cloudMarkReadRequests(): ReadonlyArray<string> {
    return markedCloudReadIds(hostRequestMock.mock.calls);
  }

  beforeEach(() => {
    feedMode.value = "cloud";
  });

  it("asks the cloud to mark a single reply read when nothing folds with it", async () => {
    loadCloudFeed("user-a", [
      botMember("solo", 100, "only reply", { threadId: "thread-a" }),
    ]);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");

    fireEvent.click(markReadTickOf("only reply"));

    await waitFor(() => {
      expect(cloudMarkReadRequests()).toEqual(["solo"]);
    });
  });

  it("asks the cloud to mark every reply behind the group read", async () => {
    loadCloudFeed("user-a", GROUP);
    renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");

    fireEvent.click(markReadTickOf("gamma newest"));

    await waitFor(() => {
      expect(cloudMarkReadRequests()).toEqual(["c1", "c2", "c3"]);
    });
  });

  it("writes nothing for the previous account's group when another account's feed replaces it before the write is dispatched", async () => {
    loadCloudFeed("user-a", GROUP);
    const client = renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");
    act(() => {
      onlineManager.setOnline(false);
    });
    fireEvent.click(markReadTickOf("gamma newest"));
    await waitFor(() => {
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(true);
    });

    act(() => {
      signInAs("user-b");
      useCloudNotificationsStore.getState().reset();
      loadCloudFeed("user-b", [
        botMember("n1", 400, "second account reply", { threadId: "thread-a" }),
      ]);
    });
    act(() => {
      onlineManager.setOnline(true);
    });
    await mutationSettled(client);

    expect(cloudMarkReadRequests()).toEqual([]);
  });
});

describe("a mark-read whose response arrives after the feed it was for is gone", () => {
  const GROUP = [
    botMember("m3", 300, "gamma newest", { threadId: "thread-a" }),
    botMember("m2", 200, "beta middle", { threadId: "thread-a" }),
    botMember("m1", 100, "alpha oldest", { threadId: "thread-a" }),
  ];

  /** The host's answer to every mark-read, held until the case lets it through. */
  function holdMarkReadAnswers(): { readonly release: () => void } {
    let release: () => void = () => undefined;
    const answer = new Promise<unknown>((resolve) => {
      release = () => resolve({ ok: true });
    });
    hostRequestMock.mockImplementation((method: string) =>
      method === "host.notifications.markRead" ? answer : Promise.resolve({}),
    );
    return { release };
  }

  async function dispatchGroupMarkRead(): Promise<QueryClient> {
    loadHostFeed(GROUP);
    const client = renderPopover(() => undefined, null);
    await screen.findAllByTestId("notification-entry");
    fireEvent.click(markReadTickOf("gamma newest"));
    await waitFor(() => {
      expect(markReadRequests()).toEqual(["m1", "m2", "m3"]);
    });
    return client;
  }

  it("marks the rows read once the held answer arrives, when nothing replaced them", async () => {
    const held = holdMarkReadAnswers();
    const client = await dispatchGroupMarkRead();

    held.release();
    await mutationSettled(client);

    expect(unreadBackingIds()).toEqual([]);
  });

  it("does not mark the replacement rows read when the same ids come back in a new snapshot", async () => {
    const held = holdMarkReadAnswers();
    const client = await dispatchGroupMarkRead();

    act(() => {
      loadHostFeed(
        GROUP.map((entry) => ({ ...entry, updatedAt: entry.updatedAt + 1 })),
      );
    });
    held.release();
    await mutationSettled(client);

    expect(unreadBackingIds()).toEqual(["m1", "m2", "m3"]);
  });

  it("does not mark the next account's rows read when another account's feed replaced them", async () => {
    const held = holdMarkReadAnswers();
    const client = await dispatchGroupMarkRead();

    act(() => {
      signInAs("user-b");
      __resetHostNotificationsStoreForTests();
      loadHostFeed([
        botMember("m3", 500, "second account reply", { threadId: "thread-a" }),
      ]);
    });
    held.release();
    await mutationSettled(client);

    expect(unreadBackingIds()).toEqual(["m3"]);
  });
});

describe("opening a folded group of a bot's channel posts", () => {
  const MAIN = CHANNEL;
  const BOT_ID = BOT;
  const POSTS = [
    botMember("p3", 300, "third post", {
      event: "post",
      severity: "info",
      conversationId: MAIN,
      threadId: null,
      messageId: "post-3",
    }),
    botMember("p2", 200, "second post", {
      event: "post",
      severity: "info",
      conversationId: MAIN,
      threadId: null,
      messageId: "post-2",
    }),
    botMember("p1", 100, "first post", {
      event: "post",
      severity: "info",
      conversationId: MAIN,
      threadId: null,
      messageId: "post-1",
    }),
  ];

  /** The host: the bot's main channel is the one the posts are in. */
  function hostAnswersMain(): void {
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "bot.read")
        return Promise.resolve({
          bot: {
            botId: BOT_ID,
            title: "Tracy",
            appConversationChatId: MAIN,
            trunkChatId: "trunk-chat",
            archivedAt: null,
          },
        });
      return Promise.resolve(
        method === "host.notifications.markRead" ? { ok: true } : {},
      );
    });
  }

  /** The tokens of every landing staged for the bot: the route's own. */
  function watchStagedTokens(): { readonly tokens: string[] } {
    const tokens: string[] = [];
    const unsubscribe = useBotTabLandingStore.subscribe((state) => {
      const token = state.byBotId[BOT_ID]?.notificationToken;
      if (token !== undefined && !tokens.includes(token)) tokens.push(token);
    });
    onTestFinished(unsubscribe);
    return { tokens };
  }

  /** The channel's transcript, as it reports the message its landing named, by the owner's own contract. */
  function transcriptShows(token: string, outcome: "landed" | "exhausted") {
    const transcript = {
      botId: BOT_ID,
      hostId: mockLocalHostEntry.hostId,
      chatId: MAIN,
      kind: "channel" as const,
      messageId: "post-3",
      attempt: Symbol("channel transcript"),
    };
    retainBotNotificationTranscript(token, transcript);
    settleBotNotificationLanding(token, transcript, outcome);
  }

  function openGroup(): void {
    const first = within(rowShowing("third post")).getAllByRole("button")[0];
    fireEvent.click(first);
  }

  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
    useBotTabLandingStore.setState({ byBotId: {} });
    useSelectionAuthorityStore.setState({
      effectiveHostId: mockLocalHostEntry.hostId,
    });
    hostAnswersMain();
  });

  it("closes the centre and marks every post of the group read, only once the channel shows the newest", async () => {
    loadHostFeed(POSTS);
    const onNavigate = vi.fn();
    const staged = watchStagedTokens();
    renderPopover(onNavigate, null);
    await screen.findAllByTestId("notification-entry");

    openGroup();
    await waitFor(() => {
      expect(staged.tokens).toHaveLength(1);
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(markReadRequests()).toEqual([]);

    transcriptShows(staged.tokens[0], "landed");

    await waitFor(() => {
      expect(markReadRequests()).toEqual(["p1", "p2", "p3"]);
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("neither closes the centre nor reads anything when the channel could not show the newest", async () => {
    loadHostFeed(POSTS);
    const onNavigate = vi.fn();
    const staged = watchStagedTokens();
    renderPopover(onNavigate, null);
    await screen.findAllByTestId("notification-entry");

    openGroup();
    await waitFor(() => {
      expect(staged.tokens).toHaveLength(1);
    });
    transcriptShows(staged.tokens[0], "exhausted");

    expect(onNavigate).not.toHaveBeenCalled();
    expect(markReadRequests()).toEqual([]);
    expect(unreadBackingIds()).toEqual(["p1", "p2", "p3"]);
  });

  it.each([
    [
      "another account's feed replaced it",
      () => {
        signInAs("user-b");
        __resetHostNotificationsStoreForTests();
        loadHostFeed([
          botMember("q1", 500, "second account post", {
            event: "post",
            severity: "info",
            conversationId: MAIN,
            threadId: null,
            messageId: "post-3",
          }),
        ]);
      },
      ["q1"],
      false,
    ],
    [
      "a replacement snapshot re-issued the same ids",
      () => {
        loadHostFeed(
          POSTS.map((entry) => ({ ...entry, updatedAt: entry.updatedAt + 1 })),
        );
      },
      ["p1", "p2", "p3"],
      true,
    ],
  ])(
    "does not close the centre or read the new feed's rows when %s while the route was waiting for the host",
    async (_name, replaceFeed, stillUnread, landingStaged) => {
      loadHostFeed(POSTS);
      const onNavigate = vi.fn();
      const staged = watchStagedTokens();
      let release: () => void = () => undefined;
      const metadata = new Promise<unknown>((resolve) => {
        release = () =>
          resolve({
            bot: {
              botId: BOT_ID,
              title: "Tracy",
              appConversationChatId: MAIN,
              trunkChatId: "trunk-chat",
              archivedAt: null,
            },
          });
      });
      hostRequestMock.mockImplementation((method: string) =>
        method === "bot.read" ? metadata : Promise.resolve({}),
      );
      renderPopover(onNavigate, null);
      await screen.findAllByTestId("notification-entry");

      openGroup();
      await waitFor(() => {
        expect(
          hostRequestMock.mock.calls.some(([method]) => method === "bot.read"),
        ).toBe(true);
      });
      act(replaceFeed);
      release();
      await act(async () => {
        await metadata;
      });
      if (landingStaged) {
        await waitFor(() => {
          expect(staged.tokens).toHaveLength(1);
        });
        transcriptShows(staged.tokens[0], "landed");
      }

      expect(onNavigate).not.toHaveBeenCalled();
      expect(markReadRequests()).toEqual([]);
      expect(unreadBackingIds()).toEqual(stillUnread);
    },
  );
});

describe("a group read captured in an earlier render", () => {
  const GROUP = [
    botMember("m3", 300, "gamma newest", { threadId: "thread-a" }),
    botMember("m2", 200, "beta middle", { threadId: "thread-a" }),
    botMember("m1", 100, "alpha oldest", { threadId: "thread-a" }),
  ];

  /** Keeps the callback the real hook handed out the first time it saw the whole group. */
  function oldRenderCapture(): {
    readonly probe: ReactNode;
    readonly invoke: () => boolean;
  } {
    const held: Array<() => boolean> = [];
    function Probe(): ReactNode {
      const actions = useMergedNotificationsActions();
      const rows = useMergedNotificationRows();
      useEffect(() => {
        if (held.length === 0 && rows.length === GROUP.length)
          held.push(actions.captureGroupRead(rows));
      });
      return null;
    }
    return {
      probe: <Probe />,
      invoke: () => {
        if (held.length === 0) throw new Error("no render captured the group");
        return held[0]();
      },
    };
  }

  it.each([
    [
      "another account's feed",
      () => {
        signInAs("user-b");
        __resetHostNotificationsStoreForTests();
        loadHostFeed([
          botMember("n1", 400, "second account reply", {
            threadId: "thread-a",
          }),
        ]);
      },
    ],
    [
      "another host",
      () => {
        useSelectionAuthorityStore.setState({ effectiveHostId: "other-host" });
      },
    ],
  ])(
    "is refused and writes nothing once %s is the plane it would write to",
    async (_name, switchPlane) => {
      loadHostFeed(GROUP);
      const capture = oldRenderCapture();
      renderPopover(() => undefined, capture.probe);
      await screen.findAllByTestId("notification-entry");

      act(switchPlane);

      expect(capture.invoke()).toBe(false);
      await Promise.resolve();
      expect(markReadRequests()).toEqual([]);
    },
  );

  it("marks the group read when invoked while nothing has changed", async () => {
    loadHostFeed(GROUP);
    const capture = oldRenderCapture();
    const client = renderPopover(() => undefined, capture.probe);
    await screen.findAllByTestId("notification-entry");

    expect(capture.invoke()).toBe(true);
    await mutationSettled(client);

    expect(markReadRequests()).toEqual(["m1", "m2", "m3"]);
  });
});
