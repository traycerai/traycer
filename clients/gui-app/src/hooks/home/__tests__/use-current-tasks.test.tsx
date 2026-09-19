/**
 * `useCurrentTasks` through the real query cache: the pin tail is a cached copy
 * of History rows, so it has to obey the same optimistic pin / rename patches as
 * the first page, and a placeholder or a locally-incomplete first page must not
 * be read as the settled one.
 *
 * Only the edges are faked: the first-page hook is a real `useQuery` under the
 * real key (so a patch on that key reaches it, and `isPlaceholderData` is
 * TanStack's own), and the cursor RPC is a spy.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  ListTaskLight,
  ListTasksCompleteness,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  useCurrentTasks,
  type CurrentTasks,
} from "@/hooks/home/use-current-tasks";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  reconcileAuthoritativeEpicTitleInCloudTaskCaches,
  setEpicPinnedInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { cloudQueryKeys } from "@/lib/query-keys";
import { useEpicSetPinned } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";

const HOST_ID = "host-1";
const USER_ID = "user-1";
const SCOPE = { hostId: HOST_ID, userId: USER_ID };

interface CursorPageArgs {
  readonly request: typeof LIST_CLOUD_TASKS_REQUEST;
  readonly cursor: string;
  readonly abortSignal: AbortSignal | undefined;
}

interface LocalRowsReading {
  readonly tasks: ReadonlyArray<{
    readonly task: ListTaskLight;
    readonly hostId: string;
  }>;
  readonly pinnedStates: ReadonlyMap<string, boolean>;
  readonly hostIds: ReadonlyMap<string, string>;
  readonly isFetching: boolean;
}

const NO_LOCAL_ROWS: LocalRowsReading = {
  tasks: [],
  pinnedStates: new Map(),
  hostIds: new Map(),
  isFetching: false,
};

const testState = vi.hoisted(() => {
  const state: {
    firstPage: ListTasksResponse | undefined;
    placeholder: ListTasksResponse | undefined;
    firstPageNeverSettles: boolean;
    /** The host the mocked window is bound to; a test moves it to switch hosts. */
    hostId: string;
    /** First pages for hosts other than `host-1`, whose page is `firstPage`. */
    pagesByHost: Record<string, ListTasksResponse | undefined>;
    /** Hosts whose first-page request rejects. */
    failingHosts: Set<string>;
    /** Session ids of the open tabs `useOpenTabEpicIds` reports. */
    openEpicIds: string[];
    /** What the owner-host local read answers for those tabs. */
    localRows: LocalRowsReading;
  } = {
    firstPage: undefined,
    placeholder: undefined,
    firstPageNeverSettles: false,
    hostId: "host-1",
    pagesByHost: {},
    failingHosts: new Set(),
    openEpicIds: [],
    localRows: {
      tasks: [],
      pinnedStates: new Map(),
      hostIds: new Map(),
      isFetching: false,
    },
  };
  return state;
});

const fetchCursorPage = vi.hoisted(() =>
  vi.fn<
    (
      hostId: string,
      userId: string,
      args: CursorPageArgs,
    ) => Promise<ListTasksResponse>
  >(),
);

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => {
    const hostId = testState.hostId;
    const query = useQuery(
      queryOptions<ListTasksResponse>({
        queryKey: cloudEpicTasksQueryKey(
          hostId,
          USER_ID,
          LIST_CLOUD_TASKS_REQUEST,
        ),
        queryFn: () => {
          if (testState.failingHosts.has(hostId)) {
            return Promise.reject(new Error("first page failed"));
          }
          const firstPage =
            hostId === HOST_ID
              ? testState.firstPage
              : testState.pagesByHost[hostId];
          if (testState.firstPageNeverSettles || firstPage === undefined) {
            return new Promise<ListTasksResponse>(() => undefined);
          }
          return Promise.resolve(firstPage);
        },
        staleTime: Infinity,
        placeholderData: testState.placeholder,
      }),
    );
    return {
      query,
      hostId,
      currentUserId: USER_ID,
      isCloudPagePending: false,
      initialLegRefused: false,
    };
  },
}));

vi.mock("@/lib/cloud-epic-tasks-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cloud-epic-tasks-query")>();
  return { ...actual, fetchCloudEpicTasksCursorPageByHostId: fetchCursorPage };
});

