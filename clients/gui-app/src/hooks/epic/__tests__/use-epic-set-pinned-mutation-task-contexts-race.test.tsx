import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  GetTaskContextsResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * PR 2150 cold-review fix: a menu-open retry can put an `epic.getTaskContexts`
 * refetch in flight BEFORE a sibling tab's pin write, and that refetch can
 * still be running when the write's own RPC comes back - so without
 * intervention its stale response lands AFTER the commit and puts the
 * pre-write bit back, forever (`staleTime: Infinity` means nothing asks
 * again). `onMutate` and `onSuccess` in `use-epic-set-pinned-mutation.ts` now
 * cancel any in-flight `epic.getTaskContexts` refetch for the written epic
 * (`revert: false`, keeping its last-good data) and `onSuccess` re-applies the
 * committed bit directly - this drives the REAL mutation (not the
 * `useHostMutation`-mocking harness `use-epic-set-pinned-mutation.test.tsx`
 * uses) against a REAL `QueryClient` so the cancellation is actually
 * exercised, not merely asserted about.
 */

const HOST_ID = "host-1";
const USER_ID = "user-1";

interface SetPinnedRequest {
  readonly epicId: string;
  readonly pinned: boolean;
}

/**
 * Flips the NEXT `epic.setPinned` dispatch into a rejection, for the
 * failed-write regression test below. A holder rather than a `let` re-read
 * per test: `mockClient.request` closes over it once at module scope, and
 * every test resets it in `afterEach` so a failure requested by one test
 * cannot leak into the next.
 */
const failNextRequest = { value: false };

const mockClient = {
  getActiveHostId: () => HOST_ID,
  getRequestContextUserId: () => USER_ID,
  request: (_method: string, params: unknown) => {
    if (failNextRequest.value) {
      failNextRequest.value = false;
      return Promise.reject(new Error("epic.setPinned rejected"));
    }
    const { pinned } = params as SetPinnedRequest;
    return Promise.resolve({ pinned });
  },
};

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Real `useHostMutation` (unlike `use-epic-set-pinned-mutation.test.tsx`,
// which mocks it to capture `onMutate`/`onSuccess` and call them by hand) -
// this test needs the actual TanStack dispatch so the cache cancellation is
// exercised for real, not merely narrated. Only the host client/binding are
// faked, matching that file's own setup for the same reason it gives.
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => mockClient,
  useHostBinding: () => ({
    hostId: HOST_ID,
    hostClient: {
      ...mockClient,
      createRequesterForHostId: (hostId: string) => ({
        ...mockClient,
        getActiveHostId: () => hostId,
      }),
    },
  }),
}));

import { useEpicSetPinned } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
const CONTEXT = { userId: USER_ID, username: "U" };

function listTaskLight(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: epicId,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 0,
        updatedAt: 0,
        createdBy: USER_ID,
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned,
  };
}

