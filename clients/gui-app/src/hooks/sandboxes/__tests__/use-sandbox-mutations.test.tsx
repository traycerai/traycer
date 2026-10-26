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
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

const state = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  refreshHostFleet: vi.fn(),
  requestFleetRefresh: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({
  toast: { success: state.toastSuccess, info: state.toastInfo },
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

import { useAuthStore } from "@/stores/auth/auth-store";
import {
  endedSandboxHost,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";
import {
  useSandboxAutomationOpen,
  type SandboxAutomationOpened,
} from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxDestroyBatch } from "@/hooks/sandboxes/use-sandbox-destroy-batch-mutation";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxKeep } from "@/hooks/sandboxes/use-sandbox-keep-mutation";
import { useSandboxPatch } from "@/hooks/sandboxes/use-sandbox-patch-mutation";
import {
  useSandboxVerb,
  type SandboxVerbOutcome,
} from "@/hooks/sandboxes/use-sandbox-verb-mutation";

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
  return { invalidate, queryClient, wrapper };
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

    let outcome: SandboxVerbOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("suspend");
    });

    expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "suspend",
      null,
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    expect(outcome).toEqual({ kind: "settled", state: null });
  });

  it("resolves moving on 202", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: false,
      state: "resuming",
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    let outcome: SandboxVerbOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("resume");
    });
    expect(outcome).toEqual({ kind: "moving" });
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("swallows a 404 sandbox_not_found as gone: no error toast, but the lists still refresh", async () => {
    state.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });

    let outcome: SandboxVerbOutcome | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync("suspend");
    });

    expect(outcome).toEqual({ kind: "gone" });
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

