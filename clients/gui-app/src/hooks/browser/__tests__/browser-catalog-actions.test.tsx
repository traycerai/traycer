import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BrowserCatalogIdentity,
  BrowserCatalogRecord,
} from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserCatalogQueryData } from "../use-browser-catalog-inventory";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const mocks = vi.hoisted(() => ({
  unavailability: vi.fn<(entry: unknown) => string | null>(),
  readyRemote: vi.fn<(hostId: string) => boolean>(),
  closeTab: vi.fn<(args: unknown) => Promise<void>>(),
  runAction: vi.fn<(args: unknown) => Promise<unknown>>(),
  findById: vi.fn<(hostId: string) => { hostId: string } | null>(),
  liveUserId: vi.fn<() => string | null>(),
  userId: vi.fn<() => string | null>(),
}));

vi.mock(
  "@traycer-clients/shared/host-client/remote-fetcher",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/remote-fetcher")
      >();
    return { ...actual, hostUnavailability: mocks.unavailability };
  },
);
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: mocks.readyRemote,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ getRequestContextUserId: mocks.liveUserId }),
  useHostDirectory: () => ({ findById: mocks.findById }),
}));
vi.mock("@/hooks/host/use-request-context-user-id", () => ({
  useRequestContextUserId: () => mocks.userId(),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => null,
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => ({
    wsStreamClient: null,
    close: () => undefined,
  }),
}));
vi.mock("@/lib/host/transport-key", () => ({
  remoteAwareOwnerIdentityKey: () => "identity-1",
}));
vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  jarBridgeForHost: () => null,
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => () => null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: null }),
}));
vi.mock("@/lib/browser-view/sessions/browser-catalog-owner-action", () => ({
  closeBrowserCatalogTab: mocks.closeTab,
  runBrowserCatalogOwnerAction: mocks.runAction,
}));

import { useBrowserCatalogActions } from "../use-browser-catalog-actions";
import { useBrowserCatalogInventory } from "../use-browser-catalog-inventory";

const identity: BrowserCatalogIdentity = {
  epicId: "epic-1",
  hostId: "host-owner",
  sessionId: "session-1",
};

const record: BrowserCatalogRecord = {
  ...identity,
  inventoryRevision: 4,
  lastActivityAt: 100,
  tabs: [{ tabId: "tab-1", title: "Docs", url: "https://example.com" }],
};

