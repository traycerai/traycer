import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHooksStatusResponse } from "@traycer/protocol/host/notifications/host-notifications";
import { ConnectedHookRemovalObservers } from "@/components/notifications/hook-removal-observer";
import { consumePendingHookRemovalNotices } from "@/lib/notifications/hook-removal-notices";

const remote = vi.hoisted<{
  borrowable: Set<string>;
  statusByHost: Map<string, unknown>;
  acquired: string[];
  released: string[];
  unary: Array<{ hostId: string; method: string; params: unknown }>;
}>(() => ({
  borrowable: new Set<string>(),
  statusByHost: new Map<string, unknown>(),
  acquired: [],
  released: [],
  unary: [],
}));
const toasts = vi.hoisted<{
  shown: Array<{ id: string; description: string | undefined }>;
}>(() => ({ shown: [] }));
const directory = vi.hoisted<{ hostIds: string[] }>(() => ({ hostIds: [] }));

vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasBorrowableRemoteSession: (hostId: string) => remote.borrowable.has(hostId),
  subscribeRemoteSessionReadiness: () => () => undefined,
  tryAcquireReadyRemoteSession: (hostId: string) => {
    if (!remote.borrowable.has(hostId)) return null;
    remote.acquired.push(hostId);
    return {
      sendUnary: (method: string, params: unknown) => {
        remote.unary.push({ hostId, method, params });
        return Promise.resolve(remote.statusByHost.get(hostId));
      },
      release: () => {
        remote.released.push(hostId);
      },
    };
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: directory.hostIds.map((hostId) => ({ hostId })),
  }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(
    (_title: string, options: { id: string; description: string }) => {
      toasts.shown.push({ id: options.id, description: options.description });
      return options.id;
    },
    { dismiss: () => undefined },
  ),
}));

function status(
  hostId: string,
  hostName: string,
  count: number,
): NotificationHooksStatusResponse {
  return {
    configPath: "/p",
    configError: null,
    hooks: [],
    configurationRevision: "rev-1",
    pendingRemovalNotices: [
      { id: `receipt-${hostId}`, hostId, hostName, count, occurredAt: 10 },
    ],
  };
}

function mount(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectedHookRemovalObservers
        servingHostId="host-serving"
        navigate={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("<ConnectedHookRemovalObservers />", () => {
  beforeEach(() => {
    remote.borrowable.clear();
    remote.statusByHost.clear();
    remote.acquired.length = 0;
    remote.released.length = 0;
    remote.unary.length = 0;
    toasts.shown.length = 0;
    directory.hostIds = ["host-serving", "host-b", "host-offline"];
  });
  afterEach(cleanup);

  it("reads a connected remote computer through its borrowed session and releases it", async () => {
    remote.borrowable.add("host-b");
    remote.statusByHost.set("host-b", status("host-b", "Studio", 1));
    mount(new QueryClient());

    await waitFor(() => {
      expect(toasts.shown).toEqual([
        {
          id: "host:id:receipt-host-b",
          description:
            "Removed 1 notification hook from Studio because it could send its private data.",
        },
      ]);
    });
    expect(remote.unary).toEqual([
      { hostId: "host-b", method: "host.notificationHooks.status", params: {} },
    ]);
    await waitFor(() => {
      expect(remote.released).toEqual(["host-b"]);
    });
  });

  it("leaves the serving computer and unconnected computers alone", () => {
    remote.borrowable.add("host-serving");
    remote.statusByHost.set("host-serving", status("host-serving", "Here", 2));
    mount(new QueryClient());

    // Neither host renders an observer, so no query exists to wait for.
    expect(remote.acquired).toEqual([]);
    expect(remote.unary).toEqual([]);
    expect(toasts.shown).toEqual([]);
  });

  it("does not announce a receipt the person already read", async () => {
    remote.borrowable.add("host-b");
    remote.statusByHost.set("host-b", status("host-b", "Studio", 2));
    const queryClient = new QueryClient();
    mount(queryClient);
    await waitFor(() => {
      expect(toasts.shown).toHaveLength(1);
    });

    await consumePendingHookRemovalNotices(queryClient, "host-b", {
      ids: ["receipt-host-b"],
    });
    await waitFor(() => {
      expect(remote.unary.length).toBeGreaterThan(1);
      expect(queryClient.isFetching()).toBe(0);
    });

    // The origin still reports the receipt; no second announcement follows.
    expect(toasts.shown).toHaveLength(1);
    expect(remote.released.length).toBe(remote.acquired.length);
  });
});