describe("useSandboxAutomationOpen", () => {
  const OPENED = {
    kind: "ok",
    sandbox: sandboxSummaryFixture({ kind: "automation" }),
  } as const;

  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
  });
  afterEach(cleanup);

  it("opens through the auth service and resolves the row, settled,, refreshing the directory and the registered-hosts prefix", async () => {
    state.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: true,
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    let outcome: SandboxAutomationOpened | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(null);
    });

    expect(outcome).toEqual({ sandbox: OPENED.sandbox, settled: true });
    expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalledWith(
      null,
    );
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("resolves the row, not settled, while it is still moving (202)", async () => {
    state.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: false,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    let outcome: SandboxAutomationOpened | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(null);
    });
    expect(outcome).toEqual({ sandbox: OPENED.sandbox, settled: false });
  });

  it("toasts on a refusal and still refreshes", async () => {
    state.binding?.auth.openSandboxAutomation.mockResolvedValue(
      refusal(503, "provider_unavailable"),
    );
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(null)).rejects.toThrow();
    });

    expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    expect(state.toastFromAuthError.mock.calls[0][1]).toBe(
      "Couldn't start Automations. Retry it from Settings ▸ Sandboxes.",
    );
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
  });

  it("opens a team's pod by its environment and ordinal, and toasts a refusal under the pod title", async () => {
    const target = { environmentId: "env_team", ordinal: 2 };
    state.binding?.auth.openSandboxAutomation.mockResolvedValueOnce({
      ...OPENED,
      settled: true,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    let outcome: SandboxAutomationOpened | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(target);
    });
    expect(outcome).toEqual({ sandbox: OPENED.sandbox, settled: true });
    expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalledWith(
      target,
    );

    state.binding?.auth.openSandboxAutomation.mockResolvedValueOnce({
      ...refusal(409, "team_pods_full"),
      message: "Every pod of Alpha is full. Ask an admin to add one.",
    });
    await act(async () => {
      await expect(result.current.mutateAsync(target)).rejects.toThrow(
        "Every pod of Alpha is full. Ask an admin to add one.",
      );
    });
    expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
    expect(state.toastFromAuthError.mock.calls[0][1]).toBe(
      "Couldn't open this team pod.",
    );
  });

  describe("the hook's own toast for a team pod", () => {
    const TARGET = { environmentId: "env_team", ordinal: 2 };

    beforeEach(() => {
      state.toastSuccess.mockClear();
      state.toastInfo.mockClear();
    });

    it("says the pod is open once it settles, though the call passed no callbacks", async () => {
      state.binding?.auth.openSandboxAutomation.mockResolvedValue({
        ...OPENED,
        settled: true,
      });
      const { wrapper } = setup();
      const { result } = renderHook(() => useSandboxAutomationOpen(), {
        wrapper,
      });

      act(() => {
        result.current.mutate(TARGET);
      });

      await waitFor(() => {
        expect(state.toastSuccess).toHaveBeenCalledWith("The team pod is open");
      });
      expect(state.toastSuccess).toHaveBeenCalledTimes(1);
      expect(state.toastInfo).not.toHaveBeenCalled();
    });

    it("says it is opening while the row is still moving (202)", async () => {
      state.binding?.auth.openSandboxAutomation.mockResolvedValue({
        ...OPENED,
        settled: false,
      });
      const { wrapper } = setup();
      const { result } = renderHook(() => useSandboxAutomationOpen(), {
        wrapper,
      });

      act(() => {
        result.current.mutate(TARGET);
      });

      await waitFor(() => {
        expect(state.toastInfo).toHaveBeenCalledWith("Opening the team pod…");
      });
      expect(state.toastSuccess).not.toHaveBeenCalled();
    });

    it("toasts nothing for the person's own Automations entry (a null target)", async () => {
      state.binding?.auth.openSandboxAutomation.mockResolvedValue({
        ...OPENED,
        settled: true,
      });
      const { wrapper } = setup();
      const { result } = renderHook(() => useSandboxAutomationOpen(), {
        wrapper,
      });

      await act(async () => {
        await result.current.mutateAsync(null);
      });

      expect(state.toastSuccess).not.toHaveBeenCalled();
      expect(state.toastInfo).not.toHaveBeenCalled();
    });

    it("says nothing of an open that ends under another account", async () => {
      let finish: () => void = () => undefined;
      state.binding?.auth.openSandboxAutomation.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ ...OPENED, settled: true });
          }),
      );
      signInAs("user-a");
      const { wrapper, queryClient } = setup();
      const { result } = renderHook(() => useSandboxAutomationOpen(), {
        wrapper,
      });

      act(() => {
        result.current.mutate(TARGET);
      });
      await waitFor(() => {
        expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalled();
      });
      signInAs("user-b");
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      // Settled, so its `onSuccess` has run and chosen silence.
      await mutationEnded(queryClient);

      expect(state.toastSuccess).not.toHaveBeenCalled();
      expect(state.toastInfo).not.toHaveBeenCalled();
      signInAs(null);
    });
  });

  it("fails with a sign-in message, calling nothing, when no one is signed in", async () => {
    state.binding = null;
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(null)).rejects.toThrow(
        "Sign in to start Automations.",
      );
    });
  });
});

describe("useSandboxPatch", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
  });
  afterEach(cleanup);

  const REQUEST = {
    displayName: null,
    idleMinutes: 45,
    destroyAfterRestingMinutes: 0,
  };

  it("saves the request for its own sandbox and refreshes the lists and the cost view", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxPatch("sbx_1"), {
      wrapper,
    });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(REQUEST);
    });

    expect(state.binding?.auth.patchSandbox).toHaveBeenCalledWith(
      "sbx_1",
      REQUEST,
    );
    expect(outcome).toBe("saved");
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([
      REGISTERED_HOSTS_KEY,
      COSTS_KEY,
    ]);
  });

  it("resolves gone on a 404 sandbox_not_found, with no toast", async () => {
    state.binding?.auth.patchSandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxPatch("sbx_1"), {
      wrapper,
    });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(REQUEST);
    });
    expect(outcome).toBe("gone");
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("toasts any other refusal under its own title", async () => {
    state.binding?.auth.patchSandbox.mockResolvedValue(
      refusal(409, "sandbox_transition_conflict"),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxPatch("sbx_1"), {
      wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow();
    });
    expect(state.toastFromAuthError.mock.lastCall?.[1]).toBe(
      "Couldn't save the sandbox's settings.",
    );
  });
});

