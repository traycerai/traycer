import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";

const navigateSpy = vi.hoisted(() =>
  vi.fn<(options: unknown) => Promise<void>>(),
);

/** What the landing store held when each navigation ran: a navigation that never commits its channel releases its landing straight after. */
const landingAtNavigation = vi.hoisted(() => ({
  seen: [] as Array<Record<string, unknown>>,
}));

const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: unknown;
    readonly directory: IHostDirectoryService;
  } | null;
}>(() => ({ current: null }));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingState.current,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { hostQueryEntryKey } from "@/hooks/host/use-host-query";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import {
  handTracyLandingToChannel,
  releaseTracyLanding,
  stageTracyLanding,
  useTracySurfaceStore,
} from "@/stores/bots/tracy-surface-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * A bot notification opens the Tracy surface on the thread message it names.
 * The navigation may wait on the tabs, and the app may move on while it does:
 * the account changes, the surface is bound to another host or closes. What
 * was asked for then is not what the app is showing, so once the tabs are
 * ready nothing of it navigates or lands. Accepting the activation is
 * reported once, at once, whatever follows.
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-1";
const THREAD = "thread-1";

function replyRow(messageId: string) {
  return rowFromHostEntry({
    id: `bot.reply:${messageId}`,
    updatedAt: 10,
    readAt: null,
    kind: "host.operation.finished",
    sourceRef: messageId,
    severity: "done",
    outcome: "completed",
    epicId: BOT_ID,
    chatId: THREAD,
    payload: {
      kind: "bot_conversation",
      event: "reply",
      operation: "bot.reply",
      title: "Tracy",
      message: "Something in the thread",
      botId: BOT_ID,
      botTitle: "Tracy",
      conversationId: "conversation-main",
      threadId: THREAD,
      messageId,
      authorUserId: null,
      mention: false,
    },
  });
}

let queryClient = new QueryClient();

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    props.children,
  );
}

function activate(
  messageId: string,
  onResult: (outcome: "success" | "failure") => void,
): void {
  activateFrom(messageId, null, onResult);
}

/** The reader activates the reply's notification; `originHostId` is the host the row names, or `null` for a cloud row. */
function activateFrom(
  messageId: string,
  originHostId: string | null,
  onResult: (outcome: "success" | "failure") => void,
): void {
  const row = replyRow(messageId);
  const { payload } = row;
  if (payload === null) throw new Error("the bot row carried no payload");
  const hook = renderHook(() => useNotificationActivation(), { wrapper });
  act(() => {
    hook.result.current.activate({
      payload,
      receivedAt: 2_000,
      feedId: row.feedId,
      originHostId,
      onResult,
    });
  });
}

/** The message each navigation that ran was landed on. */
function landedMessages(): ReadonlyArray<unknown> {
  return landingAtNavigation.seen.map((landing) => {
    const entry = landing[BOT_ID];
    return typeof entry === "object" && entry !== null && "messageId" in entry
      ? entry.messageId
      : undefined;
  });
}

/** The tabs finish hydrating: whatever waited for them runs. */
function hydrate(): void {
  act(() => {
    tabNavigationController.setHydrationReady(true, navigateSpy);
  });
}

beforeEach(async () => {
  queryClient = new QueryClient();
  vi.mocked(toast.error).mockReset();
  __resetTabNavigationControllerForTesting();
  __resetTabSyncCoordinatorForTesting();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  useTracySurfaceStore.setState(useTracySurfaceStore.getInitialState(), true);
  useSelectionAuthorityStore.setState({ effectiveHostId: HOST_ID });
  useBotTabLandingStore.setState({ byBotId: {} });
  navigateSpy.mockReset();
  landingAtNavigation.seen = [];
  navigateSpy.mockImplementation(() => {
    landingAtNavigation.seen.push(useBotTabLandingStore.getState().byBotId);
    return Promise.resolve();
  });
  const hostClient = {
    getActiveHostId: () => HOST_ID,
    createRequesterForHostId: () => hostClient,
  };
  bindingState.current = {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      findById: () => null,
      refresh: () => Promise.resolve([]),
      refreshForEra: () => Promise.resolve([]),
      invalidateInFlightRefresh: () => undefined,
    },
  };
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-a", userName: "A", email: "a@example.com" },
      { userId: "user-a", username: "A" },
      [],
    );
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  bindingState.current = null;
});

