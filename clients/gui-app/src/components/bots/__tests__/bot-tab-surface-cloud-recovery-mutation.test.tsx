/**
 * The Tracy tab's re-opens over the REAL `useBotOpenMutation` and a host
 * client whose `bot.open` the case holds and settles in the order it chooses:
 * a ring while an open is in flight, a transient failure followed by a
 * permanent one, a ring that comes before the host or React has seen the open
 * begin, and the bot list re-read once per settled open.
 */
import {
  doorbellHostDirectoryEntryMock,
  doorbellHosts,
  doorbellStreamAuthRevalidatorMock,
  doorbellStreamClientForMock,
  liveDoorbellsOf,
  resetDoorbellHosts,
  ringDoorbell,
} from "@/providers/__tests__/cloud-recovery-doorbell-test-support";
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { StrictMode, type ReactNode } from "react";
import {
  QueryClientProvider,
  defaultScheduler,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  type RenderResult,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  ScriptedRead,
  hostFailure,
  hostReadKey,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { BotOpenResponse } from "@traycer/protocol/host/bot/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { botMutationKeys } from "@/lib/query-keys";
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";
import { useCloudRecoveryRing } from "@/hooks/host/use-cloud-recovery-ring";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import {
  BOT,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  TAB_HOST,
} from "./bot-tab-surface-harness";

const openHost = vi.hoisted(
  (): { client: HostRequester<HostRpcRegistry> | null } => ({ client: null }),
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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);
vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => openHost.client,
}));
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => <div data-testid="stub-sidebar" />,
}));
vi.mock("@/components/bots/bot-channel-view", () => ({
  BotChannelView: () => <div data-testid="stub-channel" />,
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

const TRANSIENT = hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.open");
const PERMANENT = hostFailure("RPC_ERROR", "bot.open");
const SERVING: BotOpenResponse = {
  bot: BOT,
  outcome: { kind: "serve-here", claimed: null },
};

/** One `bot.open` the host has been asked and not yet answered. */
interface HeldOpen {
  settled: boolean;
  resolve: (response: BotOpenResponse) => void;
  reject: (error: Error) => void;
}

let queryClient: QueryClient;
let opens: HeldOpen[];
let openSubmissions: number;
/** Runs in the step the host receives a `bot.open`, before the case can look. */
let onOpenReachedHost: () => void;

/** Rings the doorbell in the step the host receives the next `bot.open`. */
function ringWhenNextOpenReachesHost(): void {
  onOpenReachedHost = () => {
    onOpenReachedHost = () => undefined;
    ringDoorbell(TAB_HOST);
  };
}

/** A real host client whose `bot.open` stays open until the case settles it. */
function hostClientHoldingOpens(
  client: QueryClient,
): HostRequester<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.open": () =>
        new Promise<BotOpenResponse>((resolve, reject) => {
          onOpenReachedHost();
          const held: HeldOpen = {
            settled: false,
            resolve: (response) => {
              held.settled = true;
              resolve(response);
            },
            reject: (error) => {
              held.settled = true;
              reject(error);
            },
          };
          opens.push(held);
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    // The app's own scheduling: `bot.open` is `fifo`, so a second open waits
    // for the first to settle.
    schedulingPolicy: {
      ...hostRpcSchedulingPolicy,
      // The coordinator reads the mode in the same synchronous step that puts
      // the request in its lane, so this counts opens handed to the lane.
      modeFor(method, params) {
        if (method === "bot.open") openSubmissions += 1;
        return hostRpcSchedulingPolicy.modeFor(method, params);
      },
    },
    invalidator: createHostQueryInvalidator(client),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

function tree(): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CloudRecoveryDoorbellMount />
        <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

/** Another caller that holds the doorbell of the tab's host, as a stranded read or another tab does. */
function OtherHolder(props: { readonly onRing: () => void }): ReactNode {
  useCloudRecoveryRing({
    hostId: TAB_HOST,
    held: true,
    call: props.onRing,
  });
  return null;
}

function treeWithOtherHolder(onRing: () => void): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CloudRecoveryDoorbellMount />
        <OtherHolder onRing={onRing} />
        <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
      </QueryClientProvider>
    </StrictMode>
  );
}

/** The doorbell and its other holder alone, before any tab asks. */
function otherHolderOnlyTree(onRing: () => void): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CloudRecoveryDoorbellMount />
        <OtherHolder onRing={onRing} />
      </QueryClientProvider>
    </StrictMode>
  );
}

async function settle(held: HeldOpen, settle: (held: HeldOpen) => void) {
  await act(async () => {
    settle(held);
    await Promise.resolve();
  });
}

function heldOpen(index: number): HeldOpen {
  const held = opens.at(index);
  if (held === undefined) throw new Error(`open #${String(index)} not asked`);
  return held;
}

/**
 * Fails every open the mount asks (StrictMode asks twice, the second a tick
 * after the first) until the doorbell is held; returns how many it asked.
 */
async function failMountOpens(error: Error): Promise<number> {
  await waitFor(() => expect(opens.length).toBeGreaterThan(0));
  await waitFor(async () => {
    for (const held of opens.filter((open) => !open.settled)) {
      await settle(held, (open) => open.reject(error));
    }
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);
  });
  return opens.length;
}