const NO_TASK_CONTEXTS = vi.hoisted(() => ({
  tasksById: new Map<string, never>(),
  localHomedTaskIds: new Set<string>(),
  isFetching: false,
}));

const taskContextRequests = vi.hoisted(() => [] as string[][]);

vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (ids: readonly string[]) => {
    taskContextRequests.push([...ids]);
    return NO_TASK_CONTEXTS;
  },
}));

vi.mock("@/hooks/home/use-open-tab-epic-ids", () => ({
  useOpenTabEpicIds: () => testState.openEpicIds,
}));

// Only the owner-host read is faked (its transport path is covered against the
// real fetch path in the pinned-states probe); `useCurrentTasks` is real.
vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return { ...actual, useLocalHomedOpenTaskRows: () => testState.localRows };
  },
);

interface PinVariables {
  readonly epicId: string;
  readonly pinned: boolean;
  readonly isLocalHome: boolean;
  readonly hostId: string | null;
}

interface PinResponse {
  readonly pinned: boolean;
}

interface PinContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

interface MockHostMutationArgs {
  readonly options: {
    readonly mutationKey: readonly unknown[];
    readonly onMutate: (variables: PinVariables) => PinContext;
    readonly onSuccess: (
      response: PinResponse,
      variables: PinVariables,
      context: PinContext,
    ) => Promise<void>;
    readonly onError: (
      error: Error,
      variables: PinVariables,
      context: PinContext | undefined,
    ) => void;
  };
}

const pinRpc = vi.hoisted(() =>
  vi.fn<(variables: PinVariables) => Promise<PinResponse>>(),
);

// The REAL `useEpicSetPinned` options (onMutate / onSuccess / onError) run
// through a real `useMutation` on the real query client; only the RPC and the
// host-client plumbing under it are faked.
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: MockHostMutationArgs) =>
    useMutation<PinResponse, Error, PinVariables, PinContext | undefined>({
      mutationKey: args.options.mutationKey,
      mutationFn: (variables) => pinRpc(variables),
      onMutate: args.options.onMutate,
      onSuccess: (response, variables, context) =>
        context === undefined
          ? Promise.resolve()
          : args.options.onSuccess(response, variables, context),
      onError: args.options.onError,
    }),
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  const client = {
    getActiveHostId: () => HOST_ID,
    getRequestContextUserId: () => USER_ID,
  };
  return {
    ...actual,
    useHostClient: () => client,
    useHostBinding: () => ({ hostId: HOST_ID, hostClient: client }),
  };
});

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

function task(
  epicId: string,
  pinned: boolean,
  title: string,
  home: "local" | "cloud" | undefined,
): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: USER_ID,
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
    ...(home === undefined ? {} : { home }),
  };
}

function pinnedTask(epicId: string): ListTaskLight {
  return task(epicId, true, epicId, undefined);
}

function page(
  tasks: readonly ListTaskLight[],
  nextCursor: string | null,
  completeness: ListTasksCompleteness | null,
): ListTasksResponse {
  return {
    tasks: [...tasks],
    hasMore: nextCursor !== null,
    ...(nextCursor === null ? {} : { nextCursor }),
    ...(completeness === null ? {} : { completeness }),
  };
}

const SETTLED: ListTasksCompleteness = {
  cloudPage: "settled",
  facets: "server",
  localRows: "none",
  sort: "server",
};

