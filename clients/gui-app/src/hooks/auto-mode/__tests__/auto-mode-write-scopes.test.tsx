import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
} from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  AutoJudgeSetResponse,
  AutoPolicySetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  autoJudgeWriteScope,
  autoPolicyWriteScope,
  providerAutoJudgeWriteScope,
} from "@/lib/query-keys/auto-mode-write-scopes";
import { hostQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { UseHostMutationOptions } from "@/hooks/host/use-host-query";

// ─── shared boundary mocks ──────────────────────────────────────────────
//
// Only the host-client boundary (`@/lib/host`'s `useHostClient`) is faked.
// `useHostMutation` itself is left REAL - wrapped in a spy that forwards
// every call straight through to the actual implementation - so:
//   - 4a/4b get the REAL TanStack `useMutation` and the real `MutationScope`
//     serialization (a fake `useHostMutation` could only hand back canned
//     results and could never show that a second `mutate()` is held back);
//   - 4d can still read what SCOPE a hook passed in, off the spy's captured
//     call args, without needing a second, differently-behaved mock of the
//     same module.
const mocks = vi.hoisted(() => ({
  getActiveHostId: vi.fn((): string | null => "host-1"),
  request: vi.fn(),
  useHostMutationCalls: [] as unknown[],
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({
      getActiveHostId: mocks.getActiveHostId,
      request: mocks.request,
    }),
  };
});

vi.mock("@/hooks/host/use-host-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-query")>();
  function spiedUseHostMutation<
    Registry extends VersionedRpcRegistry,
    Method extends keyof Registry & string,
    TContext = unknown,
    TVariables = RequestOfMethod<Registry, Method>,
  >(
    args: UseHostMutationOptions<Registry, Method, TContext, TVariables>,
  ): UseMutationResult<
    ResponseOfMethod<Registry, Method>,
    HostRpcError,
    TVariables,
    TContext
  > {
    mocks.useHostMutationCalls.push(args);
    return actual.useHostMutation(args);
  }
  return { ...actual, useHostMutation: spiedUseHostMutation };
});

import { useAutoJudgeSetMutation } from "@/hooks/auto-mode/use-auto-judge-set-mutation";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import { useProvidersSetAutoJudge } from "@/hooks/providers/use-providers-set-auto-judge-mutation";

interface CapturedMutation {
  readonly options: {
    readonly scope: { readonly id: string } | undefined;
  };
}

function lastCapturedMutation(): CapturedMutation {
  const call = mocks.useHostMutationCalls.at(-1);
  if (call === undefined) throw new Error("useHostMutation was never called");
  return call as CapturedMutation;
}

