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
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SandboxCost,
  SandboxListResponse,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

interface TurnCompletion {
  readonly harnessId: GuiHarnessId;
}

// Every live turn subscription, so a test can count them and fire a turn.
const turns = vi.hoisted(() => ({
  handlers: new Set<(completion: TurnCompletion) => void>(),
}));
vi.mock("@/lib/chats/chat-turn-completions", () => ({
  subscribeChatTurnCompletions: (cb: (completion: TurnCompletion) => void) => {
    turns.handlers.add(cb);
    return () => {
      turns.handlers.delete(cb);
    };
  },
}));

// The list the hook reads its signature from; swapped between renders.
const list = vi.hoisted(() => ({
  current: undefined as SandboxListResponse | undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: list.current }),
}));

// The cost view's answer, whose rows' rates set the credits poll.
const costs = vi.hoisted<{ current: UserSandboxCost | undefined }>(() => ({
  current: undefined,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-costs-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-costs-query")
    >()),
    useSandboxCosts: () => ({ data: costs.current }),
  }),
);

const AUTH = vi.hoisted(() => ({
  marker: "auth-service",
  fetchAuthenticatedUser: vi.fn<() => Promise<AuthenticatedUser | null>>(() =>
    Promise.resolve(null),
  ),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => AUTH,
}));

import { useRefreshSandboxCosts } from "@/hooks/sandboxes/use-refresh-sandbox-costs";
import { useAuthStore } from "@/stores/auth/auth-store";

const COSTS_KEY = ["auth", "sandbox-costs"];
const USER_KEY = ["auth", "user", AUTH];

function listOf(
  ...rows: readonly Parameters<typeof sandboxSummaryFixture>[0][]
): SandboxListResponse {
  return { sandboxes: rows.map(sandboxSummaryFixture) };
}

function costRow(
  state: SandboxCost["state"],
  currentRateMillicreditsPerHour: number,
): SandboxCost {
  return {
    sandboxId: "sbx_1",
    currentRateMillicreditsPerHour,
    state,
    frozen: false,
    charged: {
      computeMillicredits: 0,
      storageMillicredits: 0,
      sinceCreatedAt: 1_791_000_000_000,
    },
    pendingMillicredits: 0,
    segments: [],
  };
}

function costsOf(
  awakeBurnMillicreditsPerHour: number,
  ...sandboxes: readonly SandboxCost[]
): UserSandboxCost {
  return { sandboxes, awakeBurnMillicreditsPerHour };
}

function fireTurn(harnessId: GuiHarnessId): void {
  act(() => {
    for (const handler of [...turns.handlers]) handler({ harnessId });
  });
}

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper, queryClient };
}

function keysInvalidated(invalidate: Mock<QueryClient["invalidateQueries"]>) {
  return invalidate.mock.calls.map(([filters]) => filters?.queryKey);
}

