/**
 * The Tracy surface's shell (decision 150), through the REAL shell, channel
 * column, tab-navigation controller and router (`TabNavigationRouteBridge`),
 * over the real surface, rail, drafts and landing stores. Only host
 * boundaries are scripted: `bot.list` and `environment.list` (an external
 * store a case moves between pending, failed and answered), `bot.open`, the
 * bot's stream snapshot, and the channel's own views, which are stubs that
 * show what the shell hands them.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
  type UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

type ListStatus = "pending" | "error" | "success";

interface ListScript {
  readonly status: ListStatus;
  readonly bots: ReadonlyArray<BotRecord>;
  readonly mainBotIds: Readonly<Record<string, string>> | null;
  /** Whether `bots` is what the query holds; a pending read holds none. */
  readonly hasData: boolean;
}

/** What the environment-list read holds, as `ListScript` does for the bots'. */
interface EnvironmentsScript {
  readonly status: ListStatus;
  readonly hasData: boolean;
}

/**
 * What one bot's thread-list read holds; a bot with none holds no threads.
 * `null` threads is a read that has not answered.
 */
interface ThreadListScript {
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly isFetching: boolean;
  readonly isError: boolean;
}

const script = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: {
    list: ListScript;
    /** The `dataUpdatedAt` the list read reports. */
    listUpdatedAt: number;
    /** Bots whose subscription reports `deleted`; replaced, never mutated. */
    deletedBotIds: ReadonlySet<string>;
    /** Replaced, never mutated, like `list`. */
    environmentsRead: EnvironmentsScript;
    environments: ReadonlyArray<EnvironmentDescriptor>;
    /** Bot ids whose `bot.open` is refused. */
    openFails: Set<string>;
    /** Replaced, never mutated, so a subscriber reads a stable snapshot. */
    threadLists: Readonly<Record<string, ThreadListScript>>;
  } = {
    list: { status: "pending", bots: [], mainBotIds: null, hasData: false },
    listUpdatedAt: 1_000,
    deletedBotIds: new Set(),
    environmentsRead: { status: "success", hasData: true },
    environments: [],
    openFails: new Set(),
    threadLists: {},
  };
  return {
    state,
    listeners,
    /** The two lists' `refetch`; a case sets what the next call answers. */
    refetch: { bots: vi.fn(), environments: vi.fn() },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: (): void => listeners.forEach((listener) => listener()),
  };
});

const mocks = vi.hoisted(() => ({
  client: { stub: "tab-host-client" },
  /** The bot of each `bot.open` call, in order. */
  opened: new Array<string>(),
  /** One stable mutation object, like TanStack's `mutate`. */
  openMutation: {
    mutate: (
      variables: { botId: string },
      options: {
        onSuccess: (response: unknown) => void;
        onError: (error: { message: string }) => void;
      },
    ): void => {
      mocks.opened.push(variables.botId);
      // A reselect loop is all microtasks and never yields to a timeout, so it
      // would hang the file; fail it here instead.
      if (mocks.opened.length > 100) throw new Error("bot.open in a loop");
      if (script.state.openFails.has(variables.botId)) {
        options.onError({ message: "the host refused" });
        return;
      }
      options.onSuccess({
        bot: { botId: variables.botId },
        outcome: { kind: "serve-here", claimed: null },
      });
    },
  },
}));

function useEnvironmentsScript(): EnvironmentsScript {
  return useSyncExternalStore(
    script.subscribe,
    () => script.state.environmentsRead,
    () => script.state.environmentsRead,
  );
}

function useDeletedScript(): ReadonlySet<string> {
  return useSyncExternalStore(
    script.subscribe,
    () => script.state.deletedBotIds,
    () => script.state.deletedBotIds,
  );
}