function foundResponse(
  epicId: string,
  pinned: boolean,
): GetTaskContextsResponse {
  return {
    tasks: { row: { status: "found", task: listTaskLight(epicId, pinned) } },
    localHomedTaskIds: undefined,
  };
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicSetPinned - task-contexts cache race (PR 2150 cold review)", () => {
  afterEach(() => {
    useAuthStore.getState().setSignedOut();
    failNextRequest.value = false;
  });

  it("a stale in-flight getTaskContexts refetch requested before the write cannot land after it settles", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-b",
    ]);
    let fetchCount = 0;
    // A holder, not a `let`: assigned only inside the queryFn closure, a
    // `let` would be narrowed to its `null` initializer at the call below.
    const stale: {
      resolve: ((value: GetTaskContextsResponse) => void) | null;
    } = { resolve: null };
    const observer = new QueryObserver<GetTaskContextsResponse>(queryClient, {
      queryKey: taskContextsKey,
      queryFn: () => {
        fetchCount += 1;
        // The first fetch settles normally; the second - the menu-open
        // retry - is held open until the test resolves it by hand, well
        // after the write below has settled.
        if (fetchCount === 1) {
          return Promise.resolve(foundResponse("epic-b", true));
        }
        return new Promise<GetTaskContextsResponse>((resolve) => {
          stale.resolve = resolve;
        });
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitFor(() => {
      expect(observer.getCurrentResult().data).toBeDefined();
    });
    expect(fetchCount).toBe(1);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey)?.tasks
        .row,
    ).toEqual({ status: "found", task: listTaskLight("epic-b", true) });

    // The menu-open retry: a background refetch of the SAME query, still in
    // flight when the write below dispatches.
    void observer.refetch();
    await waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(true);
    });
    expect(fetchCount).toBe(2);

    const { result } = renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    // The write: unpin epic-b. `onMutate` cancels the in-flight refetch above
    // before dispatching, and `onSuccess` re-applies the committed bit once
    // the RPC (the mocked client's `request`) resolves.
    await result.current.mutateAsync({
      epicId: "epic-b",
      pinned: false,
      isLocalHome: false,
      hostId: null,
    });

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey)?.tasks
        .row,
    ).toEqual({ status: "found", task: listTaskLight("epic-b", false) });

    // Now the stale response the retry kicked off BEFORE the write finally
    // lands, after the write has already settled. Without the fix's
    // cancellation this overwrites the cache back to the pre-write `true`
    // and nothing ever asks again (`staleTime: Infinity`).
    stale.resolve?.(foundResponse("epic-b", true));
    // Flush whatever microtask/timer chain a landed (or, with the fix,
    // discarded) fetch resolution would still run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey)?.tasks
        .row,
    ).toEqual({ status: "found", task: listTaskLight("epic-b", false) });

    stop();
  });

  /**
   * Small review fix on top of the above: the committed-bit re-patch in
   * `onSuccess` now scopes `setEpicPinnedInTaskContextsCaches` with
   * `hostId: null` - every host's task-contexts cache for this user, not just
   * the dispatch host's. Before, an unpin dispatched to host-1 left a SECOND
   * host's own `epic.getTaskContexts` cache holding the pre-write `found` row
   * forever (`staleTime: Infinity`, nothing ever asks again). The optimistic
   * patch and its `onError` rollback stay host-scoped on purpose - the
   * rollback inverts the bit, which is only right where the pre-write bit was
   * the opposite, true of the dispatch host's own copy and not of another
   * host's - so this is exercised through `onSuccess` alone.
   */
  it("a successful write patches a SECOND host's task-contexts cache too, not only the dispatch host's", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const otherHostKey = hostQueryKeys.epicTaskContexts("host-2", USER_ID, [
      "epic-b",
    ]);
    queryClient.setQueryData<GetTaskContextsResponse>(
      otherHostKey,
      foundResponse("epic-b", true),
    );

    const { result } = renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    // Dispatch follows the window's host (`hostId: null` in the variables),
    // which this harness's mocked binding resolves to HOST_ID - a different
    // host from the one whose cache is seeded above.
    await result.current.mutateAsync({
      epicId: "epic-b",
      pinned: false,
      isLocalHome: false,
      hostId: null,
    });

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(otherHostKey)?.tasks
        .row,
    ).toEqual({ status: "found", task: listTaskLight("epic-b", false) });
  });

  it("leaves a second host's task-contexts cache untouched when the write fails", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const otherHostKey = hostQueryKeys.epicTaskContexts("host-2", USER_ID, [
      "epic-b",
    ]);
    const original = foundResponse("epic-b", true);
    queryClient.setQueryData<GetTaskContextsResponse>(otherHostKey, original);

    failNextRequest.value = true;
    const { result } = renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    await expect(
      result.current.mutateAsync({
        epicId: "epic-b",
        pinned: false,
        isLocalHome: false,
        hostId: null,
      }),
    ).rejects.toThrow();

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(otherHostKey),
    ).toEqual(original);
  });

  /**
   * Review fix on top of the above two: `onSuccess` now also calls
   * `restartInFlightFirstTaskContextsReads`. `cancelInFlightTaskContextsReads`
   * (the helper the first test in this file exercises) deliberately skips a
   * FIRST fetch - one that holds no data yet - because cancelling it alone
   * would strand it pending and idle with nothing to show. But that fetch was
   * requested BEFORE the write committed, so the response it eventually
   * delivers is exactly the same kind of late, pre-write answer the stale
   * REFETCH case is guarding against, and `staleTime: Infinity` would keep it
   * forever. The fix cancels it (`revert: true`, so no error state - see the
   * next test) and starts a fresh fetch in its place.
   */
  it("restarts a data-less first fetch requested before the write, so its stale answer cannot become the cached one", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-b",
    ]);
    let fetchCount = 0;
    // Assigned only inside the queryFn closure below - see the identical
    // pattern's own note in the first test in this file for why this is a
    // holder rather than a `let`.
    const stale: {
      resolve: ((value: GetTaskContextsResponse) => void) | null;
    } = { resolve: null };
    const observer = new QueryObserver<GetTaskContextsResponse>(queryClient, {
      queryKey: taskContextsKey,
      queryFn: () => {
        fetchCount += 1;
        // The FIRST fetch - requested before the write below - never settles
        // on its own; it holds no data the whole time it is in flight, which
        // is exactly the shape `restartInFlightFirstTaskContextsReads` looks
        // for. The SECOND fetch is the restart's own refetch, and it answers
        // with the COMMITTED bit, as a fetch issued after the write would.
        if (fetchCount === 1) {
          return new Promise<GetTaskContextsResponse>((resolve) => {
            stale.resolve = resolve;
          });
        }
        return Promise.resolve(foundResponse("epic-b", false));
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(true);
    });
    expect(fetchCount).toBe(1);
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey),
    ).toBeUndefined();

    const { result } = renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    // The write: unpin epic-b, while the data-less first fetch above is still
    // in flight. `restartInFlightFirstTaskContextsReads` in `onSuccess`
    // cancels it and fires the second, fresh fetch - fire-and-forget
    // (`void queryClient.refetchQueries(...)`), so it can still be settling
    // after `mutateAsync` itself resolves.
    await result.current.mutateAsync({
      epicId: "epic-b",
      pinned: false,
      isLocalHome: false,
      hostId: null,
    });

    await waitFor(() => {
      expect(fetchCount).toBe(2);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey),
      ).toBeDefined();
    });

    // The stale first fetch finally lands, well after the restart's fresh
    // fetch already answered. Without the fix this is the ONLY fetch in
    // flight and its `pinned: true` becomes the cache's answer, forever
    // (`staleTime: Infinity`).
    stale.resolve?.(foundResponse("epic-b", true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey)?.tasks
        .row,
    ).toEqual({ status: "found", task: listTaskLight("epic-b", false) });
    // Exactly the restart's one extra fetch - not a third one from the stale
    // response somehow being treated as still-current.
    expect(fetchCount).toBe(2);

    stop();
  });

  /**
   * The restart cancels the data-less first fetch with `revert: true`
   * specifically so the cancellation never surfaces as a query ERROR -
   * `revert: false` would, for the instant before the replacement fetch
   * starts (see `restartInFlightFirstTaskContextsReads`'s own comment). An
   * error status is not merely cosmetic here: any observer mounted on this
   * query during that instant would flash an error state for a read the user
   * never asked about and nothing actually failed.
   */
  it("never puts the restarted query into an error state", async () => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const taskContextsKey = hostQueryKeys.epicTaskContexts(HOST_ID, USER_ID, [
      "epic-b",
    ]);
    let fetchCount = 0;
    const stale: {
      resolve: ((value: GetTaskContextsResponse) => void) | null;
    } = { resolve: null };
    const observer = new QueryObserver<GetTaskContextsResponse>(queryClient, {
      queryKey: taskContextsKey,
      queryFn: () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return new Promise<GetTaskContextsResponse>((resolve) => {
            stale.resolve = resolve;
          });
        }
        return Promise.resolve(foundResponse("epic-b", false));
      },
    });
    const statuses: string[] = [];
    const stop = observer.subscribe(() => {
      statuses.push(observer.getCurrentResult().status);
    });
    await waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(true);
    });

    const { result } = renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    await result.current.mutateAsync({
      epicId: "epic-b",
      pinned: false,
      isLocalHome: false,
      hostId: null,
    });

    await waitFor(() => {
      expect(fetchCount).toBe(2);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<GetTaskContextsResponse>(taskContextsKey),
      ).toBeDefined();
    });

    stale.resolve?.(foundResponse("epic-b", true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statuses).not.toContain("error");

    stop();
  });
});