describe("useSandboxKeep", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
  });
  afterEach(cleanup);

  it("keeps its own sandbox and refreshes the lists and the cost view", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxKeep("sbx_1"), {
      wrapper,
    });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync();
    });

    expect(state.binding?.auth.keepSandbox).toHaveBeenCalledWith("sbx_1");
    expect(outcome).toBe("kept");
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([
      REGISTERED_HOSTS_KEY,
      COSTS_KEY,
    ]);
  });

  it("resolves gone when the idle timer destroyed the row first, with no toast", async () => {
    state.binding?.auth.keepSandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxKeep("sbx_1"), {
      wrapper,
    });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync();
    });
    expect(outcome).toBe("gone");
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });
});

const DESTROYED_SANDBOX = {
  id: "sbx_1",
  hostId: "host-sbx-1",
  displayName: "build-box",
};

describe("useSandboxDestroyBatch", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
  });
  afterEach(cleanup);

  it("skips a row another member resumed while the batch destroyed the one before it", async () => {
    const idle = (id: string) =>
      sandboxSummaryFixture({ id, burst: true, state: "suspended" });
    state.binding?.auth.listSandboxes
      .mockResolvedValueOnce({
        kind: "ok",
        response: { sandboxes: [idle("sbx_1"), idle("sbx_2")] },
      })
      .mockResolvedValueOnce({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({ id: "sbx_2", burst: true, state: "awake" }),
          ],
        },
      });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxDestroyBatch(), { wrapper });

    let outcomes: readonly string[] = [];
    await act(async () => {
      const results = await result.current.mutateAsync({
        targets: [
          { sandboxId: "sbx_1", name: "one" },
          { sandboxId: "sbx_2", name: "two" },
        ],
        startedBy: null,
      });
      outcomes = results.map((entry) => entry.outcome.kind);
    });

    expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
    expect(state.binding?.auth.destroySandbox).toHaveBeenCalledWith("sbx_1");
    expect(outcomes).toEqual(["destroyed", "skipped"]);
  });

  it("refreshes the lists and the cost view once the batch settles", async () => {
    state.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx_1",
            burst: true,
            state: "suspended",
          }),
        ],
      },
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxDestroyBatch(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        targets: [{ sandboxId: "sbx_1", name: "one" }],
        startedBy: null,
      });
    });

    expect(invalidatedKeys(invalidate)).toEqual([
      REGISTERED_HOSTS_KEY,
      COSTS_KEY,
    ]);
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
    const { result } = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
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
    const { result } = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
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
    const { result } = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
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
    const { result } = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
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

// Settling under another account. A create, destroy or verb can outlive a
// sign-out and a sign-in as someone else; its outcome is then the first
// account's, so the second sees no toast and none of its caches move.
//
// The create hook re-keys on the account, which resets its observer, so these
// cases wait on the mutation cache (a mutation reaches `success` / `error`
// only after its `onSuccess` / `onError` / `onSettled` have run) rather than
// on `result.current`.

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signInAs(userId: string | null): void {
  act(() => {
    useAuthStore.setState(
      userId === null
        ? { status: "signed-out", contextMetadata: null }
        : {
            status: "signed-in",
            contextMetadata: { userId, username: userId },
          },
    );
  });
}

async function mutationEnded(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    const statuses = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.status);
    expect(statuses).toHaveLength(1);
    expect(["success", "error"]).toContain(statuses[0]);
  });
}

