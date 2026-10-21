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
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import {
  SANDBOX_VERB_FETCH_TIMEOUT_MS,
  type SandboxCreateFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
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

import {
  SandboxCreateError,
  useSandboxCreate,
} from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxAutomationOpen } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
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

  it("opens through the auth service and resolves true when settled, refreshing the directory and the registered-hosts prefix", async () => {
    state.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: true,
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(null);
    });

    expect(outcome).toBe(true);
    expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(state.binding?.auth.openSandboxAutomation).toHaveBeenCalledWith(
      null,
    );
    expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
    expect(state.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("resolves false while the row is still moving (202)", async () => {
    state.binding?.auth.openSandboxAutomation.mockResolvedValue({
      ...OPENED,
      settled: false,
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSandboxAutomationOpen(), {
      wrapper,
    });

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(null);
    });
    expect(outcome).toBe(false);
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
      "Couldn't start Automations.",
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

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.mutateAsync(target);
    });
    expect(outcome).toBe(true);
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

const CREATE_REQUEST: SandboxCreateRequest = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  displayName: "build-box",
  idleMinutes: 30,
  burst: false,
  createdByHostId: null,
  createdByAgentId: null,
  environmentId: null,
};

const CREATE_OK: SandboxCreateFetchResult = {
  kind: "ok",
  accepted: {
    sandboxId: "sbx_1",
    hostId: "host-1",
    sandbox: sandboxSummaryFixture({ state: "creating" }),
  },
};