async function ringAsking(expected: number): Promise<void> {
  ringDoorbell(TAB_HOST);
  await waitFor(() => expect(opens).toHaveLength(expected));
}

async function rejectPendingOpens(error: Error): Promise<void> {
  for (const held of opens.filter((open) => !open.settled)) {
    await settle(held, (open) => open.reject(error));
  }
}

/**
 * Presses Retry twice while the open the first press started is held, then
 * fails it. No `bot.open` is in flight afterwards: a second press that had
 * opened would still be queued behind the first, or held at the host.
 */
async function pressRetryTwiceWhileHeld(): Promise<void> {
  const user = userEvent.setup();
  const asked = opens.length;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(opens).toHaveLength(asked + 1));

  const retry = screen.getByRole("button", { name: "Retry" });
  const disabledWhileHeld = retry.hasAttribute("disabled");
  await user.click(retry);

  await settle(heldOpen(asked), (open) => open.reject(TRANSIENT));
  await waitFor(() =>
    expect(
      queryClient.isMutating({ mutationKey: botMutationKeys.open() }),
    ).toBe(0),
  );
  expect(opens).toHaveLength(asked + 1);
  expect(disabledWhileHeld).toBe(true);
}

function expectChannelOnly(): void {
  expect(screen.getByTestId("stub-channel")).toBeTruthy();
  expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
  expect(screen.queryByTestId("bot-tab-error")).toBeNull();
}

/**
 * TanStack dispatches a mutation's `pending` at once but tells React of it
 * from a scheduled task, after the request has been sent. Holding that task
 * keeps React on the state before the open began, as it is for a moment in
 * the app. Every case restores the default scheduler in `afterEach`.
 */
const heldNotices: Array<() => void> = [];

function holdNotices(): void {
  notifyManager.setScheduler((notify) => {
    heldNotices.push(notify);
  });
}

function releaseNotices(): void {
  notifyManager.setScheduler(defaultScheduler);
  act(() => {
    for (const notify of heldNotices.splice(0)) notify();
  });
}

/** Brings the pane back into view, which opens the bot again. */
function visibilityReopen(view: RenderResult, onRing: () => void): void {
  mocks.state.paneVisible = false;
  view.rerender(treeWithOtherHolder(onRing));
  mocks.state.paneVisible = true;
  view.rerender(treeWithOtherHolder(onRing));
}

/**
 * Fails the mount's opens one at a time until the tab shows Reconnecting,
 * then stops: whatever the tab asks after that is the re-open under test.
 * Returns how many mount opens it failed.
 */
async function failMountOpensUntilReconnecting(): Promise<number> {
  let failed = 0;
  await waitFor(async () => {
    const next = opens.find((open) => !open.settled);
    if (next !== undefined) {
      await settle(next, (open) => open.reject(TRANSIENT));
      failed += 1;
    }
    expect(screen.queryByTestId("bot-tab-reconnecting")).not.toBeNull();
  });
  return failed;
}

/**
 * Settles the opens the mount asked and no other: every one of them is handed
 * to the lane before the first reaches the host, and the next reaches the host
 * only once the one before it settles. An open asked after that stays
 * unsettled, keeps the wait for idle from passing, and is not counted.
 */