function wrapperFor(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function pinnedIds(result: { readonly current: CurrentTasks }): string[] {
  return result.current.groups.pinned.map((item) => item.epicId);
}

beforeEach(() => {
  fetchCursorPage.mockReset();
  pinRpc.mockReset();
  pinRpc.mockImplementation((variables) =>
    Promise.resolve({ pinned: variables.pinned }),
  );
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: USER_ID, userName: "U", email: "u@example.com" },
      { userId: USER_ID, username: "U" },
      [],
    );
  testState.firstPage = undefined;
  testState.placeholder = undefined;
  testState.firstPageNeverSettles = false;
  testState.hostId = HOST_ID;
  testState.pagesByHost = {};
  testState.failingHosts = new Set();
  testState.openEpicIds = [];
  testState.localRows = NO_LOCAL_ROWS;
  taskContextRequests.length = 0;
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    deletedEpicIdsByScope: {},
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("useCurrentTasks pin tail", () => {
  async function renderWithTail() {
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    fetchCursorPage.mockResolvedValue(
      page([pinnedTask("tail-only")], null, null),
    );
    const queryClient = newQueryClient();
    const rendered = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(pinnedIds(rendered.result)).toContain("tail-only");
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    return { queryClient, ...rendered };
  }

  it("unpins a tail-only task immediately and restores it when the pin is rolled back", async () => {
    const { queryClient, result } = await renderWithTail();

    act(() => {
      setEpicPinnedInCloudTaskCaches(queryClient, SCOPE, "tail-only", false);
    });
    await waitFor(() => {
      expect(pinnedIds(result)).toEqual(["first-pin"]);
    });

    // `onError` inverts the same patch.
    act(() => {
      setEpicPinnedInCloudTaskCaches(queryClient, SCOPE, "tail-only", true);
    });
    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual(["first-pin", "tail-only"]);
    });
    // Neither write needed the network: the patch, not a refetch, moved the row.
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
  });

  it("renames a tail-only task", async () => {
    const { queryClient, result } = await renderWithTail();
    // An authoritative rename also restarts the tail scan, so the server's
    // answer to that fresh scan has to carry the rename, as the real one would.
    fetchCursorPage.mockResolvedValue(
      page(
        [task("tail-only", true, "Renamed in History", undefined)],
        null,
        null,
      ),
    );

    act(() => {
      reconcileAuthoritativeEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "tail-only",
        "Renamed in History",
      );
    });

    await waitFor(() => {
      const row = result.current.groups.pinned.find(
        (item) => item.epicId === "tail-only",
      );
      expect(row?.title).toBe("Renamed in History");
    });
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(2);
    });
  });

  it("patches a tail row for a passive title write-through without rescanning the tail", async () => {
    const { queryClient, result } = await renderWithTail();

    act(() => {
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "tail-only",
        "Passively repaired",
      );
    });
    // The same write again, now unchanged: still nothing to rescan.
    act(() => {
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "tail-only",
        "Passively repaired",
      );
    });

    await waitFor(() => {
      expect(
        result.current.groups.pinned.find((item) => item.epicId === "tail-only")
          ?.title,
      ).toBe("Passively repaired");
    });
    await flushDeliveries();
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(
        cloudQueryKeys.currentTasksPinTail(HOST_ID, USER_ID, "cursor-1"),
      )?.isInvalidated,
    ).toBe(false);
  });

  it("does not let a stale tail duplicate override the first-page row", async () => {
    testState.firstPage = page(
      [pinnedTask("dup"), pinnedTask("other-pin")],
      "cursor-1",
      SETTLED,
    );
    fetchCursorPage.mockResolvedValue(
      page([task("dup", true, "stale tail title", undefined)], null, null),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(1);
      expect(pinnedIds(result)).toContain("dup");
    });
    // Let the tail land, then move ONLY the first page: rename it and unpin it,
    // leaving the cached tail copy stale.
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          cloudQueryKeys.currentTasksPinTail(HOST_ID, USER_ID, "cursor-1"),
        ),
      ).toBeDefined();
    });
    act(() => {
      queryClient.setQueryData<ListTasksResponse>(
        cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
        page(
          [
            task("dup", true, "fresh first-page title", undefined),
            pinnedTask("other-pin"),
          ],
          "cursor-1",
          SETTLED,
        ),
      );
    });

    await waitFor(() => {
      const row = result.current.groups.pinned.find(
        (item) => item.epicId === "dup",
      );
      expect(row?.title).toBe("fresh first-page title");
    });
    expect(
      result.current.groups.pinned.filter((item) => item.epicId === "dup"),
    ).toHaveLength(1);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sortedPinnedIds(result: { readonly current: HookResult }): string[] {
  return pinnedIds({ current: result.current.tasks }).sort();
}

function titleOf(
  result: { readonly current: HookResult },
  epicId: string,
): string | undefined {
  return result.current.tasks.groups.pinned.find(
    (item) => item.epicId === epicId,
  )?.title;
}

interface HookResult {
  readonly tasks: CurrentTasks;
  readonly pin: { readonly mutate: (variables: PinVariables) => void };
}

function unpin(epicId: string): PinVariables {
  return { epicId, pinned: false, isLocalHome: false, hostId: null };
}