function useListScript(): ListScript {
  return useSyncExternalStore(
    script.subscribe,
    () => script.state.list,
    () => script.state.list,
  );
}

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostMethodSchemaVersion: () => ({ major: 1, minor: 1 }),
  useHostSupportsMethod: () => true,
}));
vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.client,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-tab",
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => {
    const list = useListScript();
    return {
      status: list.status,
      data: list.hasData
        ? { bots: list.bots, mainBotIds: list.mainBotIds }
        : undefined,
      dataUpdatedAt: script.state.listUpdatedAt,
      errorUpdatedAt: 0,
      isFetchedAfterMount: true,
      isFetching: false,
      refetch: script.refetch.bots,
    };
  },
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => {
    const read = useEnvironmentsScript();
    return {
      status: read.status,
      data: read.hasData
        ? { environments: script.state.environments }
        : undefined,
      refetch: script.refetch.environments,
    };
  },
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: () => undefined,
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOpenMutation: () => mocks.openMutation,
}));
// The team setups and the column's thread reads: nothing is to be set up and
// no thread is followed.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: { requests: ReadonlyArray<{ method: string }> }) =>
    args.requests.map((request) => {
      const answers: Record<string, unknown> = {
        "bot.onboarding.read": { setup: null },
        "bot.thread.list": {
          threads: [],
          trunkCostUsd: null,
          threadAnchors: null,
        },
        "bot.threadFollow.read": { follows: {} },
        "bot.readCursor.read": { cursors: {}, latest: {} },
        "bot.notificationLevel.read": { levels: {} },
      };
      return {
        status: "success",
        isPending: false,
        isError: false,
        data: answers[request.method],
        dataUpdatedAt: 1_000,
        refetch: () => undefined,
      };
    }),
}));
vi.mock("@/hooks/host/use-host-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/host/use-host-query")>()),
  useHostQuery: (args: { method: string }) => {
    if (args.method === "bot.notificationLevel.read") {
      return { data: { levels: {} } };
    }
    if (args.method === "bot.readCursor.read") return { data: undefined };
    return { data: undefined };
  },
}));
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => ({
  useBotThreadListQuery: (_client: unknown, botId: string) => {
    const lists = useSyncExternalStore(
      script.subscribe,
      () => script.state.threadLists,
      () => script.state.threadLists,
    );
    const read = Object.hasOwn(lists, botId) ? lists[botId] : undefined;
    if (read === undefined) return { data: { threads: [] } };
    return {
      data: read.threads === null ? undefined : { threads: read.threads },
      isFetching: read.isFetching,
      isError: read.isError,
    };
  },
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: (input: { botId: string }) => {
    const deletedBotIds = useDeletedScript();
    return {
      snapshot: snapshotOf(input.botId),
      deleted: deletedBotIds.has(input.botId),
      error: null,
      isPending: false,
      resubscribe: () => undefined,
    };
  },
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({
    hostIds: ["host-tab", "host-bound"],
    resolved: true,
  }),
}));
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: {},
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/hooks/bots/use-environment-members-query", () => ({
  useEnvironmentMemberDirectory: () => ({
    resolve: () => null,
    members: null,
  }),
}));
// A host that keeps no read cursors: no channel is bold, no "Mark as read".
vi.mock("@/hooks/bots/use-bot-read-cursor", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/bots/use-bot-read-cursor")
  >()),
  useBotMarkChannelRead: () => null,
  useBotReadCursorSupported: () => false,
}));
vi.mock("@/hooks/bots/use-bot-memory", () => ({
  useBotMemory: () => ({ kind: "unsupported" }),
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: () => ({ epics: {}, chats: {} }),
}));
vi.mock("@/hooks/bots/use-environment-set-main-bot-mutation", () => ({
  useEnvironmentSetMainBotMutation: () => ({
    isPending: false,
    error: null,
    mutate: () => undefined,
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-1",
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
vi.mock("@/components/home/bots/create-bot-form", () => ({
  CreateBotForm: () => <div data-testid="stub-create-bot-form" />,
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: (props: {
    botId: string;
    botTitle: string;
    openThread: BotOpenThread | null;
  }) => (
    <div
      data-testid="stub-channel"
      data-bot-id={props.botId}
      data-bot-title={props.botTitle}
      data-open-thread={props.openThread?.anchorMessageId ?? "none"}
    />
  ),
}));
vi.mock("@/components/bots/bot-session-view", () => ({
  BotSessionView: () => <div data-testid="stub-session" />,
}));
vi.mock("@/components/bots/bot-activity-page", () => ({
  BotActivityPage: () => <div data-testid="stub-activity" />,
}));
vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => <div data-testid="stub-threads" />,
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotChannelSettingsPanel: () => <div data-testid="stub-settings" />,
}));

import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { tracyRoute } from "@/lib/routes";
import { openBotChannel, openTracyEntry } from "@/lib/bots/open-bot-channel";
import {
  __resetTabNavigationControllerForTesting,
  tracyNavigationPending,
} from "@/lib/tab-navigation";
import { useBotColumnLayoutStore } from "@/stores/bots/bot-column-layout-store";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useBotSurfaceActionsStore } from "@/stores/bots/bot-surface-actions-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

const WINDOW_HOST = "host-tab";

function bot(botId: string, environmentId: string, title: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title,
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

function snapshotOf(botId: string): BotSubscriptionSnapshot {
  const record =
    script.state.list.bots.find((candidate) => candidate.botId === botId) ??
    bot(botId, "env-team", botId);
  return {
    bot: record,
    tasks: [],
    openRequestCount: 0,
    conversationsRevision: null,
    notificationSubscriptions: null,
    surfaceActions: null,
    stoppedNotificationWatches: null,
    boundHost: { hostId: "host-bound", epoch: 1, isThisHost: false },
    activity: null,
  };
}

function environment(
  environmentId: string,
  label: string,
  ownerKind: EnvironmentDescriptor["ownerKind"],
): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind,
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label,
  };
}