async function settleMountOpensUntilIdle(
  settleOpen: (open: HeldOpen) => void,
): Promise<number> {
  await waitFor(() => expect(opens.length).toBeGreaterThan(0));
  const asked = openSubmissions;
  for (let index = 0; index < asked; index += 1) {
    await waitFor(() => expect(opens.length).toBeGreaterThan(index));
    await settle(heldOpen(index), settleOpen);
  }
  await waitForNoOpenInFlight();
  return asked;
}

async function waitForOpenCount(count: number): Promise<void> {
  await waitFor(() => expect(opens).toHaveLength(count));
}

async function waitForNoOpenInFlight(): Promise<void> {
  await waitFor(() =>
    expect(
      queryClient.isMutating({ mutationKey: botMutationKeys.open() }),
    ).toBe(0),
  );
}

/** One re-open follows `asked` opens, which it settles, and no other. */
async function expectExactlyOneReopenAfter(asked: number): Promise<void> {
  await waitForOpenCount(asked + 1);
  await settle(heldOpen(asked), (open) => open.resolve(SERVING));
  await waitForNoOpenInFlight();
  expect(opens).toHaveLength(asked + 1);
}

beforeEach(() => {
  queryClient = createAppQueryClient();
  opens = [];
  openSubmissions = 0;
  onOpenReachedHost = () => undefined;
  openHost.client = hostClientHoldingOpens(queryClient);
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  notifyManager.setScheduler(defaultScheduler);
  heldNotices.length = 0;
  endBotTabSurfaceCase(queryClient);
  cleanup();
  openHost.client = null;
  resetHostConnectionRegistryForTest();
  resetDoorbellHosts();
});

describe("<BotTabSurface /> a ring while a re-open is in flight", () => {
  it.each([
    ["transiently", TRANSIENT],
    ["non-transiently", PERMANENT],
  ])(
    "holds the second open behind the first, ignores the first's %s failure and shows the second's answer",
    async (_name, error) => {
      render(tree());
      const mounted = await failMountOpens(TRANSIENT);
      await ringAsking(mounted + 1);

      const submitted = openSubmissions;
      ringDoorbell(TAB_HOST);
      await waitFor(() => expect(openSubmissions).toBe(submitted + 1));
      expect(opens).toHaveLength(mounted + 1);

      await settle(heldOpen(mounted), (open) => open.reject(error));
      await waitFor(() => expect(opens).toHaveLength(mounted + 2));
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);

      await settle(heldOpen(mounted + 1), (open) => open.resolve(SERVING));
      await waitFor(() => expectChannelOnly());
      await waitFor(() => expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(0));
    },
  );
});

describe("<BotTabSurface /> when a re-open fails for another reason", () => {
  it("releases the doorbell and shows the error with Retry", async () => {
    render(tree());
    const mounted = await failMountOpens(TRANSIENT);
    await ringAsking(mounted + 1);

    await settle(heldOpen(mounted), (open) => open.reject(PERMANENT));

    await waitFor(() => expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(0));
    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain(
      `Couldn't open this bot: ${PERMANENT.message}`,
    );
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
  });
});

describe("<BotTabSurface /> bot list after an open settles", () => {
  it("re-asks an observed bot.list once per settled open", async () => {
    const made: ScriptedRead[] = [];
    act(() => {
      made.push(
        new ScriptedRead(
          queryClient,
          hostReadKey(TAB_HOST, "bot.list", "observed"),
          resolves("listed"),
        ),
      );
    });
    const list = made.at(0);
    if (list === undefined) throw new Error("read was not created");
    await waitFor(() => expect(list.calls).toBe(1));

    render(tree());
    const mounted = await failMountOpens(TRANSIENT);
    await waitFor(() => expect(list.calls).toBe(1 + mounted));

    await ringAsking(mounted + 1);
    await settle(heldOpen(mounted), (open) => open.resolve(SERVING));

    await waitFor(() => expect(list.calls).toBe(2 + mounted));
    await waitFor(() => {
      expect(
        queryClient.isMutating({ mutationKey: botMutationKeys.open() }),
      ).toBe(0);
      expect(queryClient.isFetching({ queryKey: list.queryKey })).toBe(0);
    });
    expect(list.calls).toBe(2 + mounted);
  });
});