/** Lets an already-settled promise deliver to whatever was awaiting it. */
async function flushDeliveries(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

describe("useCurrentTasks initial tail vs. an authoritative write", () => {
  it("cannot re-pin a row through a stale initial tail after a successful unpin", async () => {
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    const stale = deferred<ListTasksResponse>();
    fetchCursorPage
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(page([pinnedTask("tail-y")], null, null));
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => ({ tasks: useCurrentTasks(), pin: useEpicSetPinned() }),
      { wrapper: wrapperFor(queryClient) },
    );
    // The first scan is in flight and has never produced data.
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    });
    expect(
      queryClient.getQueryData(
        cloudQueryKeys.currentTasksPinTail(HOST_ID, USER_ID, "cursor-1"),
      ),
    ).toBeUndefined();

    act(() => {
      result.current.pin.mutate(unpin("tail-x"));
    });

    // The reconciliation abandons the delayed scan and starts a fresh one; the
    // first page refetches with the SAME cursor, so the key never moves.
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual(["first-pin", "tail-y"]);
    });

    // The abandoned response finally lands, still carrying the old pin.
    stale.resolve(page([pinnedTask("tail-x")], null, null));
    await flushDeliveries();

    expect(sortedPinnedIds(result)).toEqual(["first-pin", "tail-y"]);
    expect(fetchCursorPage).toHaveBeenCalledTimes(2);
  });

  it("cannot restore an old title through a stale initial tail after a rename", async () => {
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    const stale = deferred<ListTasksResponse>();
    fetchCursorPage
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(
        page([task("tail-x", true, "Renamed", undefined)], null, null),
      );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => ({ tasks: useCurrentTasks(), pin: useEpicSetPinned() }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    });

    // What `useEpicUpdateTitle`'s `onSuccess` does. The optimistic title patch
    // skips the tail's undefined data, so only the restart can keep it right.
    act(() => {
      reconcileAuthoritativeEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "tail-x",
        "Renamed",
      );
    });

    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(titleOf(result, "tail-x")).toBe("Renamed");
    });

    stale.resolve(
      page([task("tail-x", true, "Old title", undefined)], null, null),
    );
    await flushDeliveries();

    expect(titleOf(result, "tail-x")).toBe("Renamed");
    expect(fetchCursorPage).toHaveBeenCalledTimes(2);
  });
});

describe("useCurrentTasks unpinning a first-page row with a cached tail", () => {
  const TAIL_PINS = ["tail-1", "tail-2"];

  async function renderWithCachedTail() {
    testState.firstPage = page(
      [pinnedTask("first-a"), pinnedTask("first-b"), pinnedTask("first-c")],
      "cursor-1",
      SETTLED,
    );
    fetchCursorPage.mockImplementation(
      (_hostId: string, _userId: string, args: { readonly cursor: string }) =>
        Promise.resolve(
          args.cursor === "cursor-1"
            ? page(TAIL_PINS.map(pinnedTask), null, null)
            : page([pinnedTask("tail-2")], null, null),
        ),
    );
    const queryClient = newQueryClient();
    const rendered = renderHook(
      () => ({ tasks: useCurrentTasks(), pin: useEpicSetPinned() }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => {
      expect(sortedPinnedIds(rendered.result)).toEqual([
        "first-a",
        "first-b",
        "first-c",
        "tail-1",
        "tail-2",
      ]);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    return rendered;
  }

  it("removes only that row from Pinned while the write is in flight and after it succeeds", async () => {
    const { result } = await renderWithCachedTail();
    const rpc = deferred<PinResponse>();
    pinRpc.mockImplementation(() => rpc.promise);

    act(() => {
      result.current.pin.mutate(unpin("first-b"));
    });

    // The optimistic patch flipped a bit; it is not a page-boundary observation,
    // so the admitted tail stays.
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual([
        "first-a",
        "first-c",
        "tail-1",
        "tail-2",
      ]);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);

    // The server's truth: the unpinned row is gone from the prefix and the next
    // tail pin moved up onto the first page.
    testState.firstPage = page(
      [pinnedTask("first-a"), pinnedTask("first-c"), pinnedTask("tail-1")],
      "cursor-2",
      SETTLED,
    );
    await act(async () => {
      rpc.resolve({ pinned: false });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledWith(
        HOST_ID,
        USER_ID,
        expect.objectContaining({
          request: LIST_CLOUD_TASKS_REQUEST,
          cursor: "cursor-2",
        }),
      );
    });
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual([
        "first-a",
        "first-c",
        "tail-1",
        "tail-2",
      ]);
    });
  });

  it("removes only that row from Pinned while the write is in flight and restores it on rollback", async () => {
    const { result } = await renderWithCachedTail();
    const rpc = deferred<PinResponse>();
    pinRpc.mockImplementation(() => rpc.promise);

    act(() => {
      result.current.pin.mutate(unpin("first-b"));
    });
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual([
        "first-a",
        "first-c",
        "tail-1",
        "tail-2",
      ]);
    });

    await act(async () => {
      rpc.reject(new Error("rpc failed"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual([
        "first-a",
        "first-b",
        "first-c",
        "tail-1",
        "tail-2",
      ]);
    });
    // The tail was never abandoned, so nothing rescanned.
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
  });
});