const ENVIRONMENTS = [
  environment("env-me", "Personal", "user"),
  environment("env-team", "Acme", "organization"),
];
const NOTES = bot("bot-notes", "env-me", "notes-bot");
const RELEASE = bot("bot-release", "env-team", "release-bot");
const TRIAGE = bot("bot-triage", "env-team", "triage-bot");
const DEPLOY = bot("bot-deploy", "env-team", "deploy-bot");

function answerList(
  bots: ReadonlyArray<BotRecord>,
  mainBotIds: Readonly<Record<string, string>> | null,
): void {
  script.state.list = { status: "success", bots, mainBotIds, hasData: true };
  script.notify();
}

/** Set before the list read it belongs to, which then notifies. */
function setListUpdatedAt(at: number): void {
  script.state.listUpdatedAt = at;
}

function setDeletedBotIds(botIds: ReadonlySet<string>): void {
  script.state.deletedBotIds = botIds;
  script.notify();
}

function setList(next: ListScript): void {
  script.state.list = next;
  script.notify();
}

function setEnvironmentsRead(next: EnvironmentsScript): void {
  script.state.environmentsRead = next;
  script.notify();
}

function setThreadList(botId: string, next: ThreadListScript): void {
  script.state.threadLists = { ...script.state.threadLists, [botId]: next };
  script.notify();
}

function buildRouter(Host: () => ReactNode, initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <TabNavigationRouteBridge />
        <Host />
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const routes = ["/", "/home", "/bot", "/bot/$botId"].map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

/** What the top-level tab host does for the `tracy` tab: show the store's surface. */
function SurfaceHost(): ReactNode {
  const open = useTracySurfaceStore((state) => state.open);
  const hostId = useTracySurfaceStore((state) => state.hostId);
  const botId = useTracySurfaceStore((state) => state.botId);
  if (!open || hostId === null) return null;
  return <BotTabSurface botId={botId} hostId={hostId} />;
}

/**
 * `SurfaceHost` as the top-level tab host shows it: an inactive tab's surface
 * stays mounted but hidden, so the shell sees `PaneVisibilityContext` false
 * until the tracy tab is the active item.
 */
function PaneAwareSurfaceHost(): ReactNode {
  const tracyActive = useTabsStore(
    (state) => state.activeItemId === "tab:tracy:tracy",
  );

  return (
    <PaneVisibilityContext.Provider value={tracyActive}>
      <SurfaceHost />
    </PaneVisibilityContext.Provider>
  );
}

interface Mounted {
  readonly navigate: UseNavigateResult<string>;
  readonly history: RouterHistory;
  readonly pathname: () => string;
}

async function mount(): Promise<Mounted> {
  return mountWith(SurfaceHost, "/");
}

async function mountPaneAware(): Promise<Mounted> {
  return mountWith(PaneAwareSurfaceHost, "/home");
}

async function mountWith(
  Host: () => ReactNode,
  initialPath: string,
): Promise<Mounted> {
  const router = buildRouter(Host, initialPath);
  render(<RouterProvider router={router} />);
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });
  return {
    navigate: router.navigate,
    history: router.history,
    pathname: () => router.state.location.pathname,
  };
}

/** A navigation held in flight until the test releases or refuses it. */
interface HeldNavigation {
  readonly navigate: UseNavigateResult<string>;
  readonly release: () => void;
  readonly refuse: () => void;
}