const DEPARTURES = [
  [
    "another account signs in",
    () => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-b", userName: "B", email: "b@example.com" },
          { userId: "user-b", username: "B" },
          [],
        );
    },
  ],
  [
    "the surface is bound to another host",
    () => {
      useTracySurfaceStore.getState().rebind("host-other");
    },
  ],
  [
    "the surface closes",
    () => {
      useTracySurfaceStore.getState().closeSurface();
    },
  ],
] as const;

describe("a bot notification activated while the tabs are still hydrating", () => {
  it("navigates to the thread message it named once hydration finishes, having reported success once at dispatch", () => {
    __resetTabNavigationHydrationForTesting();
    const onResult = vi.fn();

    activate("reply-1", onResult);
    expect(onResult.mock.calls).toEqual([["success"]]);
    expect(navigateSpy).not.toHaveBeenCalled();
    hydrate();

    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(landedMessages()).toEqual(["reply-1"]);
    expect(onResult.mock.calls).toEqual([["success"]]);
  });

  it.each(DEPARTURES)(
    "navigates nowhere and lands nothing once hydration finishes if %s first, and a later notification still opens its own message",
    (_name, depart) => {
      __resetTabNavigationHydrationForTesting();
      const onResult = vi.fn();
      activate("reply-1", onResult);
      expect(onResult.mock.calls).toEqual([["success"]]);

      act(depart);
      hydrate();

      expect(navigateSpy).not.toHaveBeenCalled();
      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
      expect(onResult.mock.calls).toEqual([["success"]]);

      useSelectionAuthorityStore.setState({ effectiveHostId: HOST_ID });
      const later = vi.fn();
      activate("reply-2", later);

      expect(later.mock.calls).toEqual([["success"]]);
      expect(navigateSpy).toHaveBeenCalledTimes(1);
      expect(landedMessages()).toEqual(["reply-2"]);
    },
  );
});

describe("two notifications of one bot activated while the tabs are hydrating", () => {
  it("navigates once, to the newer message, and the older one's cleanup does not clear it", () => {
    __resetTabNavigationHydrationForTesting();
    const older = vi.fn();
    const newer = vi.fn();

    activate("reply-older", older);
    activate("reply-newer", newer);
    hydrate();

    expect(older.mock.calls).toEqual([["success"]]);
    expect(newer.mock.calls).toEqual([["success"]]);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(landedMessages()).toEqual(["reply-newer"]);
  });
});

describe("a landing staged for a bot's tab that has not shown it yet", () => {
  const OLDER = {
    kind: "thread",
    threadId: THREAD,
    messageId: "reply-older",
  } as const;
  const NEWER = {
    kind: "thread",
    threadId: THREAD,
    messageId: "reply-newer",
  } as const;

  function surfaceOpenOnChannel(): void {
    useTracySurfaceStore.getState().openSurface(HOST_ID);
    useTracySurfaceStore.getState().selectChannel(BOT_ID);
  }

  it("stays asked for while nothing has moved on", () => {
    surfaceOpenOnChannel();

    stageTracyLanding(BOT_ID, NEWER);

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [BOT_ID]: NEWER,
    });
  });

  it.each(DEPARTURES)(
    "is withdrawn when %s, so the tab that mounts or reads its thread list afterwards has nothing to land",
    (_name, depart) => {
      surfaceOpenOnChannel();
      stageTracyLanding(BOT_ID, NEWER);

      act(depart);

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    },
  );

  it("is replaced by a newer request for the same bot, and the replaced one's withdrawal leaves the newer one asked for", () => {
    surfaceOpenOnChannel();
    stageTracyLanding(BOT_ID, OLDER);
    stageTracyLanding(BOT_ID, NEWER);

    releaseTracyLanding(BOT_ID, OLDER);

    expect(useBotTabLandingStore.getState().byBotId).toEqual({
      [BOT_ID]: NEWER,
    });
  });

  it.each(DEPARTURES)(
    "is withdrawn when %s, though the tab has been handed it and has not yet spent it",
    (_name, depart) => {
      surfaceOpenOnChannel();
      useTracySurfaceStore.getState().markVisited(BOT_ID);
      stageTracyLanding(BOT_ID, NEWER);
      handTracyLandingToChannel(BOT_ID, NEWER);
      expect(useBotTabLandingStore.getState().byBotId).toEqual({
        [BOT_ID]: NEWER,
      });

      act(depart);

      expect(useBotTabLandingStore.getState().byBotId).toEqual({});
    },
  );
});

