/**
 * A thread card's live artifact reference, through the real `<BotThreadsView />`:
 * the artifact is read only once the task's snapshot has loaded and only from
 * the task's own host, opens in its task from the card's Open, and is shown as
 * unavailable for a path no artifact answers. The fixtures, the mounted tree
 * and the per-case lifecycle are in `bot-threads-view-harness.tsx`; the other
 * cases are in `bot-threads-view.test.tsx`.
 */
import {
  botMentionHostClientMock,
  emptyBotMentionHostListsMock,
} from "@/components/bots/__tests__/bot-mention-host-test-support";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import * as Y from "yjs";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import { expectArtifactOpenIntent } from "@/components/bots/__tests__/artifact-open-intent-support";
import { botReply } from "@/components/bots/__tests__/bot-turn-test-support";
import {
  chatSessionWithPosts,
  chatSessionWithThreadRows,
  postRow,
} from "./bot-channel-rows-test-support";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import {
  defaultTestEpicSessionEnvironment,
  installTestEpicSessionEnvironment,
  setTestEffectiveHost,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import {
  createTestHostClient,
  type TestHostHandlers,
} from "@/lib/host/test-support/test-host-client";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { answerArtifactObjectRead } from "@/lib/host/test-support/artifact-object-answer";
import { setArtifactFieldsInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { mocks } from "./bot-threads-view-state";
import {
  FakeIntersectionObserver,
  intersectTarget,
} from "@/components/bots/__tests__/bot-read-observer-test-support";
import {
  card,
  FOLLOWING,
  installBotThreadsViewCaseLifecycle,
  listed,
  mount,
  script,
  TEAM,
  thread,
  TRACY,
} from "./bot-threads-view-harness";

vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => botMentionHostClientMock,
);
vi.mock(
  "@/hooks/bots/use-environment-host-lists-query",
  () => emptyBotMentionHostListsMock,
);

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    !mocks.unsupported.has(method),
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
// The bot's live snapshot (its tasks, binding and surface actions) is not
// what these cases read: no stream is opened.
vi.mock("@/hooks/bots/use-bot-subscription", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-subscription")
  >()),
  useBotSubscriptionForHost: () => ({
    snapshot: null,
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data:
      mocks.botList === "listed"
        ? { bots: mocks.bots, mainBotIds: null }
        : undefined,
    isError: mocks.botList === "failed",
    refetch: mocks.refetchBots,
  }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: (args: { chatIds: ReadonlyArray<string> }) => ({
    epics: {},
    chats: Object.fromEntries(
      args.chatIds.map((id) => [id, { unreadCount: mocks.unread[id] ?? 0 }]),
    ),
  }),
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null => {
    if (Object.hasOwn(mocks.replyRows, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        mocks.replyRows[chatId],
      );
      return mocks.threadSessions[chatId];
    }
    if (Object.hasOwn(mocks.replies, chatId)) {
      mocks.threadSessions[chatId] ??= chatSessionWithThreadRows(
        // Each reply is written one second after the one before it, as the
        // host's read positions name them.
        mocks.replies[chatId].map((text, index) => ({
          ...postRow(`${chatId}-reply-${String(index + 1)}`, text),
          timestamp: (index + 1) * 1_000,
        })),
      );
      return mocks.threadSessions[chatId];
    }
    if (!Object.hasOwn(mocks.channels, botId)) {
      if (!Object.hasOwn(mocks.posts, botId)) return null;
      mocks.channels[botId] = chatSessionWithPosts(mocks.posts[botId]);
    }
    return mocks.channels[botId];
  },
}));
vi.mock("@/hooks/bots/use-bot-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/bots/use-bot-activity")>()),
  useBotActivity: () => null,
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServingHostId: () => "host-1",
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => null,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
// An accepted navigation commits the channel it arrives at, as the tab's
// controller does once the path is acknowledged; the landing staged for it is
// then the channel's to spend.
vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const { useTracySurfaceStore: surfaceStore } =
    await import("@/stores/bots/tracy-surface-store");
  return {
    ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
    activateTabIntent: (_navigate: unknown, intent: TabNavigationIntent) => {
      mocks.activateTabIntent(intent);
      if (intent.kind === "tracy") {
        surfaceStore.getState().selectChannel(intent.botId);
      }
      return true;
    },
  };
});
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: ["host-1"], resolved: true }),
}));

