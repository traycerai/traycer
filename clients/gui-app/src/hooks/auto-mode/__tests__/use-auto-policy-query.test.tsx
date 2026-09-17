import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

// JOB 1 (Codex, P1): the account-policy cache is partitioned by signed-in
// user. `useAutoPolicyQuery` now folds `viewerUserId` into its cache key
// identity, and `useAutoPolicySetMutation`'s write-through addresses the same
// per-viewer entry through `hostQueryKeys.autoPolicyForViewer` rather than the
// bare method-scope prefix. Before the fix, `["host", hostId, "autoPolicy.get",
// {}]` said nothing about who asked: after A signed out and B signed in on the
// same instance, B's first render was served A's policy body SYNCHRONOUSLY,
// with Edit enabled.
//
// Only the host client boundary is faked here (a real `HostClient` dispatching
// through `MockHostMessenger`); the QueryClient and the auth store are real, so
// the partition is exercised the way the app actually produces it - two
// distinct cache entries under one host, keyed off the real
// `useCloudChatViewerId()` read.

const USER_A = "user-a";
const USER_B = "user-b";

const MICROTASK_FLUSH_TICKS = 20;

/**
 * Drains the microtask queue `MICROTASK_FLUSH_TICKS` times over - the mock
 * messenger runs handlers inline with no transport timers
 * (`MockHostMessenger.request`'s own comment), so every hop from a fired
 * query to its cache write is a microtask, never a real timer. A fixed,
 * generous flush is what lets the SAME assertion work under both regimes
 * this file falsifies against: under the fix nothing is ever dispatched, so
 * the loop is a no-op; under a reverted guard it is enough ticks for the
 * response to actually land in the cache before the next step reads it.
 */
async function flushMicrotasks(): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  for (let i = 0; i < MICROTASK_FLUSH_TICKS; i += 1) {
    chain = chain.then(() => undefined);
  }
  await chain;
}

function authProfile(userId: string): {
  readonly userId: string;
  readonly userName: string;
  readonly email: string;
} {
  return { userId, userName: userId, email: `${userId}@example.com` };
}

function signInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(authProfile(userId), { userId, username: userId }, []);
}

/**
 * A real `HostClient` dispatching `autoPolicy.get` / `autoPolicy.set` through
 * `MockHostMessenger`, so the account-policy hooks under test run their real
 * TanStack wiring end to end. `policies` is a mutable per-viewer store the
 * handlers read/write by `currentBearerUser` - the fixture has no notion of
 * "who is current" on its own; `setBearerUser` moves it in lockstep with
 * `signInAs`, exactly as a real bearer token names the signed-in account.
 */
function createAutoPolicyFixture(
  initialPolicies: Record<string, AutoPolicyGetResponse>,
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly setBearerUser: (userId: string) => void;
  /**
   * How many times the mock host actually dispatched `autoPolicy.get`. The
   * unattributed-viewer cases below assert on this directly rather than on
   * `data`/`fetchStatus`, because a disabled query's `data` stays `undefined`
   * for the same reason a query that was never RENDERED does - only the
   * dispatch count tells "never asked" apart from "asked and still pending".
   */
  readonly getCallCount: () => number;
} {
  const policies: Record<string, AutoPolicyGetResponse> = {
    ...initialPolicies,
  };
  let currentBearerUser = USER_A;
  let setCount = 0;
  let getCount = 0;
  // `gcTime: Infinity`, deliberately NOT 0. A cache entry for a viewer who
  // just unmounted must survive - that lingering entry is the whole hazard
  // JOB 1 closes (it is what a naive `["host", hostId, "autoPolicy.get", {}]`
  // key would serve to the next viewer). With `gcTime: 0` an unmounted
  // entry is purged immediately, and "B does not see A's data" would hold
  // whether or not the partition worked, proving nothing about the key.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "autoPolicy.get": () => {
          getCount += 1;
          return (
            policies[currentBearerUser] ?? {
              body: null,
              updatedAt: null,
              source: "account",
              readState: "fresh",
            }
          );
        },
        "autoPolicy.set": (params) => {
          setCount += 1;
          const updatedAt = `2026-09-16T00:00:0${setCount}.000Z`;
          policies[currentBearerUser] = {
            body: params.body,
            updatedAt,
            source: "account",
            readState: "fresh",
          };
          return { updatedAt };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client,
    queryClient,
    Wrapper,
    setBearerUser: (userId: string) => {
      currentBearerUser = userId;
    },
    getCallCount: () => getCount,
  };
}

const fixtureClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (fixtureClientRef.current === null) {
        throw new Error("fixtureClientRef not set for this test");
      }
      return fixtureClientRef.current;
    },
  };
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
  fixtureClientRef.current = null;
});

