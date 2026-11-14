/**
 * The Tracy tab's re-opens over the REAL `useBotOpenMutation` and a host
 * client whose `bot.open` the case holds and settles in the order it chooses:
 * a ring while an open is in flight, a transient failure followed by a
 * permanent one, and the bot list re-read once per settled open.
 */
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
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
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
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";
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

const doorbellHosts = vi.hoisted(
  (): {
    readonly clients: Map<string, FakeStreamClient>;
    readonly unsupportedHosts: Set<string>;
  } => ({
    clients: new Map(),
    unsupportedHosts: new Set(),
  }),
);

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
      const existing = doorbellHosts.clients.get(target.hostId);
      if (existing !== undefined) return existing;
      const created = new Fake(true);
      if (doorbellHosts.unsupportedHosts.has(target.hostId)) {
        created.methodSupport = "unsupported";
      }
      doorbellHosts.clients.set(target.hostId, created);
      return created;
    },
  };
});

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

const METHOD = "cloud.recovered.subscribe";
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
    schedulingPolicy: hostRpcSchedulingPolicy,
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

function liveDoorbells() {
  const client = doorbellHosts.clients.get(TAB_HOST);
  if (client === undefined) return [];
  return client.sessions.filter(
    (session, index) =>
      client.subscribes[index]?.method === METHOD && !session.closed,
  );
}

function ring(): void {
  const session = liveDoorbells().at(-1);
  if (session === undefined) throw new Error("no doorbell open");
  act(() => {
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
  });
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
    expect(liveDoorbells()).toHaveLength(1);
  });
  return opens.length;
}

async function ringAsking(expected: number): Promise<void> {
  ring();
  await waitFor(() => expect(opens).toHaveLength(expected));
}

function expectChannelOnly(): void {
  expect(screen.getByTestId("stub-channel")).toBeTruthy();
  expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
  expect(screen.queryByTestId("bot-tab-error")).toBeNull();
}

beforeEach(() => {
  queryClient = createAppQueryClient();
  opens = [];
  openHost.client = hostClientHoldingOpens(queryClient);
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
  cleanup();
  openHost.client = null;
  resetHostConnectionRegistryForTest();
  doorbellHosts.clients.clear();
  doorbellHosts.unsupportedHosts.clear();
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

      ring();
      await act(async () => {
        await Promise.resolve();
      });
      expect(opens).toHaveLength(mounted + 1);

      await settle(heldOpen(mounted), (open) => open.reject(error));
      await waitFor(() => expect(opens).toHaveLength(mounted + 2));
      expect(screen.getByTestId("bot-tab-reconnecting")).toBeTruthy();
      expect(screen.queryByTestId("bot-tab-error")).toBeNull();
      expect(liveDoorbells()).toHaveLength(1);

      await settle(heldOpen(mounted + 1), (open) => open.resolve(SERVING));
      await waitFor(() => expectChannelOnly());
      await waitFor(() => expect(liveDoorbells()).toHaveLength(0));
    },
  );
});

describe("<BotTabSurface /> when a re-open fails for another reason", () => {
  it("releases the doorbell and shows the error with Retry", async () => {
    render(tree());
    const mounted = await failMountOpens(TRANSIENT);
    await ringAsking(mounted + 1);

    await settle(heldOpen(mounted), (open) => open.reject(PERMANENT));

    await waitFor(() => expect(liveDoorbells()).toHaveLength(0));
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(list.calls).toBe(2 + mounted);
  });
});