describe("useCurrentTasks first-page authority", () => {
  it("never reads a placeholder page as complete/empty", () => {
    // A filtered History page for the same host/user: empty and `hasMore:false`.
    testState.placeholder = page([], null, SETTLED);
    testState.firstPageNeverSettles = true;

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(result.current.pinsComplete).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(result.current.groups.pinned).toEqual([]);
  });

  it("never seeds the tail cursor from a placeholder, but still shows its pinned rows", () => {
    testState.placeholder = page(
      [pinnedTask("filtered-pin")],
      "filtered-cursor",
      SETTLED,
    );
    testState.firstPageNeverSettles = true;

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    expect(fetchCursorPage).not.toHaveBeenCalled();
    expect(result.current.pinsComplete).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(pinnedIds(result)).toEqual(["filtered-pin"]);
  });

  it("claims completeness once the real first page settles", async () => {
    testState.firstPage = page([pinnedTask("real-pin")], null, SETTLED);
    testState.placeholder = page([], null, SETTLED);

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await waitFor(() => {
      expect(result.current.pinsComplete).toBe(true);
    });
    expect(result.current.isPending).toBe(false);
    expect(pinnedIds(result)).toEqual(["real-pin"]);
  });

  it.each(["truncated", "suppressed-unprovable-filter"] as const)(
    "withholds completeness, without pending, when localRows is %s",
    async (localRows) => {
      testState.firstPage = page([pinnedTask("cloud-pin")], null, {
        ...SETTLED,
        localRows,
      });

      const { result } = renderHook(() => useCurrentTasks(), {
        wrapper: wrapperFor(newQueryClient()),
      });

      await waitFor(() => {
        expect(pinnedIds(result)).toEqual(["cloud-pin"]);
      });
      expect(result.current.pinsComplete).toBe(false);
      expect(result.current.isPending).toBe(false);
    },
  );
});

/** Answers a cursor request from the pin tails keyed by their first cursor. */
function serveTails(tails: Readonly<Record<string, readonly string[]>>): void {
  fetchCursorPage.mockImplementation(
    (_hostId: string, _userId: string, args: CursorPageArgs) =>
      Promise.resolve(
        page((tails[args.cursor] ?? []).map(pinnedTask), null, null),
      ),
  );
}

