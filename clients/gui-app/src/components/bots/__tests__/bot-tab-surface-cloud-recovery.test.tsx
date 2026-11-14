/**
 * The Tracy tab's `bot.open` when the cloud refuses or cannot be reached: the
 * tab holds its own host's cloud-recovery doorbell for as long as the failure
 * stands, re-opens once per ring, and says "Reconnecting" instead of the raw
 * error. Driven through the real `CloudRecoveryDoorbellMount`.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
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
  tabHostClientMock,
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
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  ScriptedRead,
  hostFailure,
  hostReadKey,
  rejects,
} from "@/lib/host/test-support/cloud-failure-reads";
import { createAppQueryClient } from "@/lib/query-client";
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";
import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import {
  answer,
  BOT_ID,
  endBotTabSurfaceCase,
  resetBotTabSurfaceMocks,
  TAB_HOST,
} from "./bot-tab-surface-harness";

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
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
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
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
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
const OPEN_FAILURE = hostFailure("E_CLOUD_UNREACHABLE", "bot.open");
const RAW_TEXT = OPEN_FAILURE.message;

let queryClient: QueryClient;

function tree(showSurface: boolean): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <CloudRecoveryDoorbellMount />
        {showSurface ? (
          <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
        ) : null}
      </QueryClientProvider>
    </StrictMode>
  );
}

function doorbells() {
  const client = doorbellHosts.clients.get(TAB_HOST);
  if (client === undefined) return [];
  return client.sessions.filter(
    (_session, index) => client.subscribes[index]?.method === METHOD,
  );
}

function liveDoorbells() {
  return doorbells().filter((session) => !session.closed);
}

function ring(): void {
  const session = liveDoorbells().at(-1);
  if (session === undefined) throw new Error("no doorbell open");
  act(() => {
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
  });
}

const opens = (): number => mocks.open.mock.calls.length;

function failTransiently(): void {
  mocks.state.openResult = { kind: "failure", error: OPEN_FAILURE };
}

/** A read of the tab's host that failed transiently and is still observed. */
async function strandedRead(): Promise<ScriptedRead> {
  const made: ScriptedRead[] = [];
  act(() => {
    made.push(
      new ScriptedRead(
        queryClient,
        hostReadKey(TAB_HOST, "bot.list", "stranded"),
        rejects(hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.list")),
      ),
    );
  });
  const read = made.at(0);
  if (read === undefined) throw new Error("read was not created");
  await waitFor(() => expect(read.state.status).toBe("error"));
  return read;
}

function expectReconnecting(): HTMLElement {
  const status = screen.getByTestId("bot-tab-reconnecting");
  expect(status.getAttribute("role")).toBe("status");
  expect(status.textContent).toContain("Reconnecting…");
  expect(screen.queryByTestId("bot-tab-error")).toBeNull();
  expect(document.body.textContent).not.toContain(RAW_TEXT);
  expect(document.body.textContent).not.toContain("Couldn't open this bot");
  return status;
}

beforeEach(() => {
  queryClient = createAppQueryClient();
  resetBotTabSurfaceMocks();
});

afterEach(() => {
  endBotTabSurfaceCase(queryClient);
  cleanup();
  resetHostConnectionRegistryForTest();
  doorbellHosts.clients.clear();
  doorbellHosts.unsupportedHosts.clear();
});

describe("<BotTabSurface /> when bot.open fails on a cloud failure", () => {
  it("holds its host's doorbell, shows Reconnecting, and opens once per ring until it succeeds", async () => {
    failTransiently();
    render(tree(true));

    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    expectReconnecting();
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    const before = opens();
    ring();

    await waitFor(() => expect(opens()).toBe(before + 1));
    await waitFor(() =>
      expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull(),
    );
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    await waitFor(() => expect(liveDoorbells()).toHaveLength(0));
  });

  it("shows Reconnecting above the held channel when a re-open fails after an answer", async () => {
    const view = render(tree(true));
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    failTransiently();
    mocks.state.paneVisible = false;
    view.rerender(tree(true));
    mocks.state.paneVisible = true;
    view.rerender(tree(true));

    const status = expectReconnecting();
    const channel = screen.getByTestId("stub-channel");
    expect(
      status.compareDocumentPosition(channel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    const before = opens();
    ring();
    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("keeps the same doorbell subscription when a ring's re-open fails again", async () => {
    failTransiently();
    render(tree(true));
    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    const held = liveDoorbells().at(0);

    const first = opens();
    ring();
    await waitFor(() => expect(opens()).toBe(first + 1));

    expect(liveDoorbells()).toHaveLength(1);
    expect(liveDoorbells().at(0)).toBe(held);
    expectReconnecting();

    ring();
    await waitFor(() => expect(opens()).toBe(first + 2));
  });

  it("keeps its one doorbell subscription when the host's support goes from unknown to supported, and closes it when unsupported", async () => {
    failTransiently();
    render(tree(true));
    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    const client = doorbellHosts.clients.get(TAB_HOST);
    if (client === undefined) throw new Error("no stream client for the host");
    const held = liveDoorbells().at(0);
    const dialed = doorbells().length;
    const before = opens();

    act(() => {
      client.setMethodSupport("supported");
    });

    expect(liveDoorbells()).toHaveLength(1);
    expect(liveDoorbells().at(0)).toBe(held);
    expect(doorbells()).toHaveLength(dialed);
    expect(opens()).toBe(before);

    act(() => {
      client.setMethodSupport("unsupported");
    });

    await waitFor(() => expect(liveDoorbells()).toHaveLength(0));
  });

  it("releases the doorbell when the tab unmounts", async () => {
    failTransiently();
    const view = render(tree(true));
    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));

    view.rerender(tree(false));

    await waitFor(() => expect(liveDoorbells()).toHaveLength(0));
  });

  it("offers a Retry that opens again on a host without the doorbell", async () => {
    const user = userEvent.setup();
    doorbellHosts.unsupportedHosts.add(TAB_HOST);
    failTransiently();
    render(tree(true));

    const status = expectReconnecting();
    expect(doorbells()).toHaveLength(0);

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    const before = opens();
    await user.click(within(status).getByRole("button", { name: "Retry" }));

    expect(opens()).toBe(before + 1);
    expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
  });
});

describe("<BotTabSurface /> doorbell rings that must not open the bot", () => {
  it("keeps the error and opens nothing on a ring when the failure is not a cloud failure", async () => {
    mocks.state.openResult = {
      kind: "failure",
      error: hostFailure("RPC_ERROR", "bot.open"),
    };
    render(tree(true));

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain("Couldn't open this bot:");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-reconnecting")).toBeNull();
    expect(doorbells()).toHaveLength(0);

    const read = await strandedRead();
    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    const before = opens();
    ring();
    await waitFor(() => expect(read.calls).toBe(2));

    expect(opens()).toBe(before);
    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
  });

  it("opens nothing on a ring when the last open succeeded", async () => {
    render(tree(true));
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    const read = await strandedRead();
    await waitFor(() => expect(liveDoorbells()).toHaveLength(1));
    const before = opens();
    ring();
    await waitFor(() => expect(read.calls).toBe(2));

    expect(opens()).toBe(before);
  });
});