const CREATE_FAILED: SandboxCreateFetchResult = {
  kind: "network-error",
  detail: "the request never completed (TypeError)",
};

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

  describe("useSandboxCreate", () => {
    function startCreate() {
      signInAs("user-a");
      const { queryClient, invalidate, wrapper } = setup();
      const pending = deferred<SandboxCreateFetchResult>();
      state.binding?.auth.createSandbox.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxCreate(), { wrapper });
      act(() => {
        view.result.current.mutate({
          request: CREATE_REQUEST,
          teamName: null,
          teamId: null,
        });
      });
      return { queryClient, invalidate, pending };
    }

    async function waitForCall() {
      await waitFor(() => {
        expect(state.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
      });
    }

    it("says nothing and moves no cache when B is signed in by the time A's create lands", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      signInAs("user-b");
      pending.resolve(CREATE_OK);
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("toasts no error and moves no cache when A's create fails after B signed in", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      signInAs("user-b");
      pending.resolve(CREATE_FAILED);
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("toasts no error and moves no cache when A's request rejects after B signed in", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      signInAs("user-b");
      pending.reject(new Error("the transport threw"));
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("says nothing when A signed out and nobody is signed in by the time the create lands", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      signInAs(null);
      pending.resolve(CREATE_OK);
      await mutationEnded(queryClient);

      expectNothingMoved(invalidate);
    });

    it("control: with the same account throughout, a landed create toasts Created, refreshes the directory once and invalidates the registered hosts", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      pending.resolve(CREATE_OK);
      await mutationEnded(queryClient);

      expect(state.toastSuccess).toHaveBeenCalledTimes(1);
      expect(state.toastSuccess).toHaveBeenCalledWith("Created build-box");
      expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
      expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
    });

    it("control: with the same account throughout, a failed create toasts the error once and still refreshes and invalidates", async () => {
      const { queryClient, invalidate, pending } = startCreate();
      await waitForCall();

      pending.resolve(CREATE_FAILED);
      await mutationEnded(queryClient);

      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
      expect(state.toastFromAuthError.mock.lastCall?.[1]).toBe(
        "Couldn't create the sandbox.",
      );
      expect(state.toastSuccess).not.toHaveBeenCalled();
      expect(state.binding?.directory.refresh).toHaveBeenCalledTimes(1);
      expect(invalidatedKeys(invalidate)).toEqual([REGISTERED_HOSTS_KEY]);
    });
  });

  describe("useSandboxCreate refusals", () => {
    const TEAM_REQUEST: SandboxCreateRequest = {
      ...CREATE_REQUEST,
      environmentId: "env-acme",
    };

    async function createRefusedAs(
      failure: SandboxCreateFetchResult,
      teamName: string | null,
    ): Promise<unknown> {
      signInAs("user-a");
      state.binding?.auth.createSandbox.mockResolvedValue(failure);
      const { wrapper } = setup();
      const { result } = renderHook(() => useSandboxCreate(), { wrapper });
      let rejection: unknown = null;
      await act(async () => {
        try {
          await result.current.mutateAsync({
            request: TEAM_REQUEST,
            teamName,
            teamId: teamName === null ? null : "team-acme",
          });
        } catch (error: unknown) {
          rejection = error;
        }
      });
      return rejection;
    }

    it("rejects a refused create with a SandboxCreateError carrying the refusal code", async () => {
      const rejection = await createRefusedAs(
        refusal(402, "insufficient_credit"),
        "acme",
      );

      expect(rejection).toBeInstanceOf(SandboxCreateError);
      if (!(rejection instanceof SandboxCreateError)) return;
      expect(rejection.code).toBe("insufficient_credit");
      // `refusal()` carries no reason: nothing to pass on.
      expect(rejection.reason).toBeNull();
    });

    it("carries the refusal's reason, so an unverified credit check can be told from a denied one", async () => {
      for (const reason of ["unverified", "denied"]) {
        const rejection = await createRefusedAs(
          { ...refusal(402, "insufficient_credit"), reason },
          "acme",
        );

        expect(rejection).toBeInstanceOf(SandboxCreateError);
        if (!(rejection instanceof SandboxCreateError)) return;
        expect(rejection.code).toBe("insufficient_credit");
        expect(rejection.reason).toBe(reason);
        cleanup();
      }
    });

    it("rejects a failure with no refusal code as a SandboxCreateError whose code is null", async () => {
      const rejection = await createRefusedAs(CREATE_FAILED, "acme");

      expect(rejection).toBeInstanceOf(SandboxCreateError);
      if (!(rejection instanceof SandboxCreateError)) return;
      expect(rejection.code).toBeNull();
      expect(rejection.reason).toBeNull();
      expect(rejection.message).toBe(
        "Couldn't reach Traycer. Try again in a moment.",
      );
    });

    it("names the team in the error and the toast when the team's environment is refused as not found", async () => {
      const rejection = await createRefusedAs(
        refusal(404, "environment_not_found"),
        "acme",
      );

      expect(rejection).toBeInstanceOf(SandboxCreateError);
      if (!(rejection instanceof SandboxCreateError)) return;
      expect(rejection.code).toBe("environment_not_found");
      expect(rejection.message).toBe("You are not a member of acme.");
      expect(state.toastFromAuthError).toHaveBeenCalledTimes(1);
      const [toasted, title] = state.toastFromAuthError.mock.calls[0];
      expect(toasted.message).toBe("You are not a member of acme.");
      expect(title).toBe("Couldn't create the sandbox.");
    });

    it("names no team when none was picked", async () => {
      const rejection = await createRefusedAs(
        refusal(404, "environment_not_found"),
        null,
      );

      expect(rejection).toBeInstanceOf(SandboxCreateError);
      if (!(rejection instanceof SandboxCreateError)) return;
      expect(rejection.message).not.toContain("acme");
      expect(rejection.message).not.toContain("not a member");
    });

    it("sends the request unchanged, without the team name", async () => {
      await createRefusedAs(refusal(404, "environment_not_found"), "acme");

      expect(state.binding?.auth.createSandbox).toHaveBeenCalledWith(
        TEAM_REQUEST,
      );
    });
  });

  describe("useSandboxDestroy", () => {
    function startDestroy() {
      signInAs("user-a");
      const { queryClient, invalidate, wrapper } = setup();
      const pending = deferred<{ kind: "ok"; settled: boolean }>();
      state.binding?.auth.destroySandbox.mockImplementation(
        () => pending.promise,
      );
      const view = renderHook(() => useSandboxDestroy("sbx_1"), { wrapper });
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
      const view = renderHook(() => useSandboxDestroy("sbx_1"), { wrapper });
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