describe("useAutoPolicyQuery - per-viewer cache partition", () => {
  it("does not serve viewer A's cached policy synchronously on viewer B's first render", async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;
    signInAs(USER_A);

    const first = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.data?.body).toBe("A's policy");
    });
    first.unmount();

    // The account transitions to B on the same instance. The bearer the
    // fixture's handler sees moves with it - exactly as the real host client
    // resolves the wire request context from the live session.
    fixture.setBearerUser(USER_B);
    signInAs(USER_B);

    const second = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    // Synchronously after mount, before any await: B's key has never held
    // data, so there is nothing to serve. RED before the fix - the shared
    // `["host", hostId, "autoPolicy.get", {}]` key kept A's response cached
    // there and TanStack would have returned it on B's very first render.
    expect(second.result.current.data?.body).not.toBe("A's policy");
    expect(second.result.current.data).toBeUndefined();

    await waitFor(() => {
      expect(second.result.current.data?.body).toBeNull();
    });
  });

  it("gives the two viewers two distinct cache entries under the same host", async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
      [USER_B]: {
        body: "B's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;

    // The two mounts are sequential, not concurrent: `useCloudChatViewerId`
    // reads the one real, global auth store, so two SIMULTANEOUSLY mounted
    // observers can never disagree about who is viewing - only one identity
    // can be live at a time, exactly as on a real machine. A stays cached
    // (gcTime: Infinity) after it unmounts, which is what makes B's later
    // mount a genuine test of the partition rather than of garbage
    // collection.
    signInAs(USER_A);
    const a = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(a.result.current.data?.body).toBe("A's policy"));
    a.unmount();

    fixture.setBearerUser(USER_B);
    signInAs(USER_B);
    const b = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => expect(b.result.current.data?.body).toBe("B's policy"));

    const autoPolicyEntries = fixture.queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[2] === "autoPolicy.get");
    expect(autoPolicyEntries).toHaveLength(2);
    expect(autoPolicyEntries.map((query) => query.state.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "A's policy" }),
        expect.objectContaining({ body: "B's policy" }),
      ]),
    );
  });

  // The write side. Exercises the real `useAutoPolicySetMutation` hook (not a
  // restatement of its `setQueriesData` call), driven through the same
  // fixture, so the assertion is that the PRODUCTION write-through leaves A's
  // entry untouched - not that a hand-written call to the same builder does.
  it("does not let a save made as viewer B overwrite viewer A's cached entry", async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
      [USER_B]: {
        body: "B's original policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;

    // Seed A's entry the same way the panel would - a mounted query - then
    // unmount it, as closing Settings (or switching identity) would. The
    // entry itself survives (gcTime: Infinity); only the observer goes away -
    // which is what makes this a test of the WRITE-THROUGH's key targeting
    // rather than of two components racing the same live auth store (they
    // cannot: see the sibling case above).
    signInAs(USER_A);
    const aQuery = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() =>
      expect(aQuery.result.current.data?.body).toBe("A's policy"),
    );
    aQuery.unmount();

    fixture.setBearerUser(USER_B);
    signInAs(USER_B);
    const bMutation = renderHook(
      () => ({
        query: useAutoPolicyQuery(),
        mutate: useAutoPolicySetMutation(),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(bMutation.result.current.query.data?.body).toBe(
        "B's original policy",
      ),
    );

    bMutation.result.current.mutate.mutate({ body: "B's edited policy" });
    await waitFor(() => {
      expect(bMutation.result.current.mutate.isSuccess).toBe(true);
    });

    // B's own entry reflects the save...
    await waitFor(() => {
      const bEntry = fixture.queryClient.getQueryData<AutoPolicyGetResponse>(
        hostQueryKeys.autoPolicyForViewer(mockLocalHostEntry.hostId, USER_B),
      );
      expect(bEntry?.body).toBe("B's edited policy");
    });

    // ...and A's entry - located from the query CACHE by the key the query
    // itself was created with, not a literal restatement of the key's shape,
    // so a drift between `useHostQuery`'s key-building and
    // `hostQueryKeys.autoPolicyForViewer` would show up here rather than
    // being hidden by two independently-typed-out keys agreeing by luck - is
    // untouched.
    const aEntryKey: QueryKey | undefined = fixture.queryClient
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          query.queryKey[2] === "autoPolicy.get" &&
          query.queryKey[query.queryKey.length - 1] === USER_A,
      )?.queryKey;
    expect(aEntryKey).toBeDefined();
    const aEntry = fixture.queryClient.getQueryData<AutoPolicyGetResponse>(
      aEntryKey ?? [],
    );
    expect(aEntry?.body).toBe("A's policy");
  });
});

