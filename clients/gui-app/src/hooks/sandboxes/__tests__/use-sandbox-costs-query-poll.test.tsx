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
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxCostsFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { readSandboxCostsForAccount } from "@traycer-clients/shared/host-client/sandbox-cost-list";
import { refreshSandboxCostQueries } from "@/hooks/sandboxes/refresh-sandbox-cost-queries";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The cost query's own poll: a failed read is retried every minute instead of
 * leaving the "Couldn't load the cost" card up until a focus event, and a
 * healthy answer that accrues nothing still does not poll.
 */

const mocks = vi.hoisted(() => ({
  getSandboxCosts: null as Mock<() => Promise<SandboxCostsFetchResult>> | null,
  auth: {
    getSandboxCosts: () => Promise.resolve(FAILED),
  },
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    mocks.getSandboxCosts === null ? null : { auth: mocks.auth },
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";

const FAILED: SandboxCostsFetchResult = {
  kind: "network-error",
  detail: "the request never completed (TypeError)",
};
const IDLE_COSTS = {
  sandboxes: [],
  awakeBurnMillicreditsPerHour: 0,
  todayYoursMillicredits: 0,
  todayByEnvironment: [],
};
const IDLE: SandboxCostsFetchResult = { kind: "ok", costs: IDLE_COSTS };

function wrapper(client: QueryClient | null) {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function responseWithCosts(costs: typeof IDLE_COSTS): Response {
  return new Response(JSON.stringify(costs), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function connectHttpCostFetch(serverBaseUrl: string) {
  mocks.getSandboxCosts = vi.fn(() => {
    const userId =
      useAuthStore.getState().contextMetadata?.userId ?? "test-account";
    const bearerToken = `${userId}-bearer`;
    return readSandboxCostsForAccount(serverBaseUrl, null, {
      userId,
      bearerToken,
      isCurrent: () => {
        const session = useAuthStore.getState();
        return (
          session.status === "signed-in" &&
          (session.contextMetadata?.userId ?? null) === userId
        );
      },
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getSandboxCosts = vi.fn<() => Promise<SandboxCostsFetchResult>>();
  mocks.auth.getSandboxCosts = () =>
    mocks.getSandboxCosts?.() ?? Promise.resolve(FAILED);
  useAuthStore.setState({ status: "signed-in", contextMetadata: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  mocks.getSandboxCosts = null;
});

describe("useSandboxCosts after a failed first read", () => {
  it("retries the read after a minute, and a recovery shows the costs", async () => {
    mocks.getSandboxCosts?.mockResolvedValueOnce(FAILED);
    mocks.getSandboxCosts?.mockResolvedValue(IDLE);
    const { result } = renderHook(() => useSandboxCosts(), {
      wrapper: wrapper(null),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isError).toBe(true);
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(2);
    expect([result.current.status, result.current.fetchStatus]).toEqual([
      "success",
      "idle",
    ]);
    expect(result.current.data).toEqual(IDLE_COSTS);
  });

  it("keeps retrying every minute while it keeps failing", async () => {
    mocks.getSandboxCosts?.mockResolvedValue(FAILED);
    renderHook(() => useSandboxCosts(), { wrapper: wrapper(null) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(4);
  });

  it("control: a healthy answer with nothing accruing is not polled", async () => {
    mocks.getSandboxCosts?.mockResolvedValue(IDLE);
    renderHook(() => useSandboxCosts(), { wrapper: wrapper(null) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(1);
  });

  it("holds a failed HTTP read through invalidations and focus until its minute deadline", async () => {
    const fetchMock = vi
      .fn((_input: RequestInfo | URL, _init: RequestInit | undefined) =>
        Promise.resolve(new Response("{}", { status: 503 })),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(responseWithCosts(IDLE_COSTS));
    vi.stubGlobal("fetch", fetchMock);
    connectHttpCostFetch("https://sandbox.test/failed-invalidation/");
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "poll-account", username: "Poll" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => useSandboxCosts(), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        refreshSandboxCostQueries(
          queryClient,
          sandboxQueryKeys.costs(mocks.auth, "poll-account"),
        );
      }
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "body"] as const)(
    "times out an unanswered HTTP %s at ten seconds and allows a read after the minute cooldown",
    async (unanswered) => {
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, _init: RequestInit | undefined) =>
          Promise.resolve(responseWithCosts(IDLE_COSTS)),
      );
      fetchMock.mockImplementationOnce(
        (_input: RequestInfo | URL, _init: RequestInit | undefined) => {
          if (unanswered === "fetch") {
            return new Promise<Response>(() => {});
          }
          const response = new Response("{}", { status: 200 });
          vi.spyOn(response, "text").mockReturnValue(
            new Promise<string>(() => {}),
          );
          return Promise.resolve(response);
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      connectHttpCostFetch(`https://sandbox.test/timeout-${unanswered}/`);
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: {
          userId: `timeout-${unanswered}`,
          username: `Timeout ${unanswered}`,
        },
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderHook(() => useSandboxCosts(), {
        wrapper: wrapper(queryClient),
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const requestSignal = fetchMock.mock.calls.at(0)?.[1]?.signal;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(requestSignal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(requestSignal?.aborted).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    },
  );

  it("starts a new account read while the prior fetch is pending and discards its late answer", async () => {
    let finishOldResponse: ((response: Response) => void) | null = null;
    const accountBCosts = {
      ...IDLE_COSTS,
      todayYoursMillicredits: 42,
    };
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) =>
        new Promise<Response>((resolve) => {
          finishOldResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    connectHttpCostFetch("https://sandbox.test/account-switch/");
    fetchMock.mockImplementationOnce(
      (_input: RequestInfo | URL, _init: RequestInit | undefined) =>
        new Promise<Response>((resolve) => {
          finishOldResponse = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(responseWithCosts(accountBCosts));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "account-a", username: "Account A" },
    });
    const { result } = renderHook(() => useSandboxCosts(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "account-b", username: "Account B" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.todayYoursMillicredits).toBe(42);

    const oldQuery = queryClient.getQueryCache().find({
      queryKey: sandboxQueryKeys.costs(mocks.auth, "account-a"),
      exact: true,
    });
    const oldReadFailed = new Promise<void>((resolve) => {
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.query === oldQuery && event.query.state.status === "error") {
          unsubscribe();
          resolve();
        }
      });
    });
    await act(async () => {
      finishOldResponse?.(responseWithCosts(IDLE_COSTS));
      await oldReadFailed;
    });
    expect(oldQuery?.state.status).toBe("error");
    expect(oldQuery?.state.data).toBeUndefined();
    expect(result.current.data?.todayYoursMillicredits).toBe(42);
  });

  it("coalesces invalidations during a pending list read into one trailing read", async () => {
    let finishSlowRead: ((result: SandboxCostsFetchResult) => void) | null =
      null;
    mocks.getSandboxCosts?.mockResolvedValueOnce(IDLE);
    mocks.getSandboxCosts?.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSlowRead = resolve;
        }),
    );
    mocks.getSandboxCosts?.mockResolvedValue(IDLE);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => useSandboxCosts(), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(1);

    const queryKey = sandboxQueryKeys.costs(mocks.auth, null);
    act(() => {
      void queryClient.refetchQueries({ queryKey });
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(2);

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        refreshSandboxCostQueries(queryClient, queryKey);
      }
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishSlowRead?.(IDLE);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(3);
  });
});