function wrapperWith(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

/** A promise plus its resolver, pulled apart so a test can settle it by hand. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("resolve called before assignment");
  };
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  // `useAuthStore` is a real global store, so a signed-in viewer set by one
  // test outlives it. Resetting here rather than at the end of the test body
  // is the difference between one failure and a cascade: a body-final reset is
  // skipped whenever an earlier assertion or `waitFor` throws, and the leaked
  // viewer then reaches every later test in this file and in the worker.
  useAuthStore.getState().setSignedOut();
  mocks.getActiveHostId.mockReset();
  mocks.getActiveHostId.mockReturnValue("host-1");
  mocks.request.mockReset();
  mocks.useHostMutationCalls.length = 0;
});

// ─── 4a: the headline serialization test ───────────────────────────────────

describe("useAutoJudgeSetMutation - client-side write ordering", () => {
  // FALSIFICATION (performed and reverted by hand - see the report back):
  // deleting the `scope: autoJudgeWriteScope(...)` line from
  // `use-auto-judge-set-mutation.ts` makes both `mutate()` calls dispatch
  // immediately - `request` is called twice before either promise settles -
  // so the "called once" assertion below goes red. The line was restored by
  // retyping it afterward; `git checkout`/`git restore`/`git stash` were
  // never used, per the instruction that the tree carries other uncommitted
  // work.
  it("holds the second differently-selected write until the first settles, and the cache ends on the second response", async () => {
    const first = deferred<AutoJudgeSetResponse>();
    const second = deferred<AutoJudgeSetResponse>();
    mocks.request.mockImplementationOnce(() => first.promise);
    mocks.request.mockImplementationOnce(() => second.promise);

    const queryClient = new QueryClient();
    // `onSuccess` folds the response into the `autoJudge.get` cache with
    // `setQueriesData`, which only touches an EXISTING entry - it creates
    // nothing - so the read side needs a query already sitting in that slot
    // for the write side's fold to be observable at all.
    queryClient.setQueryData(
      hostQueryKeys.methodScope("host-1", "autoJudge.get"),
      { selection: null },
    );
    const { result } = renderHook(() => useAutoJudgeSetMutation(), {
      wrapper: wrapperWith(queryClient),
    });

    // Two DIFFERENT selections - the params difference is exactly what would
    // put them in two different `HostRequestCoordinator` queues one layer
    // down (its key is `[hostId, userId, method, params]`), which is why
    // only a client-side scope can still order them.
    const selectionA = {
      selection: { harnessId: "claude", model: "model-a", profileId: null },
    };
    const selectionB = {
      selection: { harnessId: "codex", model: "model-b", profileId: null },
    };

    result.current.mutate(selectionA);
    result.current.mutate(selectionB);

    // The scope holds the second mutate() in the client - only the first
    // dispatch has reached the host client's `request` so far.
    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    expect(mocks.request).toHaveBeenCalledWith("autoJudge.set", selectionA);

    const responseA: AutoJudgeSetResponse = {
      selection: { harnessId: "claude", model: "model-a", profileId: null },
    };
    first.resolve(responseA);

    // Once the first settles, the scope releases the second - carrying
    // selectionB, not a re-dispatch of the first.
    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(2);
    });
    expect(mocks.request).toHaveBeenNthCalledWith(
      2,
      "autoJudge.set",
      selectionB,
    );

    const responseB: AutoJudgeSetResponse = {
      selection: { harnessId: "codex", model: "model-b", profileId: null },
    };
    second.resolve(responseB);

    // The `autoJudge.get` cache ends up holding the SECOND response, not the
    // first - the whole point of ordering the writes.
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          hostQueryKeys.methodScope("host-1", "autoJudge.get"),
        ),
      ).toEqual(responseB);
    });
  });
});

// ─── 4b: the same serialization shape for the policy mutation ─────────────

describe("useAutoPolicySetMutation - client-side write ordering", () => {
  it("holds a second differently-bodied write until the first settles, cache ends on the second body", async () => {
    const first = deferred<AutoPolicySetResponse>();
    const second = deferred<AutoPolicySetResponse>();
    mocks.request.mockImplementationOnce(() => first.promise);
    mocks.request.mockImplementationOnce(() => second.promise);

    // The policy read cache is partitioned by the authenticated viewer, and
    // the mutation folds its response into THAT viewer's entry - never the
    // bare method scope, which would prefix-match every viewer's partition.
    // So the test signs a viewer in and seeds and reads that partition.
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-1", userName: "user-1", email: "user-1@example.com" },
        { userId: "user-1", username: "user-1" },
        [],
      );
    const policyKey = hostQueryKeys.autoPolicyForViewer("host-1", "user-1");
    const queryClient = new QueryClient();
    // Same reason as the judge test above: `setQueriesData` only folds into
    // an EXISTING cache entry.
    queryClient.setQueryData(policyKey, {
      body: null,
      updatedAt: null,
      source: "account",
    });
    const { result } = renderHook(() => useAutoPolicySetMutation(), {
      wrapper: wrapperWith(queryClient),
    });

    result.current.mutate({ body: "policy draft one" });
    result.current.mutate({ body: "policy draft two" });

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    expect(mocks.request).toHaveBeenCalledWith("autoPolicy.set", {
      body: "policy draft one",
    });

    first.resolve({ updatedAt: "2026-01-01T00:00:00.000Z" });

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(2);
    });
    expect(mocks.request).toHaveBeenNthCalledWith(2, "autoPolicy.set", {
      body: "policy draft two",
    });

    second.resolve({ updatedAt: "2026-01-01T00:01:00.000Z" });

    await waitFor(() => {
      const cached = queryClient.getQueryData<{ readonly body?: string }>(
        policyKey,
      );
      expect(cached?.body).toBe("policy draft two");
    });
  });

  // Weak-half fallback per the assignment: the judge and policy writes must
  // not share a scope id, or a judge write and a policy write for the SAME
  // host would serialize against each other for no reason - they are two
  // different host-side records (`auto-judge.json` vs. the cloud account
  // policy) with no ordering relationship between them.
  it("uses a scope id distinct from the judge mutation's", () => {
    expect(autoPolicyWriteScope().id).not.toBe(
      autoJudgeWriteScope("host-1").id,
    );
    expect(autoPolicyWriteScope().id).not.toBe(autoJudgeWriteScope(null).id);
  });
});

// ─── 4c: scope-identity cases on the builders themselves ───────────────────

describe("auto-mode write scope builders - identity", () => {
  it("autoJudgeWriteScope: same host -> same id, different hosts -> different ids", () => {
    expect(autoJudgeWriteScope("host-1").id).toBe(
      autoJudgeWriteScope("host-1").id,
    );
    expect(autoJudgeWriteScope("host-1").id).not.toBe(
      autoJudgeWriteScope("host-2").id,
    );
  });

  it("autoJudgeWriteScope: a null host gets its own bucket, not host-1's", () => {
    expect(autoJudgeWriteScope(null).id).not.toBe(
      autoJudgeWriteScope("host-1").id,
    );
    expect(autoJudgeWriteScope(null).id).toBe(autoJudgeWriteScope(null).id);
  });

  it("autoPolicyWriteScope: ONE id for the whole app - the policy is an account-wide record, so saves through two hosts share a queue", () => {
    // A per-host id here would let a save still pending through host A run
    // concurrently with a later save through host B, and the slower first
    // request could land last and replace the newer edit.
    expect(autoPolicyWriteScope().id).toBe(autoPolicyWriteScope().id);
    expect(autoPolicyWriteScope().id).not.toContain("host-");
  });

  it("providerAutoJudgeWriteScope: differs per harnessId for the same host", () => {
    expect(providerAutoJudgeWriteScope("host-1", "claude").id).not.toBe(
      providerAutoJudgeWriteScope("host-1", "codex").id,
    );
  });

  it("providerAutoJudgeWriteScope: matches for the same (host, harnessId)", () => {
    expect(providerAutoJudgeWriteScope("host-1", "claude").id).toBe(
      providerAutoJudgeWriteScope("host-1", "claude").id,
    );
  });

  it("providerAutoJudgeWriteScope: a null host gets its own bucket per harness", () => {
    expect(providerAutoJudgeWriteScope(null, "claude").id).not.toBe(
      providerAutoJudgeWriteScope("host-1", "claude").id,
    );
  });
});

// ─── 4d: useProvidersSetAutoJudge captures a scope keyed by host + harness ──

describe("useProvidersSetAutoJudge - scope keyed by host and harness", () => {
  it("passes a scope whose id is keyed by both host and harnessId", () => {
    renderHook(() => useProvidersSetAutoJudge("claude"), {
      wrapper: wrapperWith(new QueryClient()),
    });
    expect(lastCapturedMutation().options.scope?.id).toBe(
      providerAutoJudgeWriteScope("host-1", "claude").id,
    );
  });

  it("gives two different harnessIds two different scopes - serializing them would hold the second write for nothing", () => {
    renderHook(() => useProvidersSetAutoJudge("claude"), {
      wrapper: wrapperWith(new QueryClient()),
    });
    const claudeScope = lastCapturedMutation().options.scope;

    renderHook(() => useProvidersSetAutoJudge("codex"), {
      wrapper: wrapperWith(new QueryClient()),
    });
    const codexScope = lastCapturedMutation().options.scope;

    expect(claudeScope?.id).not.toBe(codexScope?.id);
  });
});
