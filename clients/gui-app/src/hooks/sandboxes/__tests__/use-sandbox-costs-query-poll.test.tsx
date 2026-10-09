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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SandboxCostsFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The cost query's own poll: a failed read is retried every minute instead of
 * leaving the "Couldn't load the cost" card up until a focus event, and a
 * healthy answer that accrues nothing still does not poll.
 */

const mocks = vi.hoisted(() => ({
  getSandboxCosts: null as Mock<() => Promise<SandboxCostsFetchResult>> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    mocks.getSandboxCosts === null
      ? null
      : { auth: { getSandboxCosts: mocks.getSandboxCosts } },
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";

const FAILED: SandboxCostsFetchResult = {
  kind: "network-error",
  detail: "the request never completed (TypeError)",
};
const IDLE_COSTS = { sandboxes: [], awakeBurnMillicreditsPerHour: 0 };
const IDLE: SandboxCostsFetchResult = { kind: "ok", costs: IDLE_COSTS };

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getSandboxCosts = vi.fn<() => Promise<SandboxCostsFetchResult>>();
  useAuthStore.setState({ status: "signed-in" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ status: "signed-out" });
  mocks.getSandboxCosts = null;
});

describe("useSandboxCosts after a failed first read", () => {
  it("retries the read after a minute, and a recovery shows the costs", async () => {
    mocks.getSandboxCosts?.mockResolvedValueOnce(FAILED);
    mocks.getSandboxCosts?.mockResolvedValue(IDLE);
    const { result } = renderHook(() => useSandboxCosts(), {
      wrapper: wrapper(),
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
    renderHook(() => useSandboxCosts(), { wrapper: wrapper() });

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
    renderHook(() => useSandboxCosts(), { wrapper: wrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(mocks.getSandboxCosts).toHaveBeenCalledTimes(1);
  });
});