describe("useRefreshSandboxCosts", () => {
  beforeEach(() => {
    turns.handlers.clear();
    list.current = undefined;
    costs.current = undefined;
    AUTH.fetchAuthenticatedUser.mockClear();
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: "signed-out" });
  });

  it("invalidates the costs and the balance on a signature change, not on the first answer or an identical refetch", () => {
    const { invalidate, wrapper } = setup();
    const view = renderHook(() => useRefreshSandboxCosts(), { wrapper });
    expect(invalidate).not.toHaveBeenCalled();

    // The first answer is the queries' own first fetch.
    list.current = listOf({ id: "a", state: "awake" });
    view.rerender();
    expect(invalidate).not.toHaveBeenCalled();

    // A refetch hands out a new object with the same rows.
    list.current = listOf({ id: "a", state: "awake" });
    view.rerender();
    expect(invalidate).not.toHaveBeenCalled();

    // awake -> suspended moves the burn.
    list.current = listOf({ id: "a", state: "suspended" });
    view.rerender();
    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);
  });

  it("reads a change of the frozen flag, of the row set, and not of the row order", () => {
    const { invalidate, wrapper } = setup();
    list.current = listOf(
      { id: "a", state: "awake" },
      { id: "b", state: "suspended" },
    );
    const view = renderHook(() => useRefreshSandboxCosts(), { wrapper });

    list.current = listOf(
      { id: "b", state: "suspended" },
      { id: "a", state: "awake" },
    );
    view.rerender();
    expect(invalidate).not.toHaveBeenCalled();

    list.current = listOf(
      { id: "b", state: "suspended", frozen: true },
      { id: "a", state: "awake" },
    );
    view.rerender();
    expect(invalidate).toHaveBeenCalledTimes(2);

    list.current = listOf({ id: "a", state: "awake" });
    view.rerender();
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("refreshes the balance, and only the balance, when a Traycer turn completes", () => {
    const { invalidate, wrapper } = setup();
    renderHook(() => useRefreshSandboxCosts(), { wrapper });

    fireTurn("claude");
    expect(invalidate).not.toHaveBeenCalled();

    fireTurn("traycer");
    expect(keysInvalidated(invalidate)).toEqual([USER_KEY]);
  });

  it("elects one owner among two mounts: one turn subscription, one invalidation per change", () => {
    const { invalidate, wrapper } = setup();
    list.current = listOf({ id: "a", state: "awake" });
    const first = renderHook(() => useRefreshSandboxCosts(), { wrapper });
    const second = renderHook(() => useRefreshSandboxCosts(), { wrapper });
    expect(turns.handlers.size).toBe(1);

    list.current = listOf({ id: "a", state: "suspended" });
    first.rerender();
    second.rerender();
    // One costs refresh and one balance refresh, not two of each.
    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);

    invalidate.mockClear();
    fireTurn("traycer");
    expect(keysInvalidated(invalidate)).toEqual([USER_KEY]);
  });

  it("passes ownership on when the owner unmounts, without a gap or a double", () => {
    const { invalidate, wrapper } = setup();
    list.current = listOf({ id: "a", state: "awake" });
    const first = renderHook(() => useRefreshSandboxCosts(), { wrapper });
    const second = renderHook(() => useRefreshSandboxCosts(), { wrapper });

    first.unmount();
    // The survivor took over the one subscription.
    expect(turns.handlers.size).toBe(1);

    // Its first signature after the handoff is a baseline, not a change.
    second.rerender();
    expect(invalidate).not.toHaveBeenCalled();

    list.current = listOf({ id: "a", state: "stopped" });
    second.rerender();
    expect(keysInvalidated(invalidate)).toEqual([COSTS_KEY, USER_KEY]);

    fireTurn("traycer");
    expect(invalidate).toHaveBeenCalledTimes(3);

    second.unmount();
    expect(turns.handlers.size).toBe(0);
  });

  describe("the balance poll", () => {
    function creditsObservers(queryClient: QueryClient) {
      return (
        queryClient.getQueryCache().find({ queryKey: USER_KEY })?.observers ??
        []
      );
    }

    it("polls the credits every minute, only while foregrounded, while an awake sandbox burns", () => {
      useAuthStore.setState({ status: "signed-in" });
      costs.current = costsOf(120, costRow("awake", 120));
      const { wrapper, queryClient } = setup();
      renderHook(() => useRefreshSandboxCosts(), { wrapper });

      const observers = creditsObservers(queryClient);
      expect(observers.length).toBeGreaterThan(0);
      expect(observers.some((o) => o.options.refetchInterval === 60_000)).toBe(
        true,
      );
      expect(
        observers.every((o) => o.options.refetchIntervalInBackground === false),
      ).toBe(true);
    });

    it("keeps polling the credits for a suspended sandbox that accrues only its storage", () => {
      useAuthStore.setState({ status: "signed-in" });
      // Nothing is awake, so the awake burn is zero; the disk still bills.
      costs.current = costsOf(0, costRow("suspended", 4));
      const { wrapper, queryClient } = setup();
      renderHook(() => useRefreshSandboxCosts(), { wrapper });

      const observers = creditsObservers(queryClient);
      expect(observers.length).toBeGreaterThan(0);
      expect(observers.some((o) => o.options.refetchInterval === 60_000)).toBe(
        true,
      );
      expect(
        observers.every((o) => o.options.refetchIntervalInBackground === false),
      ).toBe(true);
    });

    it("sets no poll when nothing accrues, or when the cost view has not answered", () => {
      useAuthStore.setState({ status: "signed-in" });
      const { wrapper, queryClient } = setup();

      costs.current = costsOf(0, costRow("suspended", 0));
      const idle = renderHook(() => useRefreshSandboxCosts(), { wrapper });
      expect(creditsObservers(queryClient).length).toBeGreaterThan(0);
      expect(
        creditsObservers(queryClient).every(
          (o) => o.options.refetchInterval === false,
        ),
      ).toBe(true);

      costs.current = undefined;
      idle.rerender();
      expect(
        creditsObservers(queryClient).every(
          (o) => o.options.refetchInterval === false,
        ),
      ).toBe(true);
    });

    it("does not fetch the credits for a signed-out user, whatever the burn", () => {
      costs.current = costsOf(120, costRow("awake", 120));
      const { wrapper } = setup();
      renderHook(() => useRefreshSandboxCosts(), { wrapper });

      expect(AUTH.fetchAuthenticatedUser).not.toHaveBeenCalled();
    });
  });
});