describe("useCurrentTasks across a host switch", () => {
  const HOST_B = "host-2";

  function seedHosts(): void {
    testState.firstPage = page(
      [pinnedTask("a-first-1"), pinnedTask("a-first-2")],
      "a-cursor",
      SETTLED,
    );
    testState.pagesByHost = {
      [HOST_B]: page([pinnedTask("b-first")], "b-cursor", SETTLED),
    };
    serveTails({ "a-cursor": ["a-tail"], "b-cursor": ["b-tail"] });
  }

  function cursorRequestsFor(hostId: string): string[] {
    return fetchCursorPage.mock.calls
      .filter((call) => call[0] === hostId)
      .map((call) => call[2].cursor);
  }

  it("never hands host A's boundary to host B while a pin write is pending on A", async () => {
    seedHosts();
    const queryClient = newQueryClient();
    const { result, rerender } = renderHook(
      () => ({ tasks: useCurrentTasks(), pin: useEpicSetPinned() }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual([
        "a-first-1",
        "a-first-2",
        "a-tail",
      ]);
    });

    // A's write stays in the air for the whole test.
    const rpc = deferred<PinResponse>();
    pinRpc.mockImplementation(() => rpc.promise);
    act(() => {
      result.current.pin.mutate(unpin("a-first-2"));
    });
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual(["a-first-1", "a-tail"]);
    });

    testState.hostId = HOST_B;
    rerender();

    // B is not held by A's write: its own tail is requested now and shown,
    // and nothing of A's page or tail is read for it.
    await waitFor(() => {
      expect(sortedPinnedIds(result)).toEqual(["b-first", "b-tail"]);
    });
    expect(cursorRequestsFor(HOST_B)).toEqual(["b-cursor"]);
    expect(cursorRequestsFor(HOST_ID)).toEqual(["a-cursor"]);

    await act(async () => {
      rpc.resolve({ pinned: false });
      await Promise.resolve();
    });
    await flushDeliveries();
    expect(sortedPinnedIds(result)).toEqual(["b-first", "b-tail"]);
  });

  async function renderBothHostsVisited() {
    seedHosts();
    const queryClient = newQueryClient();
    const rendered = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(pinnedIds(rendered.result).sort()).toEqual([
        "a-first-1",
        "a-first-2",
        "a-tail",
      ]);
    });
    return { queryClient, ...rendered };
  }

  async function failFirstPageRefetch(
    queryClient: QueryClient,
    hostId: string,
  ): Promise<void> {
    // Later refetches of this page fail too, whichever observer starts them.
    testState.failingHosts.add(hostId);
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: cloudEpicTasksQueryKey(
            hostId,
            USER_ID,
            LIST_CLOUD_TASKS_REQUEST,
          ),
          queryFn: () => Promise.reject(new Error("refetch failed")),
          staleTime: 0,
        })
        .catch(() => undefined);
    });
    expect(
      queryClient.getQueryState(
        cloudEpicTasksQueryKey(hostId, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      )?.status,
    ).toBe("error");
  }

  it("resumes on B's own last boundary, not A's, when B's cached first page is in a refetch error", async () => {
    const { queryClient, result, rerender } = await renderBothHostsVisited();

    testState.hostId = HOST_B;
    rerender();
    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual(["b-first", "b-tail"]);
    });
    testState.hostId = HOST_ID;
    rerender();
    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual([
        "a-first-1",
        "a-first-2",
        "a-tail",
      ]);
    });
    await failFirstPageRefetch(queryClient, HOST_B);
    const requestsBefore = fetchCursorPage.mock.calls.length;

    testState.hostId = HOST_B;
    rerender();

    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual(["b-first", "b-tail"]);
    });
    await flushDeliveries();
    expect(pinnedIds(result)).not.toContain("a-tail");
    expect(fetchCursorPage.mock.calls.length).toBe(requestsBefore);
  });

  it("reads B as unavailable, never as A's scan, when B has no boundary and its cached first page is in a refetch error", async () => {
    const { queryClient, result, rerender } = await renderBothHostsVisited();
    // B's page is cached without B ever having been observed.
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(HOST_B, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      page([pinnedTask("b-first")], "b-cursor", SETTLED),
    );
    await failFirstPageRefetch(queryClient, HOST_B);

    testState.hostId = HOST_B;
    rerender();

    await waitFor(() => {
      expect(pinnedIds(result)).toEqual(["b-first"]);
    });
    await flushDeliveries();
    expect(result.current.pinsComplete).toBe(false);
    expect(cursorRequestsFor(HOST_B)).toEqual([]);
    expect(cursorRequestsFor(HOST_ID)).toEqual(["a-cursor"]);
  });
});