describe("settling under another account", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    state.requestFleetRefresh.mockClear();
    state.toastFromAuthError.mockClear();
    state.toastSuccess.mockClear();
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    });
  });

  function expectNothingMoved(
    invalidate: Mock<QueryClient["invalidateQueries"]>,
  ) {
    expect(state.toastSuccess).not.toHaveBeenCalled();
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
    expect(state.binding?.directory.refresh).not.toHaveBeenCalled();
    expect(state.requestFleetRefresh).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  }

  describe("useSandboxDestroy", () => {
    function startDestroy() {
      signInAs("user-a");
      const { queryClient, invalidate, wrapper } = setup();
      const pending = deferred<{ kind: "ok"; settled: boolean }>();
      state.binding?.auth.destroySandbox.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
        wrapper,
      });
      act(() => {
        view.result.current.mutate();
      });
      return { queryClient, invalidate, pending };
    }

    it("does not refresh the directory, the fleet or the registered hosts when a destroy started as A succeeds under B", async () => {
      const { queryClient, invalidate, pending } = startDestroy();
      await waitFor(() => {
        expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.resolve({ kind: "ok", settled: true });
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("toasts no error when a destroy started as A fails under B", async () => {
      const { queryClient, invalidate, pending } = startDestroy();
      await waitFor(() => {
        expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.reject(new Error("the transport threw"));
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("runs no per-call onSuccess when a destroy started as A succeeds under B", async () => {
      signInAs("user-a");
      const { queryClient, wrapper } = setup();
      const pending = deferred<{ kind: "ok"; settled: boolean }>();
      state.binding?.auth.destroySandbox.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), {
        wrapper,
      });
      const onSuccess = vi.fn<(settled: boolean) => void>();
      act(() => {
        view.result.current.mutate(undefined, { onSuccess });
      });
      await waitFor(() => {
        expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.resolve({ kind: "ok", settled: true });
      await mutationEnded(queryClient);

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("control: with the same account throughout, a failed destroy toasts once", async () => {
      const { queryClient, pending } = startDestroy();
      await waitFor(() => {
        expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
      });

      pending.reject(new Error("the transport threw"));
      await mutationEnded(queryClient);

      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
      expect(state.toastFromAuthError.mock.lastCall?.[1]).toBe(
        "Couldn't destroy the sandbox.",
      );
    });
  });

  describe("useSandboxVerb", () => {
    function startVerb() {
      signInAs("user-a");
      const { queryClient, invalidate, wrapper } = setup();
      const pending = deferred<{
        kind: "ok";
        settled: boolean;
        state: HostSandboxState | null;
      }>();
      state.binding?.auth.runSandboxVerb.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });
      act(() => {
        view.result.current.mutate("suspend");
      });
      return { queryClient, invalidate, pending };
    }

    it("toasts nothing and refreshes nothing when a suspend started as A fails under B", async () => {
      const { queryClient, invalidate, pending } = startVerb();
      await waitFor(() => {
        expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.reject(new Error("the transport threw"));
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("refreshes nothing when a suspend started as A succeeds under B", async () => {
      const { queryClient, invalidate, pending } = startVerb();
      await waitFor(() => {
        expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.resolve({ kind: "ok", settled: true, state: "suspended" });
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("runs no per-call onSuccess when a suspend started as A succeeds under B", async () => {
      signInAs("user-a");
      const { queryClient, wrapper } = setup();
      const pending = deferred<{
        kind: "ok";
        settled: boolean;
        state: HostSandboxState | null;
      }>();
      state.binding?.auth.runSandboxVerb.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxVerb("sbx_1"), { wrapper });
      const onSuccess = vi.fn<(outcome: SandboxVerbOutcome) => void>();
      act(() => {
        view.result.current.mutate("suspend", { onSuccess });
      });
      await waitFor(() => {
        expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      });

      signInAs("user-b");
      pending.resolve({ kind: "ok", settled: true, state: "suspended" });
      await mutationEnded(queryClient);

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("control: with the same account throughout, a failed suspend toasts under the verb's title and still runs the settled invalidations", async () => {
      const { queryClient, invalidate, pending } = startVerb();
      await waitFor(() => {
        expect(state.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      });

      pending.reject(new Error("the transport threw"));
      await mutationEnded(queryClient);

      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
      expect(state.toastFromAuthError.mock.lastCall?.[1]).toBe(
        "Couldn't suspend the sandbox.",
      );
      expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
      expect(state.requestFleetRefresh).toHaveBeenCalledTimes(1);
      expect(invalidatedKeys(invalidate)).toEqual([
        REGISTERED_HOSTS_KEY,
        COSTS_KEY,
      ]);
    });
  });
});

describe("useSandboxDestroyBatch under another account", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    });
  });

  it("destroys nothing once the account that confirmed the batch is gone", async () => {
    signInAs("user-a");
    state.binding?.auth.listSandboxes.mockImplementation(() => {
      // Another account signs in while the batch reads the list.
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "user-b", username: "user-b" },
      });
      return Promise.resolve({
        kind: "ok",
        response: {
          sandboxes: [
            sandboxSummaryFixture({
              id: "sbx_1",
              burst: true,
              state: "suspended",
            }),
          ],
        },
      });
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxDestroyBatch(), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({
          targets: [{ sandboxId: "sbx_1", name: "one" }],
          startedBy: "user-a",
        })
        .catch(() => undefined);
    });

    expect(state.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });

  it("reads and destroys nothing when the account changes between the confirm and the batch's start", async () => {
    // A confirmed the batch; B is signed in by the time it runs.
    signInAs("user-b");
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxDestroyBatch(), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({
          targets: [{ sandboxId: "sbx_1", name: "one" }],
          startedBy: "user-a",
        })
        .catch(() => undefined);
    });

    expect(state.binding?.auth.listSandboxes).not.toHaveBeenCalled();
    expect(state.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });
});

describe("a destroy records its host as ended", () => {
  const VIEWER = { userId: "user-a", displayName: null };

  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    useEndedSandboxHostsStore.setState({ byHostId: {} });
    signInAs("user-a");
  });
  afterEach(() => {
    cleanup();
    signInAs(null);
  });

  function renderDestroy() {
    const { wrapper } = setup();
    return renderHook(() => useSandboxDestroy(DESTROYED_SANDBOX), { wrapper });
  }

  it("records the viewer's destroy before the request resolves", async () => {
    const pending = deferred<{ kind: "ok"; settled: boolean }>();
    state.binding?.auth.destroySandbox.mockImplementation(
      () => pending.promise,
    );
    const view = renderDestroy();

    act(() => {
      view.result.current.mutate();
    });

    await waitFor(() => {
      expect(state.binding?.auth.destroySandbox).toHaveBeenCalledTimes(1);
    });
    expect(endedSandboxHost("host-sbx-1")).toMatchObject({
      name: "build-box",
      actor: VIEWER,
    });
    await act(async () => {
      pending.resolve({ kind: "ok", settled: true });
      await pending.promise;
    });
  });

  it("keeps the record on 200 and on a 404 sandbox_not_found", async () => {
    const view = renderDestroy();
    await act(async () => {
      await view.result.current.mutateAsync();
    });
    expect(endedSandboxHost("host-sbx-1")).not.toBeNull();

    useEndedSandboxHostsStore.setState({ byHostId: {} });
    state.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    await act(async () => {
      await view.result.current.mutateAsync();
    });
    expect(endedSandboxHost("host-sbx-1")).not.toBeNull();
  });

  it("forgets the record when the destroy is refused or never answered", async () => {
    const view = renderDestroy();
    state.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(409, "sandbox_transition_conflict"),
    );
    await act(async () => {
      await view.result.current.mutateAsync().catch(() => undefined);
    });
    expect(endedSandboxHost("host-sbx-1")).toBeNull();

    state.binding?.auth.destroySandbox.mockResolvedValue({
      kind: "network-error",
      detail: "offline",
    });
    await act(async () => {
      await view.result.current.mutateAsync().catch(() => undefined);
    });
    expect(endedSandboxHost("host-sbx-1")).toBeNull();
  });

  describe("the batch, per row", () => {
    const idle = (id: string, hostId: string) =>
      sandboxSummaryFixture({
        id,
        hostId,
        displayName: `name-${id}`,
        burst: true,
        state: "suspended",
      });

    it("records a row it destroys, forgets one refused, and records none it skips", async () => {
      state.binding?.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: [
            idle("sbx_1", "host-1"),
            idle("sbx_2", "host-2"),
            sandboxSummaryFixture({
              id: "sbx_3",
              hostId: "host-3",
              burst: true,
              state: "awake",
            }),
          ],
        },
      });
      state.binding?.auth.destroySandbox
        .mockResolvedValueOnce({ kind: "ok", settled: true })
        .mockResolvedValueOnce(refusal(409, "sandbox_transition_conflict"));
      const { wrapper } = setup();
      const { result } = renderHook(() => useSandboxDestroyBatch(), {
        wrapper,
      });

      await act(async () => {
        await result.current.mutateAsync({
          targets: [
            { sandboxId: "sbx_1", name: "one" },
            { sandboxId: "sbx_2", name: "two" },
            { sandboxId: "sbx_3", name: "three" },
          ],
          startedBy: "user-a",
        });
      });

      expect(endedSandboxHost("host-1")).toMatchObject({
        name: "name-sbx_1",
        actor: VIEWER,
      });
      expect(endedSandboxHost("host-2")).toBeNull();
      expect(endedSandboxHost("host-3")).toBeNull();
    });
  });
});