// JSDOM never fetches a served artifact URL, so the real frame reads nothing
// here. The driver stands in for the browser's entry-document request (test-only;
// object-port and shared-renderer proof, not iframe or Expand proof).
vi.mock("@/components/sandbox/sandbox-frame", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/sandbox/sandbox-frame")
  >()),
  SandboxFrame: (
    await import("@/components/sandbox/__tests__/artifact-frame-browser-driver")
  ).ArtifactFrameBrowserDriver,
}));

installBotThreadsViewCaseLifecycle();

describe("<BotThreadsView /> a thread card's live artifact", () => {
  // The frame is the test-only browser driver: these cases prove which host the
  // bytes come from and when, through the shared renderer's object port. Real
  // iframe, Expand and one-instance proof belong to the browser fixtures.
  const TASK_ID = "task-live";
  const TASK_HOST_ID = "host-task";
  const sessionHarness = createEpicSessionTestHarness(TASK_ID);
  const VIEWER = "user-1";
  let previousAuth: AuthState;
  const sessionQueryClient = new QueryClient();
  const objectReads: Record<string, number> = {};
  const handlersByHost = new Map<string, TestHostHandlers>();

  function handlersFor(hostId: string) {
    const held = handlersByHost.get(hostId);
    if (held !== undefined) return held;
    const made: TestHostHandlers = {
      "epic.readArtifactObject": (request) => {
        objectReads[hostId] = (objectReads[hostId] ?? 0) + 1;
        return answerArtifactObjectRead(request, "<html></html>", "text/html");
      },
    };
    handlersByHost.set(hostId, made);
    return made;
  }

  function seedRollout(doc: Y.Doc): void {
    setArtifactFieldsInDocForTests(doc, "artifact-rollout", {
      kind: "html",
      title: "Rollout plan",
      folderName: "rollout",
      parentId: null,
      createdAt: 1,
      updatedAt: 2,
      createdManually: true,
      head: {
        files: {
          "index.html": {
            sha256: "a".repeat(64),
            byteLength: 13,
            mediaType: "text/html",
            status: "published",
          },
        },
        capturedAt: 5,
      },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    handlersByHost.clear();
    for (const key of Object.keys(objectReads)) delete objectReads[key];
    __getOpenEpicRegistryForTests().disposeAll();
    const resolveHostClient = (hostId: string) =>
      createTestHostClient(
        hostId,
        VIEWER,
        sessionQueryClient,
        handlersFor(hostId),
      );
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      resolveHostClient,
    });
    setTestEffectiveHost("host-1", true);
    // The suite's outer reset leaves no bot scripted: the host answers each
    // listed bot, Tracy with no thread and Team with the one this case draws.
    mocks.hosted[TRACY] = script([], {});
    mocks.hosted[TEAM] = script([thread(TEAM, "team-new", 3_000)], {
      "team-new": FOLLOWING,
    });
    sessionHarness.install(seedRollout, "editor");
    previousAuth = useAuthStore.getState();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: VIEWER,
        userName: "Olive Owner",
        email: "olive@example.com",
        avatarUrl: null,
      },
      contextMetadata: { userId: VIEWER, username: "Olive Owner" },
    });
  });

  afterEach(() => {
    useAuthStore.setState(previousAuth, true);
    sessionHarness.teardown();
    __getOpenEpicRegistryForTests().disposeAll();
  });

  /** `revealFull` polls with Testing Library's `waitFor`, which fake timers stall. */
  async function revealFullUnderFakeTimers(threadId: string): Promise<void> {
    intersectTarget(card(threadId), "near", true);
    await vi.waitFor(() =>
      expect(card(threadId).getAttribute("data-full")).toBe("true"),
    );
  }

  /**
   * The artifact cards inside the revealed thread card are in view: tell the
   * observers watching them so (the thread card's own observers are left to
   * `revealFullUnderFakeTimers`). A card is shown only while it is presented.
   */
  function presentArtifactCards(threadId: string): void {
    const figure = within(card(threadId)).getByTestId("artifact-row");
    const threadCard = card(threadId);
    act(() => {
      for (const observer of FakeIntersectionObserver.all) {
        const entries = [...observer.targets]
          .filter(
            (target) =>
              target !== threadCard &&
              (target.contains(figure) || figure.contains(target)),
          )
          .map((target) => {
            // Whole in view, as `intersectTarget` reports a row.
            const rect = new DOMRect(0, 0, 100, 100);
            return {
              target,
              isIntersecting: true,
              boundingClientRect: rect,
              intersectionRect: rect,
            };
          });
        if (entries.length > 0) observer.fire(entries);
      }
    });
  }

  function liveReply(artifactPath: string): Message {
    return {
      ...botReply({
        messageId: "team-new-live",
        text: "The rollout plan is ready.",
        timestamp: 3_000,
      }),
      surface: {
        kind: "artifact",
        epicId: TASK_ID,
        hostId: TASK_HOST_ID,
        artifactPath,
        resolution: null,
      },
    };
  }

  it("reads the artifact only once the task's snapshot has loaded, and only from the task's host", async () => {
    mocks.replyRows["team-new"] = [liveReply("rollout/index.html")];
    mount();
    await vi.waitFor(() => expect(listed()).toContain("team-new"));
    await revealFullUnderFakeTimers("team-new");
    presentArtifactCards("team-new");
    expect(objectReads).toEqual({});
    expect(document.querySelectorAll("iframe")).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(0));

    await vi.waitFor(() =>
      expect(objectReads[TASK_HOST_ID] ?? 0).toBeGreaterThan(0),
    );
    expect(Object.keys(objectReads)).toEqual([TASK_HOST_ID]);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("admits the task through the registry without opening a tab or keeping an artifact room hot", async () => {
    const tabsBefore = useEpicCanvasStore.getState().openTabOrder;
    mocks.replyRows["team-new"] = [liveReply("rollout/index.html")];
    mount();
    await vi.waitFor(() => expect(listed()).toContain("team-new"));
    await revealFullUnderFakeTimers("team-new");
    presentArtifactCards("team-new");
    await act(() => vi.advanceTimersByTimeAsync(0));
    await vi.waitFor(() =>
      expect(objectReads[TASK_HOST_ID] ?? 0).toBeGreaterThan(0),
    );

    const handle = __getOpenEpicRegistryForTests().peek(TASK_ID);
    if (handle === null) throw new Error("the task was not admitted");
    expect(handle.hotArtifactRoomIdsForTests()).toEqual([]);
    // The reference opened no tab of its own: no fake tab stands in for it.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(tabsBefore);
  });

  it("shows a path no artifact answers as unavailable and reads nothing", async () => {
    mocks.replyRows["team-new"] = [liveReply("missing/index.html")];
    mount();
    await vi.waitFor(() => expect(listed()).toContain("team-new"));
    await revealFullUnderFakeTimers("team-new");
    presentArtifactCards("team-new");
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    expect(objectReads).toEqual({});
  });

  it("opens the artifact in its task from the card's real Open, resolved from the admitted handle", async () => {
    mocks.replyRows["team-new"] = [liveReply("rollout/index.html")];
    mount();
    await vi.waitFor(() => expect(listed()).toContain("team-new"));
    await revealFullUnderFakeTimers("team-new");
    presentArtifactCards("team-new");
    await act(() => vi.advanceTimersByTimeAsync(0));
    await vi.waitFor(() =>
      expect(objectReads[TASK_HOST_ID] ?? 0).toBeGreaterThan(0),
    );

    fireEvent.click(
      within(card("team-new")).getByRole("button", { name: "Open in panel" }),
    );

    expectArtifactOpenIntent(mocks.activateTabIntent.mock.calls, {
      epicId: TASK_ID,
      artifactId: "artifact-rollout",
      title: "Rollout plan",
      // The reference host, not the window's "host-1".
      hostId: TASK_HOST_ID,
      botId: TEAM,
    });
  });
});