describe("<BotTabSurface /> Retry while a re-open is in flight", () => {
  beforeEach(() => {
    doorbellHosts.unsupportedHosts.add(TAB_HOST);
  });

  it("is disabled and sends one bot.open for two presses when no answer is held", async () => {
    render(tree());
    await waitFor(() => expect(opens.length).toBeGreaterThan(0));
    await waitFor(async () => {
      await rejectPendingOpens(TRANSIENT);
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy();
    });

    await pressRetryTwiceWhileHeld();
  });

  it("is disabled and sends one bot.open for two presses above a held channel", async () => {
    const view = render(tree());
    await waitFor(() => expect(opens.length).toBeGreaterThan(0));
    await waitFor(async () => {
      for (const held of opens.filter((open) => !open.settled)) {
        await settle(held, (open) => open.resolve(SERVING));
      }
      expectChannelOnly();
    });

    mocks.state.paneVisible = false;
    view.rerender(tree());
    mocks.state.paneVisible = true;
    view.rerender(tree());
    await waitFor(() => expect(opens.some((open) => !open.settled)).toBe(true));
    await rejectPendingOpens(TRANSIENT);
    await waitFor(() =>
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy(),
    );
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    await pressRetryTwiceWhileHeld();
  });
});

describe("<BotTabSurface /> a ring while the first open is in flight", () => {
  /**
   * Another holder keeps the doorbell open, the tab's first open is held at
   * the host, and the doorbell rings once per `rings` before that open settles.
   */
  async function mountAndRing(rings: number): Promise<RenderResult> {
    const otherRings = vi.fn<() => void>();
    const view = render(treeWithOtherHolder(otherRings));
    await waitFor(() => expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1));
    await waitFor(() => expect(opens.length).toBeGreaterThan(0));
    for (let ring = 1; ring <= rings; ring += 1) {
      ringDoorbell(TAB_HOST);
      expect(otherRings).toHaveBeenCalledTimes(ring);
    }
    expect(opens.every((open) => !open.settled)).toBe(true);
    return view;
  }

  it("asks again once when the first open then fails transiently", async () => {
    await mountAndRing(1);
    const mounted = await failMountOpensUntilReconnecting();
    expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy();
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);

    await waitFor(() => expect(opens).toHaveLength(mounted + 1));
    await settle(heldOpen(mounted), (open) => open.resolve(SERVING));
    await waitFor(() => expectChannelOnly());
    await waitFor(() =>
      expect(
        queryClient.isMutating({ mutationKey: botMutationKeys.open() }),
      ).toBe(0),
    );
    expect(opens).toHaveLength(mounted + 1);
  });

  it("asks again once, not once per ring, when several rings came before the transient failure", async () => {
    await mountAndRing(3);
    const mounted = await failMountOpensUntilReconnecting();

    await waitFor(() => expect(opens).toHaveLength(mounted + 1));
    await settle(heldOpen(mounted), (open) => open.reject(TRANSIENT));
    await waitFor(() =>
      expect(
        queryClient.isMutating({ mutationKey: botMutationKeys.open() }),
      ).toBe(0),
    );
    expect(opens).toHaveLength(mounted + 1);
  });

  it("makes no extra open when the first open then succeeds", async () => {
    await mountAndRing(1);
    const mounted = await settleMountOpensUntilIdle((open) =>
      open.resolve(SERVING),
    );

    await waitFor(() => expectChannelOnly());
    expect(opens).toHaveLength(mounted);
  });

  it("spends no ring owed to an earlier open that succeeded when a later open fails transiently", async () => {
    const view = await mountAndRing(1);
    const mounted = await settleMountOpensUntilIdle((open) =>
      open.resolve(SERVING),
    );
    await waitFor(() => expectChannelOnly());

    visibilityReopen(view, vi.fn<() => void>());
    await waitFor(() => expect(opens.some((open) => !open.settled)).toBe(true));
    await rejectPendingOpens(TRANSIENT);
    await waitFor(() =>
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy(),
    );
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);

    const reopened = opens.length;
    expect(reopened).toBeGreaterThan(mounted);
    await waitForNoOpenInFlight();
    expect(opens).toHaveLength(reopened);
  });

  it("makes no extra open and shows the error with Retry when the first open then fails non-transiently", async () => {
    await mountAndRing(1);
    const mounted = await settleMountOpensUntilIdle((open) =>
      open.reject(PERMANENT),
    );

    const alert = screen.getByTestId("bot-tab-error");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
    expect(opens).toHaveLength(mounted);
  });
});