function catalogData(): BrowserCatalogQueryData {
  return { scope: "cloud", records: [record], unavailable: false };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function renderActions(queryClient: QueryClient) {
  return renderHook(() => useBrowserCatalogActions("epic-1"), {
    wrapper: wrapper(queryClient),
  });
}

function renderActionsWithNewCache() {
  return renderActions(createQueryClient());
}

describe("useBrowserCatalogActions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.userId.mockReturnValue("user-1");
    mocks.liveUserId.mockReturnValue("user-1");
    mocks.findById.mockReturnValue({ hostId: identity.hostId });
    mocks.unavailability.mockReturnValue(null);
    mocks.readyRemote.mockReturnValue(false);
    mocks.closeTab.mockResolvedValue(undefined);
    mocks.runAction.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("refuses a Close on a known-offline device without dialing it", async () => {
    mocks.unavailability.mockReturnValue("offline");

    await expect(
      renderActionsWithNewCache().result.current.closeTab(identity, "tab-1"),
    ).rejects.toThrow("This device is offline.");

    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("lets an offline-looking device through when a remote session is already ready", async () => {
    mocks.unavailability.mockReturnValue("offline");
    mocks.readyRemote.mockReturnValue(true);

    await renderActionsWithNewCache().result.current.closeTab(
      identity,
      "tab-1",
    );

    expect(mocks.closeTab).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        tabId: "tab-1",
        owner: { hostId: identity.hostId, identityKey: "identity-1" },
      }),
    );
  });

  it("attempts a Close when reachability is unknown and reports the failure", async () => {
    mocks.closeTab.mockRejectedValue(
      new Error("Browser sessions request timed out."),
    );

    await expect(
      renderActionsWithNewCache().result.current.closeTab(identity, "tab-1"),
    ).rejects.toThrow("Browser sessions request timed out.");

    expect(mocks.closeTab).toHaveBeenCalledTimes(1);
  });

  it("refuses a tab that belongs to another task", async () => {
    await expect(
      renderActionsWithNewCache().result.current.closeTab(
        { ...identity, epicId: "epic-2" },
        "tab-1",
      ),
    ).rejects.toThrow();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("refuses when the signed-in account changed since render", async () => {
    mocks.liveUserId.mockReturnValue("user-2");

    await expect(
      renderActionsWithNewCache().result.current.closeTab(identity, "tab-1"),
    ).rejects.toThrow("Sign in");
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("refuses a device missing from the directory", async () => {
    mocks.findById.mockReturnValue(null);

    await expect(
      renderActionsWithNewCache().result.current.closeTab(identity, "tab-1"),
    ).rejects.toThrow();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("runs other owner actions and refuses an offline owner", async () => {
    const action = vi.fn(() => Promise.resolve("done"));
    await renderActionsWithNewCache().result.current.withOwner(
      identity.hostId,
      action,
    );
    expect(mocks.runAction).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "epic-1", action }),
    );

    mocks.unavailability.mockReturnValue("offline");
    await expect(
      renderActionsWithNewCache().result.current.withOwner(
        identity.hostId,
        action,
      ),
    ).rejects.toThrow("This device is offline.");
  });

  it("removes the closed row from this viewer's catalog cache and invalidates its reader slots", async () => {
    const queryClient = createQueryClient();
    const firstReaderKey = hostQueryKeys.browserCatalog(
      "reader-1",
      "epic-1",
      "user-1",
    );
    const secondReaderKey = hostQueryKeys.browserCatalog(
      "reader-2",
      "epic-1",
      "user-1",
    );
    const otherTaskKey = hostQueryKeys.browserCatalog(
      "reader-1",
      "epic-2",
      "user-1",
    );
    queryClient.setQueryData<BrowserCatalogQueryData>(
      firstReaderKey,
      catalogData(),
    );
    queryClient.setQueryData<BrowserCatalogQueryData>(
      secondReaderKey,
      catalogData(),
    );
    queryClient.setQueryData<BrowserCatalogQueryData>(
      otherTaskKey,
      catalogData(),
    );
    const { result } = renderActions(queryClient);

    await act(async () => {
      await result.current.closeTab(identity, "tab-1");
    });

    expect(mocks.closeTab).toHaveBeenCalledWith(
      expect.objectContaining({ identity, tabId: "tab-1" }),
    );
    expect(
      queryClient.getQueryData<BrowserCatalogQueryData>(firstReaderKey)
        ?.records,
    ).toEqual([]);
    expect(
      queryClient.getQueryData<BrowserCatalogQueryData>(secondReaderKey)
        ?.records,
    ).toEqual([]);
    expect(queryClient.getQueryState(firstReaderKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(secondReaderKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryData<BrowserCatalogQueryData>(otherTaskKey)?.records,
    ).toEqual([record]);
    expect(queryClient.getQueryState(otherTaskKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });

  it("keeps a closed tab gone when the next catalog read still lists it", async () => {
    const staleRecord: BrowserCatalogRecord = {
      ...record,
      sessionId: "session-stale",
      tabs: [
        { tabId: "tab-closed", title: "Closed", url: "https://a.example" },
        { tabId: "tab-kept", title: "Kept", url: "https://b.example" },
      ],
    };
    const read = vi.fn((): BrowserCatalogReadResponse => ({
      kind: "available",
      snapshot: { version: 1, records: [staleRecord] },
    }));
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `catalog-read-${String(read.mock.calls.length)}`,
        handlers: { "browser.catalog.read": read },
      }),
    });
    const context = createRequestContextFixture({ origin: "renderer" });
    spine.setRequestContext(context);
    mocks.userId.mockReturnValue(context.identity.userId);
    mocks.liveUserId.mockReturnValue(context.identity.userId);
    const readerClient = spine.createRequester(mockLocalHostEntry);
    const queryClient = createQueryClient();
    const { result } = renderHook(
      () => ({
        actions: useBrowserCatalogActions("epic-1"),
        inventory: useBrowserCatalogInventory({
          epicId: "epic-1",
          readerClient,
        }),
      }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() =>
      expect(result.current.inventory.records[0]?.tabs).toHaveLength(2),
    );

    await act(async () => {
      await result.current.actions.closeTab(
        { ...identity, sessionId: "session-stale" },
        "tab-closed",
      );
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(
      result.current.inventory.records.flatMap((entry) =>
        entry.tabs.map((tab) => tab.tabId),
      ),
    ).toEqual(["tab-kept"]);
    queryClient.clear();
  });
});
