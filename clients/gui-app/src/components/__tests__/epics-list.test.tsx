import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  HostRpcError,
  type IHostMessenger,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { EpicsList } from "@/components/epics/epics-list";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";
import type {
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-1",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
};

type ListTasksHandler = (
  params: ListTasksRequest,
) => Promise<ListTasksResponse> | ListTasksResponse;

interface MountOptions {
  readonly tasksHandler: ListTasksHandler;
  readonly authStatus: AuthStatus;
  readonly storedToken: string | null;
}

interface MountResult {
  readonly host: MockRunnerHost;
  readonly cleanupOnly: () => void;
}

let messengerRequestCount = 0;
let listTasksRequests: ListTasksRequest[] = [];

function buildMessengerFactory(
  options: MountOptions,
): (args: { registry: HostRpcRegistry }) => IHostMessenger<HostRpcRegistry> {
  return (args) => {
    return new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "epic.listTasks": (params): Promise<ListTasksResponse> => {
          messengerRequestCount += 1;
          listTasksRequests.push(params);
          return Promise.resolve(options.tasksHandler(params)).then(
            (value) => value,
          );
        },
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
          }),
      },
    });
  };
}

function mountEpicsList(opts: MountOptions): MountResult {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  if (opts.storedToken !== null) {
    void host.tokenStore.set({
      token: opts.storedToken,
      refreshToken: `${opts.storedToken}-refresh`,
    });
  }
  setInitialAuthState(opts.authStatus);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  });

  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    path: "/",
    getParentRoute: () => rootRoute,
    component: () => <EpicsList routeSearch={null} historyNowMs={null} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const Wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <RunnerHostProvider runnerHost={host}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={buildMessengerFactory(opts)}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">loading runtime…</div>}
        >
          {children}
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );

  render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>,
  );

  return {
    host,
    cleanupOnly: () => {
      queryClient.clear();
    },
  };
}

function mountSignedInEpicsList(tasksHandler: ListTasksHandler): MountResult {
  return mountEpicsList({
    tasksHandler,
    authStatus: "signed-in",
    storedToken: "test-token",
  });
}

function setInitialAuthState(status: AuthStatus): void {
  if (status === "signed-in") {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    return;
  }
  if (status === "signing-in") {
    useAuthStore.getState().setSigningIn();
    return;
  }
  useAuthStore.getState().setSignedOut();
}

function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "user-1",
                name: "Test User",
                providerId: "gh-1",
                providerHandle: "test-user",
                providerType: "GITHUB",
                email: "test@example.com",
                avatarUrl: null,
                activatedAt: null,
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                lastSeenAt: null,
                privacyMode: false,
                isLearningEnabled: true,
              },
              userSubscription: {
                id: "sub-1",
                userID: "user-1",
                orgID: null,
                teamID: null,
                customerId: "cus-1",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                subscriptionExpiry: null,
                trialEndsAt: null,
                subscriptionStatus: "FREE",
                hasPaymentMethod: false,
                isInTrial: false,
                rechargeRateSeconds: 0,
              },
              teamSubscriptions: [],
              payAsYouGoUsage: { allowPayAsYouGo: false },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in epics-list test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function expectedDefaultHistoryRequest(
  cursor: string | undefined,
): ListTasksRequest {
  const request: ListTasksRequest = {
    limit: 20,
    filters: null,
    sort: "recent",
    extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
    extensionEpicVersion: String(CURRENT_EPIC_VERSION),
  };
  if (cursor === undefined) return request;
  return { ...request, cursor };
}