describe("<BotTabSurface /> a ring around the start of an open", () => {
  /** A healthy tab beside another holder of the doorbell, every mount open served. */
  async function mountHealthy(): Promise<{
    view: RenderResult;
    otherRings: Mock<() => void>;
    served: number;
  }> {
    const otherRings = vi.fn<() => void>();
    const view = render(treeWithOtherHolder(otherRings));
    await waitFor(() => expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1));
    const served = await settleMountOpensUntilIdle((open) =>
      open.resolve(SERVING),
    );
    expectChannelOnly();
    return { view, otherRings, served };
  }

  function ringHeardByOtherHolder(otherRings: Mock<() => void>): void {
    const before = otherRings.mock.calls.length;
    ringDoorbell(TAB_HOST);
    expect(otherRings).toHaveBeenCalledTimes(before + 1);
  }

  /**
   * After the `served` mount opens, an open A reaches the host and React
   * renders it pending, the doorbell rings, and a second open B is handed to
   * the lane behind A. `ringWhileQueued` rings once more after B was handed
   * over. A fails first, which sends B; B then fails.
   */
  async function failQueuedOpen(
    input: {
      view: RenderResult;
      otherRings: Mock<() => void>;
      served: number;
    },
    ringWhileQueued: boolean,
  ): Promise<void> {
    const { view, otherRings, served } = input;
    holdNotices();
    visibilityReopen(view, otherRings);
    await waitForOpenCount(served + 1);
    releaseNotices();
    ringHeardByOtherHolder(otherRings);

    const submitted = openSubmissions;
    visibilityReopen(view, otherRings);
    await waitFor(() => expect(openSubmissions).toBe(submitted + 1));
    expect(opens).toHaveLength(served + 1);
    if (ringWhileQueued) ringHeardByOtherHolder(otherRings);

    await settle(heldOpen(served), (open) => open.reject(TRANSIENT));
    await waitForOpenCount(served + 2);
    await settle(heldOpen(served + 1), (open) => open.reject(TRANSIENT));
    await waitFor(() =>
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy(),
    );
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);
  }

  it("asks again once for a ring that came as the first open reached the host", async () => {
    const otherRings = vi.fn<() => void>();
    const view = render(otherHolderOnlyTree(otherRings));
    await waitFor(() => expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1));

    ringWhenNextOpenReachesHost();
    view.rerender(treeWithOtherHolder(otherRings));
    await waitFor(() => expect(opens.length).toBeGreaterThan(0));
    expect(otherRings).toHaveBeenCalledTimes(1);

    const mounted = await failMountOpensUntilReconnecting();
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);
    await expectExactlyOneReopenAfter(mounted);
  });

  it("asks again once for a ring that came as the re-open reached the host, before React rendered it", async () => {
    const { view, otherRings, served } = await mountHealthy();

    holdNotices();
    const heardBefore = otherRings.mock.calls.length;
    ringWhenNextOpenReachesHost();
    visibilityReopen(view, otherRings);
    await waitForOpenCount(served + 1);
    expect(otherRings).toHaveBeenCalledTimes(heardBefore + 1);
    expect(heldNotices.length).toBeGreaterThan(0);
    releaseNotices();

    await settle(heldOpen(served), (open) => open.reject(TRANSIENT));
    await waitFor(() =>
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy(),
    );
    await expectExactlyOneReopenAfter(served + 1);
  });

  it("owes nothing for a ring that came before a later open began while an earlier one was in flight", async () => {
    const mounted = await mountHealthy();
    await failQueuedOpen(mounted, false);

    await waitForNoOpenInFlight();
    expect(opens).toHaveLength(mounted.served + 2);
  });

  it("asks again once for a ring that came after the later open began, while it waited behind the earlier one", async () => {
    const mounted = await mountHealthy();
    await failQueuedOpen(mounted, true);

    await expectExactlyOneReopenAfter(mounted.served + 2);
  });

  it("forgets a ring that came while no open was in flight when the next open begins", async () => {
    const { view, otherRings, served } = await mountHealthy();

    ringHeardByOtherHolder(otherRings);
    visibilityReopen(view, otherRings);
    await waitForOpenCount(served + 1);
    await settle(heldOpen(served), (open) => open.reject(TRANSIENT));
    await waitFor(() =>
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy(),
    );
    expect(liveDoorbellsOf(TAB_HOST)).toHaveLength(1);

    await waitForNoOpenInFlight();
    expect(opens).toHaveLength(served + 1);
  });
});
