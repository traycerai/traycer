import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";

const state = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  refreshHostFleet: vi.fn(),
  requestFleetRefresh: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => state.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: state.refreshHostFleet }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({
  requestFleetRefresh: state.requestFleetRefresh,
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: state.toastFromAuthError,
}));

import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

function invalidatedKeys(invalidate: Mock<QueryClient["invalidateQueries"]>) {
  return invalidate.mock.calls.map(([filters]) => filters?.queryKey);
}

const REGISTERED_HOSTS_KEY = ["auth", "registered-hosts"];
const COSTS_KEY = ["auth", "sandbox-costs"];

describe("useSandboxVerb", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
  });
  afterEach(cleanup);

  it("sends the verb for its own sandbox and resolves settled on 200", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("suspend");
    });

    expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "suspend",
    );
    expect(outcome).toBe("settled");
  });

  it("resolves moving on 202", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: false,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("resume");
    });
    expect(outcome).toBe("moving");
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("swallows a 404 sandbox_not_found as gone: no error toast, but the lists still refresh", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("suspend");
    });

    expect(outcome).toBe("gone");
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([
      REGISTERED_HOSTS_KEY,
      COSTS_KEY,
    ]);
  });

  it("refreshes every list on a refusal too, because a busy or conflicting row has moved", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(409, "sandbox_busy"),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync("suspend")).rejects.toThrow(
        "It's in use",
      );
    });

    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([
      REGISTERED_HOSTS_KEY,
      COSTS_KEY,
    ]);
  });

  it("toasts the typed copy under the verb's own title when the control plane refuses", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(402, "sandbox_frozen"),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("resume").catch(() => undefined);
    });

    await waitFor(() => {
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    const [error, title] = state.toastFromAuthError.mock.calls[0];
    expect(title).toBe("Couldn't resume the sandbox.");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("credits ran out");
  });

  it("fails with a sign-in message, calling nothing, when no one is signed in", async () => {
    state.binding = null;
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync("stop")).rejects.toThrow(
        "Sign in to change this sandbox.",
      );
    });
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("useSandboxDestroy", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
  });
  afterEach(cleanup);

  it("resolves true when the row is gone on 200 and refreshes the lists", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxDestroy("sbx_1"), {
      wrapper,
    });

    let gone: boolean | null = null;
    await act(async () => {
      gone = await result.current.mutateAsync();
    });

    expect(state.binding?.auth.destroySandbox).toHaveBeenCalledWith("sbx_1");
    expect(gone).toBe(true);
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
  });

  it("resolves false on 202, the row still destroying", async () => {
    state.binding?.auth.destroySandbox.mockResolvedValue({
      kind: "ok",
      settled: false,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxDestroy("sbx_1"), {
      wrapper,
    });

    let gone: boolean | null = null;
    await act(async () => {
      gone = await result.current.mutateAsync();
    });
    expect(gone).toBe(false);
  });

  it("resolves true on a 404 sandbox_not_found: the sandbox already does not exist", async () => {
    state.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxDestroy("sbx_1"), {
      wrapper,
    });

    let gone: boolean | null = null;
    await act(async () => {
      gone = await result.current.mutateAsync();
    });
    expect(gone).toBe(true);
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("fails and toasts on any other refusal, refreshing nothing", async () => {
    state.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(409, "sandbox_transition_conflict"),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxDestroy("sbx_1"), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => {
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    });
    expect(state.toastFromAuthError.mock.calls[0][1]).toBe(
      "Couldn't destroy the sandbox.",
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(state.binding?.directory.refresh).not.toHaveBeenCalled();
  });
});