function holdNavigation(mounted: Mounted): HeldNavigation {
  let release: () => void = () => undefined;
  let refuse: () => void = () => undefined;
  const decision = new Promise<void>((resolve, reject) => {
    release = resolve;
    refuse = () => reject(new Error("navigation refused"));
  });
  return {
    navigate: (options) => decision.then(() => mounted.navigate(options)),
    release,
    refuse,
  };
}

function open(mounted: Mounted, botId: string): void {
  act(() => {
    openBotChannel(mounted.navigate, botId, {
      landing: null,
      isConnectable: null,
      onRejected: null,
    });
  });
}

function row(botId: string): HTMLElement {
  const found = screen
    .getAllByTestId("bot-channel-row")
    .find((element) => element.getAttribute("data-bot-id") === botId);
  if (found === undefined) throw new Error(`no row for ${botId}`);
  return found;
}

/** The channel the pane shows, by its bot's title. */
async function shownChannel(botId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const channel = screen.getByTestId("stub-channel");
    expect(channel.getAttribute("data-bot-id")).toBe(botId);
    return channel;
  });
}

function seedKeptState(botId: string): void {
  useBotOpenThreadStore.getState().setRail(botId, {
    kind: "thread",
    anchorMessageId: `post-of-${botId}`,
    announcement: false,
    anchorKind: null,
    sent: null,
  });
  useBotDraftsStore.getState().typeThreadBox(botId, "post-1", "unsent");
  useBotTabLandingStore
    .getState()
    .request(botId, { kind: "thread", threadId: null, messageId: null });
}

/** Whether any of `botId`'s per-channel state is still kept. */
function keptState(botId: string): {
  readonly rail: boolean;
  readonly draft: boolean;
  readonly landing: boolean;
  readonly visited: boolean;
} {
  return {
    rail: Object.hasOwn(useBotOpenThreadStore.getState().byBotId, botId),
    draft: useBotDraftsStore.getState().threadBoxes[botId] !== undefined,
    landing: Object.hasOwn(useBotTabLandingStore.getState().byBotId, botId),
    visited: useTracySurfaceStore.getState().visitedBotIds.includes(botId),
  };
}

const KEPT = { rail: true, draft: true, landing: true, visited: true };
const FORGOTTEN = { rail: false, draft: false, landing: false, visited: false };

function resetStores(): void {
  window.localStorage.clear();
  script.state.list = {
    status: "pending",
    bots: [],
    mainBotIds: null,
    hasData: false,
  };
  script.state.listUpdatedAt = 1_000;
  script.state.deletedBotIds = new Set();
  mocks.opened.length = 0;
  script.state.environmentsRead = { status: "success", hasData: true };
  script.state.environments = ENVIRONMENTS;
  script.refetch.bots.mockReset();
  script.refetch.environments.mockReset();
  script.state.openFails.clear();
  script.state.threadLists = {};
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  useBotColumnLayoutStore.setState({
    sectionOrder: [],
    channelOrder: {},
    collapsed: [],
  });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useBotDraftsStore.setState({ answers: {}, threadBoxes: {} });
  useBotSurfaceActionsStore.setState({ entries: {} });
  useBotTabLandingStore.setState({ byBotId: {} });
  useLayoutStore.setState({ overrides: {} });
  useSelectionAuthorityStore.setState({
    attached: true,
    effectiveHostId: WINDOW_HOST,
  });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  tabCommandCoordinator.resetReconciliationForTesting();
  __resetTabNavigationControllerForTesting();
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  resetStores();
});