describe("useCurrentTasks remounting while a first-page unpin is in flight", () => {
  const FIRST_PAGE_PINS = ["first-a", "first-b", "first-c"];
  const UNRELATED_TAIL_PINS = ["tail-1", "tail-2"];

  // Stands in for the History modal: a hook that outlives Current tasks and
  // owns the pin write, so the write runs while Current tasks is unmounted.
  async function unmountThenUnpin() {
    testState.firstPage = page(
      FIRST_PAGE_PINS.map(pinnedTask),
      "cursor-1",
      SETTLED,
    );
    serveTails({ "cursor-1": UNRELATED_TAIL_PINS });
    const queryClient = newQueryClient();
    const wrapper = wrapperFor(queryClient);
    const modal = renderHook(() => useEpicSetPinned(), { wrapper });
    const first = renderHook(() => useCurrentTasks(), { wrapper });
    await waitFor(() => {
      expect(pinnedIds(first.result).sort()).toEqual([
        ...FIRST_PAGE_PINS,
        ...UNRELATED_TAIL_PINS,
      ]);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    first.unmount();

    const rpc = deferred<PinResponse>();
    pinRpc.mockImplementation(() => rpc.promise);
    act(() => {
      modal.result.current.mutate(unpin("first-b"));
    });
    await waitFor(() => {
      const cached = queryClient.getQueryData<ListTasksResponse>(
        cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
      );
      expect(
        cached?.tasks.find((row) => row.epic?.light?.id === "first-b")?.pinned,
      ).toBe(false);
    });

    // Closing the modal: Current tasks mounts on the optimistic page, before
    // the response.
    const remounted = renderHook(() => useCurrentTasks(), { wrapper });
    return { queryClient, remounted, rpc };
  }

  const WITHOUT_FIRST_B = ["first-a", "first-c", ...UNRELATED_TAIL_PINS];

  it("keeps the unrelated cached tail pins visible on the optimistic page and after the write succeeds", async () => {
    const { remounted, rpc } = await unmountThenUnpin();

    await waitFor(() => {
      expect(pinnedIds(remounted.result).sort()).toEqual(WITHOUT_FIRST_B);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);

    testState.firstPage = page(
      [pinnedTask("first-a"), pinnedTask("first-c"), pinnedTask("tail-1")],
      "cursor-2",
      SETTLED,
    );
    serveTails({ "cursor-2": ["tail-2"] });
    await act(async () => {
      rpc.resolve({ pinned: false });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(pinnedIds(remounted.result).sort()).toEqual(WITHOUT_FIRST_B);
    });
    expect(fetchCursorPage).toHaveBeenLastCalledWith(
      HOST_ID,
      USER_ID,
      expect.objectContaining({ cursor: "cursor-2" }),
    );
  });

  it("keeps the server-observed boundary when reconciliation fails after the write succeeded", async () => {
    const { queryClient, remounted, rpc } = await unmountThenUnpin();
    await waitFor(() => {
      expect(pinnedIds(remounted.result).sort()).toEqual(WITHOUT_FIRST_B);
    });

    // The write succeeds; the first-page reconciliation that follows fails, so
    // the cache keeps the optimistic page and `isRefetchError` outlives the
    // write.
    testState.failingHosts.add(HOST_ID);
    await act(async () => {
      rpc.resolve({ pinned: false });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryState(
          cloudEpicTasksQueryKey(HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
        )?.status,
      ).toBe("error");
    });
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
    await flushDeliveries();

    expect(pinnedIds(remounted.result).sort()).toEqual(WITHOUT_FIRST_B);
    // Only the boundary the server last showed was ever scanned.
    expect(
      fetchCursorPage.mock.calls.every((call) => call[2].cursor === "cursor-1"),
    ).toBe(true);
  });

  it("keeps the unrelated cached tail pins visible and restores the row when the write is rolled back", async () => {
    const { remounted, rpc } = await unmountThenUnpin();
    await waitFor(() => {
      expect(pinnedIds(remounted.result).sort()).toEqual(WITHOUT_FIRST_B);
    });

    await act(async () => {
      rpc.reject(new Error("rpc failed"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(pinnedIds(remounted.result).sort()).toEqual([
        ...FIRST_PAGE_PINS,
        ...UNRELATED_TAIL_PINS,
      ]);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
  });
});

describe("useCurrentTasks restarting a multi-page pin tail", () => {
  it("stops the abandoned cursor loop between pages while the replacement scan proceeds", async () => {
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    const abandonedFirstPage = deferred<ListTasksResponse>();
    fetchCursorPage.mockImplementation(
      (_hostId: string, _userId: string, args: CursorPageArgs) => {
        if (fetchCursorPage.mock.calls.length === 1) {
          return abandonedFirstPage.promise;
        }
        return Promise.resolve(
          args.cursor === "cursor-1"
            ? page([pinnedTask("tail-a")], "cursor-2", null)
            : page([pinnedTask("tail-b")], null, null),
        );
      },
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(queryClient),
    });
    await waitFor(() => {
      expect(fetchCursorPage).toHaveBeenCalledTimes(1);
    });

    // An authoritative rename abandons the in-flight scan and starts a new one.
    act(() => {
      reconcileAuthoritativeEpicTitleInCloudTaskCaches(
        queryClient,
        SCOPE,
        "first-pin",
        "Renamed",
      );
    });
    await waitFor(() => {
      expect(pinnedIds(result).sort()).toEqual([
        "first-pin",
        "tail-a",
        "tail-b",
      ]);
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(3);

    // The abandoned scan's first page finally lands, pointing at more pages.
    abandonedFirstPage.resolve(
      page([pinnedTask("abandoned")], "abandoned-cursor", null),
    );
    await flushDeliveries();

    expect(
      fetchCursorPage.mock.calls.map((call) => call[2].cursor),
    ).not.toContain("abandoned-cursor");
    expect(fetchCursorPage).toHaveBeenCalledTimes(3);
    expect(pinnedIds(result)).not.toContain("abandoned");
  });
});

describe("useCurrentTasks open task owned by another host", () => {
  const HOST_B = "host-b";

  it("shows it as an Open row carrying B (window follows A), the owner's row winning over a stale first-page mirror, and never queries the effective host for it", async () => {
    testState.firstPage = page(
      [task("open-b", true, "Stale mirror title", "cloud")],
      null,
      SETTLED,
    );
    testState.openEpicIds = ["open-b", "open-cloud"];
    testState.localRows = {
      tasks: [
        { task: task("open-b", false, "Owner title", "local"), hostId: HOST_B },
      ],
      pinnedStates: new Map([["open-b", false]]),
      hostIds: new Map([["open-b", HOST_B]]),
      isFetching: false,
    };

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await waitFor(() => {
      expect(result.current.groups.open.map((item) => item.title)).toEqual([
        "Owner title",
      ]);
    });
    expect(result.current.groups.open[0].hostId).toBe(HOST_B);
    expect(result.current.groups.open[0].isLocalHome).toBe(true);
    // The owner says unpinned; the mirror's `pinned: true` must not resurrect it.
    expect(pinnedIds(result)).toEqual([]);
    // Only the id the local read does not own goes to the effective host.
    expect(taskContextRequests.length).toBeGreaterThan(0);
    for (const ids of taskContextRequests) expect(ids).not.toContain("open-b");
  });

  it("drops a row read from a host that does not hold the session", async () => {
    testState.firstPage = page([], null, SETTLED);
    testState.openEpicIds = ["open-b"];
    testState.localRows = {
      tasks: [
        {
          task: task("open-b", false, "Wrong host", "local"),
          hostId: "host-c",
        },
      ],
      pinnedStates: new Map(),
      hostIds: new Map([["open-b", HOST_B]]),
      isFetching: false,
    };

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await waitFor(() => {
      expect(result.current.pinsComplete).toBe(true);
    });
    expect(result.current.groups.open).toEqual([]);
  });
});

describe("useCurrentTasks pin tail under an unverified session", () => {
  const PROFILE = { userId: USER_ID, userName: "U", email: "u@example.com" };
  const CONTEXT = { userId: USER_ID, username: "U" };

  it("fetches no cursor page for a cached pinned first page, and starts the tail once the session verifies", async () => {
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    testState.firstPage = page([pinnedTask("first-pin")], "cursor-1", SETTLED);
    fetchCursorPage.mockResolvedValue(
      page([pinnedTask("tail-only")], null, null),
    );

    const { result } = renderHook(() => useCurrentTasks(), {
      wrapper: wrapperFor(newQueryClient()),
    });

    await waitFor(() => {
      expect(pinnedIds(result)).toEqual(["first-pin"]);
    });
    await flushDeliveries();
    expect(fetchCursorPage).not.toHaveBeenCalled();
    // The tail cannot be read, so completeness must not be claimed.
    expect(result.current.pinsComplete).toBe(false);

    act(() => {
      useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    });
    await waitFor(() => {
      expect(pinnedIds(result)).toContain("tail-only");
    });
    expect(fetchCursorPage).toHaveBeenCalledTimes(1);
  });
});