describe("<EpicsList />", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    messengerRequestCount = 0;
    listTasksRequests = [];
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-04-22T12:00:00.000Z"),
    );
    useAuthStore.getState().setSignedOut();
    window.localStorage.clear();
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
    restoreFetch = installAuthFetch();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
    vi.mocked(toast.error).mockClear();
    vi.restoreAllMocks();
    restoreFetch();
  });

  it("requests tasks without a task type filter and renders epic and phase rows", async () => {
    let resolveTasks: (value: ListTasksResponse) => void = () => undefined;
    const pending = new Promise<ListTasksResponse>((resolve) => {
      resolveTasks = resolve;
    });

    const result = mountSignedInEpicsList(() => pending);

    expect(await screen.findByTestId("epics-list-loading")).not.toBeNull();

    act(() => {
      resolveTasks({
        tasks: [
          {
            epic: {
              light: {
                id: "epic-1",
                title: "First Epic",
                initialUserPrompt: "do x",
                ticketCount: 0,
                specCount: 0,
                storyCount: 0,
                reviewCount: 0,
                status: "draft",
                createdAt: Date.parse("2026-04-21T12:00:00.000Z"),
                updatedAt: Date.parse("2026-04-22T11:58:00.000Z"),
                createdBy: "u",
                version: "1",
              },
              permission: null,
              repos: [],
              workspaces: [],
              roomInfo: null,
            },
          },
          {
            phase: {
              light: {
                id: "phase-1",
                title: "Legacy Phase",
                userQuery: "phase only row",
                phaseLength: 1,
                status: "ready",
                createdAt: Date.parse("2026-04-21T12:00:00.000Z"),
                updatedAt: Date.parse("2026-04-22T11:59:00.000Z"),
                createdBy: "u",
                version: "1.0.0",
              },
              permission: null,
              repos: [],
              workspaces: [],
              roomInfo: null,
            },
          },
        ],
        hasMore: false,
      });
    });

    expect(await screen.findByTestId("epics-list-rows")).not.toBeNull();
    expect(screen.queryByTestId("epics-list-loading")).toBeNull();
    expect(screen.getByText("Legacy Phase")).not.toBeNull();
    expect(screen.getByText("updated 1 minute ago")).not.toBeNull();
    expect(screen.getByText("First Epic")).not.toBeNull();
    expect(screen.getByText("updated 2 minutes ago")).not.toBeNull();
    expect(screen.getAllByTestId("epics-list-row")).toHaveLength(2);
    expect(listTasksRequests).toEqual([
      expectedDefaultHistoryRequest(undefined),
    ]);
    result.cleanupOnly();
  });

  it("paginates via Show more, threading the host-supplied cursor and hiding the button when hasMore=false", async () => {
    const epicLight = (id: string, title: string, updatedAt: string) => ({
      epic: {
        light: {
          id,
          title,
          initialUserPrompt: "p",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "draft" as const,
          createdAt: Date.parse(updatedAt),
          updatedAt: Date.parse(updatedAt),
          createdBy: "u",
          version: "1",
        },
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
    });

    const result = mountSignedInEpicsList((params) => {
      if (params.cursor === undefined) {
        return {
          tasks: [
            epicLight("epic-p1", "Page One Epic", "2026-04-22T11:58:00.000Z"),
          ],
          hasMore: true,
          nextCursor: "cursor-2",
        };
      }
      if (params.cursor === "cursor-2") {
        return {
          tasks: [
            epicLight("epic-p2", "Page Two Epic", "2026-04-22T11:00:00.000Z"),
          ],
          hasMore: false,
        };
      }
      throw new Error(`unexpected cursor: ${String(params.cursor)}`);
    });

    await screen.findByText("Page One Epic");
    expect(screen.getAllByTestId("epics-list-row")).toHaveLength(1);

    const showMore = await screen.findByTestId("epics-list-show-more");

    fireEvent.click(showMore);

    await screen.findByText("Page Two Epic");
    expect(screen.getAllByTestId("epics-list-row")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.queryByTestId("epics-list-show-more")).toBeNull();
    });

    expect(listTasksRequests).toEqual([
      expectedDefaultHistoryRequest(undefined),
      expectedDefaultHistoryRequest("cursor-2"),
    ]);
    result.cleanupOnly();
  });

  it("toasts and keeps the Show more button when the next-page fetch fails", async () => {
    const result = mountSignedInEpicsList((params) => {
      if (params.cursor === undefined) {
        return {
          tasks: [
            {
              epic: {
                light: {
                  id: "epic-p1",
                  title: "Page One Epic",
                  initialUserPrompt: "p",
                  ticketCount: 0,
                  specCount: 0,
                  storyCount: 0,
                  reviewCount: 0,
                  status: "draft" as const,
                  createdAt: Date.parse("2026-04-22T11:58:00.000Z"),
                  updatedAt: Date.parse("2026-04-22T11:58:00.000Z"),
                  createdBy: "u",
                  version: "1",
                },
                permission: null,
                repos: [],
                workspaces: [],
                roomInfo: null,
              },
            },
          ],
          hasMore: true,
          nextCursor: "cursor-2",
        };
      }
      // The "Show more" (next-page) request fails.
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "next page unavailable",
        method: "epic.listTasks",
        requestId: "req-next",
        fatalDetails: null,
      });
    });

    await screen.findByText("Page One Epic");
    const showMore = await screen.findByTestId("epics-list-show-more");
    fireEvent.click(showMore);

    // The failure is surfaced via toast (the hook only returns pagination
    // state, so mutation.error never reaches the caller otherwise)...
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    // ...and the list is unchanged - no stale page appended, button still there
    // to retry (isFetchingNextPage cleared once the mutation settled).
    expect(screen.getAllByTestId("epics-list-row")).toHaveLength(1);
    expect(screen.getByTestId("epics-list-show-more")).not.toBeNull();
    result.cleanupOnly();
  });

  it("ignores an in-flight next page after the history query changes identity", async () => {
    const epicLight = (id: string, title: string, updatedAt: string) => ({
      epic: {
        light: {
          id,
          title,
          initialUserPrompt: "p",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "draft" as const,
          createdAt: Date.parse(updatedAt),
          updatedAt: Date.parse(updatedAt),
          createdBy: "u",
          version: "1",
        },
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
    });
    let resolveOldPage: (value: ListTasksResponse) => void = () => undefined;
    const oldPage = new Promise<ListTasksResponse>((resolve) => {
      resolveOldPage = resolve;
    });

    const result = mountSignedInEpicsList((params) => {
      if (params.cursor === "cursor-2") return oldPage;
      if (params.filters?.query === "beta") {
        return {
          tasks: [
            epicLight("epic-beta", "Beta Epic", "2026-04-22T11:30:00.000Z"),
          ],
          hasMore: false,
        };
      }
      if (params.cursor === undefined) {
        return {
          tasks: [
            epicLight("epic-alpha", "Alpha Epic", "2026-04-22T11:58:00.000Z"),
          ],
          hasMore: true,
          nextCursor: "cursor-2",
        };
      }
      throw new Error(`unexpected request: ${JSON.stringify(params)}`);
    });

    await screen.findByText("Alpha Epic");
    fireEvent.click(await screen.findByTestId("epics-list-show-more"));
    fireEvent.change(
      await screen.findByRole("searchbox", { name: "Search tasks" }),
      { target: { value: "beta" } },
    );

    await waitFor(() => {
      expect(
        listTasksRequests.some((request) => request.filters?.query === "beta"),
      ).toBe(true);
    });
    await screen.findByText("Beta Epic");

    act(() => {
      resolveOldPage({
        tasks: [
          epicLight(
            "epic-stale",
            "Stale Page Two Epic",
            "2026-04-22T11:00:00.000Z",
          ),
        ],
        hasMore: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Stale Page Two Epic")).toBeNull();
    });
    expect(screen.getByText("Beta Epic")).not.toBeNull();
    result.cleanupOnly();
  });

  it("renders the empty state when epic.listTasks returns no tasks", async () => {
    const result = mountSignedInEpicsList(() => ({
      tasks: [],
      hasMore: false,
    }));

    expect(await screen.findByTestId("epics-list-empty")).not.toBeNull();
    expect(screen.getByText("No tasks yet")).not.toBeNull();
    result.cleanupOnly();
  });

  it("renders the error state with Retry and Show details when the host rejects", async () => {
    const result = mountSignedInEpicsList(() => {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "host unhappy",
        method: "epic.listTasks",
        requestId: "req-test",
        fatalDetails: null,
      });
    });

    const errorBlock = await screen.findByTestId("epics-list-error");
    expect(errorBlock).not.toBeNull();
    expect(screen.getByText("Couldn't reach Traycer Cloud")).not.toBeNull();
    expect(screen.getByTestId("epics-list-error-retry")).not.toBeNull();
    const toggle = screen.getByTestId("epics-list-error-toggle-details");
    fireEvent.click(toggle);
    expect(
      (await screen.findByTestId("epics-list-error-details")).textContent,
    ).toContain("host unhappy");
    result.cleanupOnly();
  });

  it("re-fires the epic.listTasks query when Refresh is clicked", async () => {
    const result = mountSignedInEpicsList(() => ({
      tasks: [],
      hasMore: false,
    }));

    await screen.findByTestId("epics-list-empty");
    const before = messengerRequestCount;

    const refresh = screen.getByTestId("epics-list-refresh");
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(messengerRequestCount).toBeGreaterThan(before);
    });
    result.cleanupOnly();
  });

  it("does not request tasks while auth is still signing in", async () => {
    const result = mountEpicsList({
      authStatus: "signing-in",
      storedToken: null,
      tasksHandler: () => {
        throw new Error("epic.listTasks should stay disabled while signing in");
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-fallback")).toBeNull();
    });

    expect(messengerRequestCount).toBe(0);
    expect(screen.queryByTestId("epics-list-error")).toBeNull();
    result.cleanupOnly();
  });

  it("does not surface the sign-out request-context gap as a history error", async () => {
    const result = mountSignedInEpicsList(() => ({
      tasks: [],
      hasMore: false,
    }));

    await screen.findByTestId("epics-list-empty");
    const requestCountBeforeSignOut = messengerRequestCount;

    await act(async () => {
      await getHostBindingSnapshot()?.auth.signOut();
    });

    expect(useAuthStore.getState().status).toBe("signed-out");
    expect(messengerRequestCount).toBe(requestCountBeforeSignOut);
    expect(screen.queryByTestId("epics-list-error")).toBeNull();
    result.cleanupOnly();
  });
});