describe("the Tracy surface shell", () => {
  it("keeps the channel column mounted and each channel's open thread across a channel switch", async () => {
    answerList([NOTES, RELEASE, TRIAGE], { "env-me": "bot-notes" });
    const mounted = await mount();
    open(mounted, "bot-release");
    await shownChannel("bot-release");
    useBotOpenThreadStore.getState().setRail("bot-release", {
      kind: "thread",
      anchorMessageId: "post-1",
      announcement: false,
      anchorKind: null,
      sent: null,
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("post-1");
    });
    const column = screen.getByTestId("bot-channel-sidebar");

    fireEvent.click(row("bot-triage"));
    const triage = await shownChannel("bot-triage");
    expect(mounted.pathname()).toBe("/bot/bot-triage");
    expect(triage.getAttribute("data-open-thread")).toBe("none");
    expect(screen.getByTestId("bot-channel-sidebar")).toBe(column);
    expect(useBotOpenThreadStore.getState().byBotId["bot-release"]).toEqual(
      expect.objectContaining({ kind: "thread", anchorMessageId: "post-1" }),
    );

    fireEvent.click(row("bot-release"));
    const release = await shownChannel("bot-release");
    expect(mounted.pathname()).toBe("/bot/bot-release");
    expect(release.getAttribute("data-open-thread")).toBe("post-1");
    expect(screen.getByTestId("bot-channel-sidebar")).toBe(column);
  });

  it("lets the person switch away, through the column, from a channel whose bot.open fails", async () => {
    answerList([NOTES, RELEASE, TRIAGE], { "env-me": "bot-notes" });
    script.state.openFails.add("bot-triage");
    const mounted = await mount();
    open(mounted, "bot-release");
    await shownChannel("bot-release");

    fireEvent.click(row("bot-triage"));
    await screen.findByText(/Couldn't open this bot/);
    expect(mounted.pathname()).toBe("/bot/bot-triage");
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    fireEvent.click(row("bot-release"));
    await shownChannel("bot-release");
    expect(mounted.pathname()).toBe("/bot/bot-release");
    expect(useTracySurfaceStore.getState().botId).toBe("bot-release");
  });

  it("forgets an inactive visited channel's state once a successful list no longer carries it, and keeps the other inactive channel's", async () => {
    answerList([NOTES, RELEASE, TRIAGE], { "env-me": "bot-notes" });
    const mounted = await mount();
    open(mounted, "bot-release");
    await shownChannel("bot-release");
    fireEvent.click(row("bot-triage"));
    await shownChannel("bot-triage");
    fireEvent.click(row("bot-notes"));
    await shownChannel("bot-notes");
    seedKeptState("bot-release");
    seedKeptState("bot-triage");
    expect(keptState("bot-release")).toEqual(KEPT);

    act(() => answerList([NOTES, TRIAGE], { "env-me": "bot-notes" }));

    await waitFor(() => {
      expect(keptState("bot-release")).toEqual(FORGOTTEN);
    });
    expect(keptState("bot-triage")).toEqual(KEPT);
    expect({
      pathname: mounted.pathname(),
      botId: useTracySurfaceStore.getState().botId,
    }).toEqual({ pathname: "/bot/bot-notes", botId: "bot-notes" });
  });

  it("deletes nothing while the list read is pending or has failed, only once a list that answered lacks the bot", async () => {
    answerList([NOTES, RELEASE, TRIAGE], { "env-me": "bot-notes" });
    const mounted = await mount();
    open(mounted, "bot-release");
    await shownChannel("bot-release");
    fireEvent.click(row("bot-triage"));
    await shownChannel("bot-triage");
    seedKeptState("bot-release");

    act(() =>
      setList({
        status: "pending",
        bots: [],
        mainBotIds: null,
        hasData: false,
      }),
    );
    expect(keptState("bot-release")).toEqual(KEPT);

    // A failed refresh keeps the list it had, here one without the bot.
    act(() =>
      setList({
        status: "error",
        bots: [NOTES, TRIAGE],
        mainBotIds: { "env-me": "bot-notes" },
        hasData: true,
      }),
    );
    expect(keptState("bot-release")).toEqual(KEPT);
    expect(mounted.pathname()).toBe("/bot/bot-triage");

    act(() => answerList([NOTES, TRIAGE], { "env-me": "bot-notes" }));
    await waitFor(() => {
      expect(keptState("bot-release")).toEqual(FORGOTTEN);
    });
  });

  it.each([
    {
      name: "the personal environment's main bot",
      bots: [NOTES, RELEASE, TRIAGE],
      remaining: [NOTES, TRIAGE],
      mainBotIds: { "env-me": "bot-notes" },
      selected: "bot-notes",
    },
    {
      name: "the first channel in the column's order when there is no personal main bot",
      bots: [RELEASE, TRIAGE],
      remaining: [TRIAGE],
      mainBotIds: null,
      selected: "bot-triage",
    },
  ])(
    "selects $name when the selected bot goes away",
    async ({ bots, remaining, mainBotIds, selected }) => {
      answerList(bots, mainBotIds);
      const mounted = await mount();
      open(mounted, "bot-release");
      await shownChannel("bot-release");

      act(() => answerList(remaining, mainBotIds));

      await shownChannel(selected);
      expect({
        pathname: mounted.pathname(),
        botId: useTracySurfaceStore.getState().botId,
      }).toEqual({ pathname: `/bot/${selected}`, botId: selected });
      expect(keptState("bot-release").visited).toBe(false);
    },
  );

  it("selects the first channel in the person's arranged order when the selected bot goes away and there is no personal main bot", async () => {
    // The model sorts a section by title (deploy, release, triage); the person
    // put triage first.
    useBotColumnLayoutStore.setState({
      channelOrder: {
        "env-team": ["bot-triage", "bot-deploy", "bot-release"],
      },
    });
    answerList([RELEASE, TRIAGE, DEPLOY], null);
    const mounted = await mount();
    open(mounted, "bot-release");
    await shownChannel("bot-release");

    act(() => answerList([TRIAGE, DEPLOY], null));

    await shownChannel("bot-triage");
    expect({
      pathname: mounted.pathname(),
      botId: useTracySurfaceStore.getState().botId,
    }).toEqual({ pathname: "/bot/bot-triage", botId: "bot-triage" });
  });

  it("shows the empty state, with the column still there, when there are no bots", async () => {
    answerList([], null);
    const mounted = await mount();

    act(() => {
      openTracyEntry(mounted.navigate, null);
    });

    const empty = await screen.findByTestId("bot-tab-no-channel");
    expect(mounted.pathname()).toBe("/bot");
    expect(within(empty).getByText(/No bots yet/)).toBeTruthy();
    expect(screen.getByTestId("bot-channel-sidebar")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(useTracySurfaceStore.getState().botId).toBeNull();
  });

  it("leaves the empty state, opening nothing, for the only bot its subscription reports gone while the list still carries it, until a newer list read settles it", async () => {
    answerList([RELEASE], null);
    const mounted = await mount();
    act(() => {
      openTracyEntry(mounted.navigate, null);
    });
    await shownChannel("bot-release");
    const opensBefore = mocks.opened.length;
    expect(opensBefore).toBeGreaterThan(0);

    // The stream says the bot is deleted; the refresh of the list that would
    // say so too fails, and keeps the list it had.
    act(() => setDeletedBotIds(new Set(["bot-release"])));
    act(() =>
      setList({
        status: "error",
        bots: [RELEASE],
        mainBotIds: null,
        hasData: true,
      }),
    );
    await screen.findByTestId("bot-tab-no-channel");
    for (let flush = 0; flush < 3; flush += 1) {
      await act(() => Promise.resolve());
    }
    expect(screen.getByTestId("bot-tab-no-channel")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(useTracySurfaceStore.getState().botId).toBeNull();
    expect(mocks.opened.length).toBe(opensBefore);

    // A list that answered, without the bot, leaves nothing to select.
    act(() => {
      setListUpdatedAt(2_000);
      answerList([], null);
    });
    await screen.findByTestId("bot-tab-no-channel");
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    // A list that answers with the bot again was a false alarm.
    act(() => {
      setListUpdatedAt(3_000);
      setDeletedBotIds(new Set());
      answerList([RELEASE], null);
    });
    await shownChannel("bot-release");
    expect(screen.queryByTestId("bot-tab-no-channel")).toBeNull();
  });

  describe("no channel selected while the lists have not answered", () => {
    it.each([
      {
        failing: "bot list",
        fail: (): void => {
          setEnvironmentsRead({ status: "success", hasData: true });
          setList({
            status: "error",
            bots: [],
            mainBotIds: null,
            hasData: false,
          });
        },
        // Retry asks both lists again; the failed one answers this time.
        answerOnRetry: (): void => {
          script.refetch.bots.mockImplementation(() =>
            answerList([NOTES, RELEASE], { "env-me": "bot-notes" }),
          );
        },
      },
      {
        failing: "environment list",
        fail: (): void => {
          answerList([NOTES, RELEASE], { "env-me": "bot-notes" });
          setEnvironmentsRead({ status: "error", hasData: false });
        },
        answerOnRetry: (): void => {
          script.refetch.environments.mockImplementation(() =>
            setEnvironmentsRead({ status: "success", hasData: true }),
          );
        },
      },
    ])(
      "shows the failure with a Retry when the $failing fails before answering, and Retry selects the default once both answer",
      async ({ fail, answerOnRetry }) => {
        fail();
        const mounted = await mount();
        act(() => {
          openTracyEntry(mounted.navigate, null);
        });

        const notice = await screen.findByTestId("bot-tab-error");
        expect(
          within(notice).getByText("Couldn't load this channel."),
        ).toBeTruthy();
        expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
        expect(screen.queryByTestId("bot-tab-no-channel")).toBeNull();
        expect(useTracySurfaceStore.getState().botId).toBeNull();

        answerOnRetry();
        fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

        expect(script.refetch.bots).toHaveBeenCalledTimes(1);
        expect(script.refetch.environments).toHaveBeenCalledTimes(1);
        await shownChannel("bot-notes");
        expect({
          pathname: mounted.pathname(),
          botId: useTracySurfaceStore.getState().botId,
        }).toEqual({ pathname: "/bot/bot-notes", botId: "bot-notes" });
        expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      },
    );

    it("shows the connecting state while the lists have not answered", async () => {
      setEnvironmentsRead({ status: "pending", hasData: false });
      const mounted = await mount();
      act(() => {
        openTracyEntry(mounted.navigate, null);
      });

      await screen.findByTestId("bot-tab-connecting");
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(screen.queryByTestId("bot-tab-no-channel")).toBeNull();
      expect(useTracySurfaceStore.getState().botId).toBeNull();
    });
  });

  describe("an explicit open that is still in flight", () => {
    /**
     * The surface is open and rendered with the lists answered while the
     * navigation that opened it has not been acknowledged: what the shell
     * sees is no selected channel and a default it could choose.
     */
    async function openHeld(
      mounted: Mounted,
      held: HeldNavigation,
      startPath: string,
    ): Promise<void> {
      act(() => {
        openBotChannel(held.navigate, "bot-release", {
          landing: null,
          isConnectable: null,
          onRejected: null,
        });
      });
      await screen.findByTestId("bot-channel-sidebar");
      expect(row("bot-notes")).toBeTruthy();
      expect(row("bot-release")).toBeTruthy();
      // The shell's effects have run on the committed render.
      await act(() => Promise.resolve());
      expect(tracyNavigationPending()).toBe(true);
      expect(mounted.pathname()).toBe(startPath);
    }

    it("is not superseded by the shell's default channel while the navigation is held, and ends on the opened channel", async () => {
      answerList([NOTES, RELEASE], { "env-me": "bot-notes" });
      const mounted = await mount();
      const selected: Array<string | null> = [];
      const unsubscribe = useTracySurfaceStore.subscribe((state) => {
        selected.push(state.botId);
      });
      const held = holdNavigation(mounted);

      await openHeld(mounted, held, "/");
      expect(useTracySurfaceStore.getState().botId).toBeNull();
      expect(screen.queryByTestId("stub-channel")).toBeNull();

      await act(() => Promise.resolve(held.release()));
      await shownChannel("bot-release");
      unsubscribe();

      expect({
        pathname: mounted.pathname(),
        botId: useTracySurfaceStore.getState().botId,
      }).toEqual({ pathname: "/bot/bot-release", botId: "bot-release" });
      expect(selected).not.toContain("bot-notes");
    });

    it("leaves the URL where it was when the held navigation is refused on a hidden tab, never turning the refused open into a default navigation", async () => {
      answerList([NOTES, RELEASE], { "env-me": "bot-notes" });
      // Home is the tab the window is on, as in the running app: a refused
      // activation returns to it.
      useLayoutStore.setState({ overrides: { homeTab: { shown: "shown" } } });
      const mounted = await mountPaneAware();
      const held = holdNavigation(mounted);

      await openHeld(mounted, held, "/home");
      await act(() => Promise.resolve(held.refuse()));
      await waitFor(() => {
        expect(tracyNavigationPending()).toBe(false);
      });
      await act(() => Promise.resolve());

      expect(mounted.pathname()).toBe("/home");
      expect(mounted.history.length).toBe(1);
      act(() => {
        mounted.history.back();
      });
      expect(mounted.pathname()).toBe("/home");
    });

    it("keeps a thread landing the shown channel observed when another channel is selected before its thread list answers, and lands it on return", async () => {
      const THREAD: BotThreadSummary = {
        threadId: "thread-x",
        conversationId: "conversation-x",
        sessionChatId: "session-x",
        anchor: {
          messageId: "post-of-thread-x",
          requestId: "request-x",
          senderUserId: null,
          sentAt: 1_000,
          resolvedAt: null,
          excerpt: null,
        },
        replyCount: 0,
        lastReplyAt: null,
        openRequestCount: 0,
        costUsd: null,
      };
      answerList([NOTES, RELEASE, TRIAGE], { "env-me": "bot-notes" });
      const mounted = await mount();
      open(mounted, "bot-release");
      await shownChannel("bot-release");
      act(() =>
        setThreadList("bot-release", {
          threads: null,
          isFetching: true,
          isError: false,
        }),
      );
      const held = holdNavigation(mounted);

      // Opening the channel already shown: the landing waits for the list.
      act(() => {
        openBotChannel(held.navigate, "bot-release", {
          landing: { kind: "thread", threadId: "thread-x", messageId: null },
          isConnectable: null,
          onRejected: null,
        });
      });
      expect(tracyNavigationPending()).toBe(true);
      await act(() => Promise.resolve());

      // An arrival from outside supersedes the held open.
      await act(() => mounted.navigate(tracyRoute("bot-triage")));
      await shownChannel("bot-triage");
      await act(() => Promise.resolve());

      expect(keptState("bot-release").landing).toBe(true);

      fireEvent.click(row("bot-release"));
      const channel = await shownChannel("bot-release");
      expect(channel.getAttribute("data-open-thread")).toBe("none");
      act(() =>
        setThreadList("bot-release", {
          threads: [THREAD],
          isFetching: false,
          isError: false,
        }),
      );

      await waitFor(() => {
        expect(channel.getAttribute("data-open-thread")).toBe(
          "post-of-thread-x",
        );
      });
      expect(keptState("bot-release").landing).toBe(false);
    });
  });

  describe("a sender landing held for its channel's thread list", () => {
    const SENDER_CHAT = "session-x";
    const THREAD: BotThreadSummary = {
      threadId: "thread-x",
      conversationId: "conversation-x",
      sessionChatId: SENDER_CHAT,
      anchor: {
        messageId: "post-of-session-x",
        requestId: "request-x",
        senderUserId: null,
        sentAt: 1_000,
        resolvedAt: null,
        excerpt: null,
      },
      replyCount: 0,
      lastReplyAt: null,
      openRequestCount: 0,
      costUsd: null,
    };

    /**
     * The release channel shows, its thread list is held without the sender's
     * thread, and a sender landing waits for it. The person then leaves for
     * triage, and the list answers with the thread while the channel is away.
     */
    async function leaveWithWaitingLanding(): Promise<Mounted> {
      answerList([RELEASE, TRIAGE], null);
      const mounted = await mount();
      open(mounted, "bot-release");
      await shownChannel("bot-release");
      act(() =>
        setThreadList("bot-release", {
          threads: [],
          isFetching: true,
          isError: false,
        }),
      );
      act(() =>
        useBotTabLandingStore
          .getState()
          .request("bot-release", { kind: "sender", chatId: SENDER_CHAT }),
      );
      expect(keptState("bot-release").landing).toBe(true);
      expect(
        screen.getByTestId("stub-channel").getAttribute("data-open-thread"),
      ).toBe("none");

      fireEvent.click(row("bot-triage"));
      await shownChannel("bot-triage");
      act(() =>
        setThreadList("bot-release", {
          threads: [THREAD],
          isFetching: false,
          isError: false,
        }),
      );
      return mounted;
    }

    it("spends a waiting sender landing unlanded when its channel is left, so returning does not open its thread", async () => {
      await leaveWithWaitingLanding();

      fireEvent.click(row("bot-release"));

      const channel = await shownChannel("bot-release");
      expect(keptState("bot-release").landing).toBe(false);
      expect(channel.getAttribute("data-open-thread")).toBe("none");
    });

    it("leaves a newer request of the channel to be spent by it on return", async () => {
      await leaveWithWaitingLanding();
      // An opener staging the next landing before it navigates back.
      act(() =>
        useBotTabLandingStore
          .getState()
          .request("bot-release", { kind: "sender", chatId: SENDER_CHAT }),
      );
      expect(keptState("bot-release").landing).toBe(true);

      fireEvent.click(row("bot-release"));

      const channel = await shownChannel("bot-release");
      await waitFor(() => {
        expect(channel.getAttribute("data-open-thread")).toBe(
          "post-of-session-x",
        );
      });
      expect(keptState("bot-release").landing).toBe(false);
    });
  });
});