// FIX 1 (P1): "" is the ABSENCE of an identity - `useCloudChatViewerId()`
// answers it whenever `contextMetadata` is absent (startup, and the gap
// during an account transition), not a person. Before this fix the read ran
// unconditionally, so the account that happened to be authenticated at the
// HOST while the GUI's own viewer was still unresolved got cached under the
// `""` partition - a bucket every account passes through on its way in, so
// the NEXT account's own unresolved window could be served whatever the
// FIRST one left there. None of these tests ever call `signInAs`, so
// `useCloudChatViewerId()` reads the default signed-out `contextMetadata:
// null` and answers `""` throughout, exactly like the unresolved window.
describe('useAutoPolicyQuery / useAutoPolicySetMutation - the unattributed ("") viewer bucket', () => {
  it("does not fire the read while the viewer is unattributed - the query stays disabled and its data stays undefined", async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;

    const { result } = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });

    // Long enough for a synchronous mock messenger to have dispatched,
    // resolved, and been written into the cache, had the query fired.
    await flushMicrotasks();

    expect(fixture.getCallCount()).toBe(0);
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it('fires exactly once, against the resolved partition, once the viewer resolves from "" to a real id', async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;

    const { result, rerender } = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await flushMicrotasks();
    expect(fixture.getCallCount()).toBe(0);

    signInAs(USER_A);
    rerender();

    await waitFor(() => expect(result.current.data?.body).toBe("A's policy"));
    expect(fixture.getCallCount()).toBe(1);
  });

  // THE LEAK ITSELF (must have been red before the fix - see the falsification
  // note in the report back to the assigning agent). Two mounts, BOTH while
  // the viewer is unattributed (`""`), with the host's own bearer moved to a
  // DIFFERENT account in between - modelling "every account passes through
  // the same [\"\"] bucket on the way in". Pre-fix, mount #1's enabled read
  // would have cached the first account's body under the `[\"\"]` key; mount
  // #2, still keyed `[\"\"]`, would have been served that cached body
  // SYNCHRONOUSLY (TanStack returns a cache hit before any await), with Edit
  // enabled. The assertion is checked immediately after mount #2, before any
  // `waitFor`, for exactly that reason - mirroring the sibling A/B case above.
  it("does not serve one account's policy, landed while unattributed, to a later unattributed render after the host's bearer moves on", async () => {
    const fixture = createAutoPolicyFixture({
      [USER_A]: {
        body: "A's policy, landed while the viewer was unattributed",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
      [USER_B]: {
        body: "B's own policy",
        updatedAt: "2026-09-15T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      },
    });
    fixtureClientRef.current = fixture.client;

    // Mount #1: unattributed, host bearer is A (the default). Flushed fully
    // before unmounting so a reverted guard's response has actually landed
    // in the cache by the time mount #2 reads the same `[""]` key.
    const first = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });
    await flushMicrotasks();
    first.unmount();

    // The host's bearer moves to B - "the gap during an account switch" - but
    // the GUI's own viewer id is STILL unresolved (no signInAs), so
    // `useCloudChatViewerId()` still answers "".
    fixture.setBearerUser(USER_B);

    const second = renderHook(() => useAutoPolicyQuery(), {
      wrapper: fixture.Wrapper,
    });

    // Checked SYNCHRONOUSLY, before any await: nothing was ever cached at
    // `[""]` under the fix, so there is nothing to serve.
    expect(second.result.current.data?.body).not.toBe(
      "A's policy, landed while the viewer was unattributed",
    );
    expect(second.result.current.data).toBeUndefined();
  });

  it("a save made while the viewer is unattributed writes nothing to the cache", async () => {
    const fixture = createAutoPolicyFixture({});
    fixtureClientRef.current = fixture.client;

    // The read is mounted ALONGSIDE the mutation, disabled (viewer is still
    // unattributed) - `enabled: false` still creates the query's cache ENTRY
    // for the `[""]` key, it just never fetches into it. Without a pre-
    // existing entry at that key, `setQueriesData` (a FILTER-matching update,
    // never a create) would have nothing to touch regardless of the guard,
    // which would make this test pass for the wrong reason.
    const { result } = renderHook(
      () => ({
        query: useAutoPolicyQuery(),
        mutation: useAutoPolicySetMutation(),
      }),
      { wrapper: fixture.Wrapper },
    );

    result.current.mutation.mutate({ body: "written while unattributed" });
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));

    // The write-through addresses `hostQueryKeys.autoPolicyForViewer(hostId,
    // viewerUserId)` - with `viewerUserId === ""` that is the same
    // unattributed bucket the read refuses to populate. Nothing should be
    // there after the save either.
    expect(result.current.query.data).toBeUndefined();
    const cached = fixture.queryClient.getQueryData<AutoPolicyGetResponse>(
      hostQueryKeys.autoPolicyForViewer(mockLocalHostEntry.hostId, ""),
    );
    expect(cached).toBeUndefined();
  });
});
