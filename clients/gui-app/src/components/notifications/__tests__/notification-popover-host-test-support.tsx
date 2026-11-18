import { render } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { HostNotificationsCloudFeedRowV18 } from "@traycer/protocol/host/notifications/contracts";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { NotificationsPopover } from "@/components/notifications/notifications-popover";
import {
  type HostNotificationFeedEntry,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";

/**
 * The real notification popover over a host that answers one request mock, for
 * the suites that act on the rows of the host's feed. Each suite still declares
 * its own `vi.mock` calls, which only hoist inside the file that makes them.
 */

export interface StubHostClient {
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly requestWithSignal: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  readonly requestWithSignalRequiringHostMethodVersion: (
    method: string,
    params: unknown,
  ) => Promise<unknown>;
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (hostId: string | null) => StubHostClient;
}

export interface StubHostBinding {
  readonly hostClient: StubHostClient;
  readonly directory: {
    readonly findById: (hostId: string) => typeof mockLocalHostEntry | null;
    readonly selectById: () => void;
    readonly getLocalEntry: () => typeof mockLocalHostEntry;
    readonly onChange: () => { readonly dispose: () => void };
  };
}

export function bindingFor(
  request: (method: string, params: unknown) => Promise<unknown>,
): StubHostBinding {
  const hostClient: StubHostClient = {
    request,
    requestWithSignal: request,
    requestWithSignalRequiringHostMethodVersion: (method, params) =>
      request(method, params),
    getActiveHostId: () => mockLocalHostEntry.hostId,
    createRequesterForHostId: () => hostClient,
  };
  return {
    hostClient,
    directory: {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      selectById: () => undefined,
      getLocalEntry: () => mockLocalHostEntry,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

export function signInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

export function loadHostFeed(
  entries: ReadonlyArray<HostNotificationFeedEntry>,
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: { entries: [], nextCursor: null },
    recent: { entries, nextCursor: null },
    summary: { unreadCount: entries.length, attentionCount: 0 },
  });
}

/** Fills the account's cloud feed with the given rows, as the cloud's snapshot does. */
export function loadCloudFeed(
  accountId: string,
  entries: ReadonlyArray<HostNotificationFeedEntry>,
): void {
  const rows: ReadonlyArray<HostNotificationsCloudFeedRowV18> = entries.map(
    (entry) => ({
      entryId: entry.id,
      originHostId: mockLocalHostEntry.hostId,
      coalesceKey: `bot:${entry.id}`,
      entry,
      presentation: { epicTitle: "Tracy", chatTitle: "Thread" },
    }),
  );
  useCloudNotificationsStore.setState({ accountId });
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.length,
      attentionCount: 0,
    },
    version: 1,
  });
}

/**
 * Renders the popover, with `beside` mounted in the same providers, and returns
 * the query client its mutations run in.
 */
export function renderPopover(
  onNavigate: () => void,
  beside: ReactNode,
): QueryClient {
  const headingRef = createRef<HTMLHeadingElement>();
  const shellRef = createRef<HTMLDivElement>();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <>
        {beside}
        <NotificationsPopover
          variant="center"
          onNavigate={onNavigate}
          headingRef={headingRef}
          shellRef={shellRef}
          shellStyle={{}}
          onFilterMenuOpenChange={() => undefined}
        />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

/**
 * Every id the host was asked to mark read, across however many requests
 * carried them, each once and in id order.
 */
export function markedReadIds(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const [method, params] of calls) {
    if (method !== "host.notifications.markRead") continue;
    const carried: unknown = Reflect.get(Object(params), "ids");
    if (!Array.isArray(carried)) throw new Error("markRead carried no ids");
    for (const id of carried) ids.add(String(id));
  }
  return [...ids].sort();
}

/** Every entry id the host was asked to mark read in the cloud feed, each once, in id order. */
export function markedCloudReadIds(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const [method, params] of calls) {
    if (method !== "host.notifications.cloudFeed.markRead") continue;
    ids.add(String(Reflect.get(Object(params), "entryId")));
  }
  return [...ids].sort();
}