describe("a bot notification that names the host it came from", () => {
  const SURFACE_HOST = "host-surface";
  const NAMED_HOST = "host-named";

  function botRecord(botId: string): BotRecord {
    return {
      botId,
      environmentId: "env-team",
      createdByUserId: "user-1",
      title: botId,
      harness: "claude",
      model: "opus",
      effort: null,
      profile: null,
      trunkChatId: `trunk-${botId}`,
      boundHostId: "host-bound",
      hostEpoch: 1,
      createdAt: 1_000,
      archivedAt: null,
      directive: null,
      replyMode: "thread",
      appConversationChatId: `app-${botId}`,
    };
  }

  /** `hostId`'s `bot.list` has answered with `bots`, as a settled read leaves it. */
  function listAnswered(hostId: string, botIds: ReadonlyArray<string>): void {
    queryClient.setQueryData(
      hostQueryEntryKey({
        hostId,
        effectiveHostId: useSelectionAuthorityStore.getState().effectiveHostId,
        method: "bot.list",
        params: {},
        cacheKeyIdentity: undefined,
      }),
      { bots: botIds.map(botRecord) },
    );
  }

  /** That answer has since been invalidated: a read is due, and what it holds is not settled. */
  async function listInvalidated(hostId: string): Promise<void> {
    await queryClient.invalidateQueries({
      queryKey: hostQueryEntryKey({
        hostId,
        effectiveHostId: useSelectionAuthorityStore.getState().effectiveHostId,
        method: "bot.list",
        params: {},
        cacheKeyIdentity: undefined,
      }),
      refetchType: "none",
    });
  }

  function surfaceBoundTo(hostId: string): void {
    useTracySurfaceStore.getState().openSurface(hostId);
    useTracySurfaceStore.getState().selectChannel(BOT_ID);
  }

  function expectRefused(
    onResult: Mock<(outcome: "success" | "failure") => void>,
  ): void {
    expect(onResult.mock.calls).toEqual([["failure"]]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useBotTabLandingStore.getState().byBotId).toEqual({});
  }

  function expectOpened(
    onResult: Mock<(outcome: "success" | "failure") => void>,
  ): void {
    expect(onResult.mock.calls).toEqual([["success"]]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(landedMessages()).toEqual(["reply-1"]);
  }

  it("is refused, changing nothing, when the surface is bound to another host whose list has answered without the bot", () => {
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, ["bot-other"]);
    const before = useTracySurfaceStore.getState();
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectRefused(onResult);
    expect(useTracySurfaceStore.getState()).toBe(before);
  });

  it("is refused when the named host is the effective host but the surface is bound to a third host whose list lacks the bot", () => {
    useSelectionAuthorityStore.setState({ effectiveHostId: NAMED_HOST });
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, ["bot-other"]);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectRefused(onResult);
  });

  it("is refused, leaving the surface closed, when it is closed and the host it would bind to has a list without the bot", () => {
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-effective" });
    listAnswered("host-effective", ["bot-other"]);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectRefused(onResult);
    expect(useTracySurfaceStore.getState().open).toBe(false);
  });

  it("opens, reporting success once, when the surface's list carries the bot", () => {
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, [BOT_ID]);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectOpened(onResult);
  });

  it("opens as ever when the surface's list has not answered", () => {
    surfaceBoundTo(SURFACE_HOST);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectOpened(onResult);
  });

  it("opens as ever when the list lacks the bot but its answer has been invalidated", async () => {
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, ["bot-other"]);
    await listInvalidated(SURFACE_HOST);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", NAMED_HOST, onResult);

    expectOpened(onResult);
  });

  it("opens as ever when the named host is the surface's own, whatever its list holds", () => {
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, ["bot-other"]);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", SURFACE_HOST, onResult);

    expectOpened(onResult);
  });

  it("opens as ever for a row that names no host", () => {
    surfaceBoundTo(SURFACE_HOST);
    listAnswered(SURFACE_HOST, ["bot-other"]);
    const onResult = vi.fn<(outcome: "success" | "failure") => void>();

    activateFrom("reply-1", null, onResult);

    expectOpened(onResult);
  });
});
