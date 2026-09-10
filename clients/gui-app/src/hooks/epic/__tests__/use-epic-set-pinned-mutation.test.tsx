import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  cloudEpicTasksPageGeneration,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const testState = vi.hoisted(() => {
  const state: { activeHostId: string | null; userId: string | null } = {
    activeHostId: "host-1",
    userId: "user-1",
  };
  return state;
});

const mockClient = {
  getActiveHostId: () => testState.activeHostId,
  getRequestContextUserId: () => testState.userId,
};

// `useHostBinding` is mocked alongside `useHostClient` because the hook resolves
// its client PER DISPATCH now (`variables.hostId`), and a named host's requester
// is built from the binding. The requester reports the host it was asked for, so
// a dispatch that ignored `variables.hostId` and fell back to the window's
// client is observable: `getActiveHostId()` answers the wrong machine.
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => mockClient,
  useHostBinding: () => ({
    hostId: testState.activeHostId,
    hostClient: {
      ...mockClient,
      createRequesterForHostId: (hostId: string) => ({
        ...mockClient,
        getActiveHostId: () => hostId,
      }),
    },
  }),
}));

interface MutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/**
 * The dispatch-side variables shape, stated once. Every production caller
 * supplies `hostId` - the epic's own host, or `null` for "follow the window" -
 * so a fixture that omits it models variables the real callers never produce,
 * and resolves its client down the NAMED-host arm with `undefined`.
 */
interface DispatchVariables {
  readonly epicId: string;
  readonly pinned: boolean;
  readonly isLocalHome: boolean;
  readonly hostId: string | null;
}

/** A cloud-homed row's variables: no host named, so the window is followed. */
function followingVars(epicId: string, pinned: boolean): DispatchVariables {
  return { epicId, pinned, isLocalHome: false, hostId: null };
}

interface CapturedClient {
  readonly getActiveHostId: () => string | null;
  readonly getRequestContextUserId: () => string | null;
}

let capturedOptions: {
  onMutate?: (variables: DispatchVariables) => MutationContext;
  onSuccess?: (
    response: { pinned: boolean },
    variables: DispatchVariables,
    context: MutationContext,
  ) => Promise<void>;
  onError?: (
    error: unknown,
    variables: DispatchVariables,
    context: MutationContext | undefined,
  ) => void;
} = {};

/**
 * The `client` argument, which the hook passes as a FUNCTION of the variables.
 * Captured separately from `options` because it is the dispatch half of the
 * per-row host: `options.onMutate` decides admission and scope, and this
 * decides which machine the request leaves on.
 */
let capturedClientResolver:
  | ((variables: DispatchVariables) => CapturedClient | null)
  | null = null;

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    options: typeof capturedOptions;
    client: (variables: DispatchVariables) => CapturedClient | null;
  }) => {
    capturedOptions = args.options;
    capturedClientResolver = args.client;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import {
  EPIC_PIN_UNAUTHORIZED_MESSAGE,
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { epicMutationKeys, queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };

function epicTask(epicId: string, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title: `Epic ${epicId}`,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
        createdBy: "user-1",
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    phase: null,
    pinned,
  };
}

function pageWith(tasks: readonly ListTaskLight[]): ListTasksResponse {
  return { tasks: [...tasks], hasMore: false };
}

function pinnedById(
  response: ListTasksResponse | undefined,
): Record<string, boolean | undefined> {
  return Object.fromEntries(
    (response?.tasks ?? []).flatMap((task) =>
      task.epic?.light?.id === undefined
        ? []
        : [[task.epic.light.id, task.pinned]],
    ),
  );
}

interface SetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicSetPinned", () => {
  beforeEach(() => {
    capturedOptions = {};
    capturedClientResolver = null;
    vi.clearAllMocks();
    testState.activeHostId = "host-1";
    testState.userId = "user-1";
    // The dispatch re-reads the live verdict; these cases model a session
    // that holds one unless they say otherwise.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("optimistically flips the row in the scoped first page and tails on mutate, leaving other scopes alone", () => {
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherQueryKey = cloudEpicTasksQueryKey(
      "host-2",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false), epicTask("epic-other", true)]),
    );
    queryClient.setQueryData(
      otherQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    const scopedIdentity = "host-1|user-1|recent";
    const otherIdentity = "host-2|user-1|recent";
    const pagesStore = useCloudEpicTasksPagesStore.getState();
    pagesStore.appendPage(
      scopedIdentity,
      cloudEpicTasksPageGeneration(scopedIdentity),
      pageWith([epicTask("epic-1", false)]),
    );
    pagesStore.appendPage(
      otherIdentity,
      cloudEpicTasksPageGeneration(otherIdentity),
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.(followingVars("epic-1", true));

    expect(context).toEqual({ hostId: "host-1", userId: "user-1" });
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": true,
      "epic-other": true,
    });
    expect(pinnedById(queryClient.getQueryData(otherQueryKey))).toEqual({
      "epic-1": false,
    });
    const pages = useCloudEpicTasksPagesStore.getState().pagesByIdentity;
    expect(pinnedById(pages[scopedIdentity][0])).toEqual({ "epic-1": true });
    expect(pinnedById(pages[otherIdentity][0])).toEqual({ "epic-1": false });
    // Mutate time only patches - the tails stay retained (and generations
    // untouched) until the success handler resets the scope's pagination.
    expect(useCloudEpicTasksPagesStore.getState().generationByIdentity).toEqual(
      {},
    );
  });

  it("reverts the optimistic patch and toasts when the RPC fails", () => {
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    const scopedIdentity = "host-1|user-1|recent";
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(
        scopedIdentity,
        cloudEpicTasksPageGeneration(scopedIdentity),
        pageWith([epicTask("epic-1", false)]),
      );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.(followingVars("epic-1", true));
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": true,
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      followingVars("epic-1", true),
      context,
    );

    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });
    expect(
      pinnedById(
        useCloudEpicTasksPagesStore.getState().pagesByIdentity[
          scopedIdentity
        ][0],
      ),
    ).toEqual({ "epic-1": false });
    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });

  it("refuses at dispatch without a cloud verdict, before the optimistic patch", () => {
    // A row rendered while verified and activated after a demotion - or the
    // tab strip's Undo toast outliving its click - reaches this one shared
    // dispatch. It must refuse BEFORE touching a cache, so the refusal's
    // `onError` (which carries no context) has nothing to undo.
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);

    expect(() =>
      capturedOptions.onMutate?.(followingVars("epic-1", true)),
    ).toThrow(EPIC_PIN_UNAUTHORIZED_MESSAGE);
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });

    // Non-vacuity: the verdict returning is what admits the same dispatch.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    capturedOptions.onMutate?.(followingVars("epic-1", true));
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": true,
    });
  });

  it("toasts the unverified copy for a refused dispatch, with no inverse patch", () => {
    const queryClient = new QueryClient();
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    capturedOptions.onError?.(
      {
        code: "RPC_ERROR",
        message: EPIC_PIN_UNAUTHORIZED_MESSAGE,
        fatalDetails: null,
      },
      followingVars("epic-1", true),
      undefined,
    );

    // Nothing was patched, so nothing is un-patched.
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Your sign-in couldn't be confirmed, so cloud changes are paused. Pinning will work again once your sign-in is confirmed.",
    );
  });

  it("leaves every cache untouched when the mutation scope is null", async () => {
    // A signed-out or host-swapping window can leave onMutate's captured
    // scope null; the optimistic patch, the success reconciliation, and the
    // error revert must all no-op rather than touch an unrelated scope.
    testState.activeHostId = null;
    const queryClient = new QueryClient();
    const removeQueries = vi.spyOn(queryClient, "removeQueries");
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.(followingVars("epic-1", true));
    expect(context).toEqual({ hostId: null, userId: "user-1" });
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });

    await capturedOptions.onSuccess?.(
      { pinned: true },
      followingVars("epic-1", true),
      { hostId: null, userId: null },
    );
    expect(removeQueries).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      followingVars("epic-1", true),
      context,
    );
    expect(pinnedById(queryClient.getQueryData(scopedQueryKey))).toEqual({
      "epic-1": false,
    });
    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });

  /**
   * The per-row host, dispatch half. A local-homed epic is served off the
   * OWNING host's disk, so the write has to leave on that host's requester -
   * and `useHostMutation` takes a function of the variables precisely so one
   * hook instance can serve rows on different machines. Named host wins;
   * `null` follows the window.
   */
  it("dispatches a named host's row on that host's requester, and a hostless row on the window's", () => {
    const queryClient = new QueryClient();
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    expect(
      capturedClientResolver?.({
        epicId: "epic-1",
        pinned: true,
        isLocalHome: true,
        hostId: "host-owning",
      })?.getActiveHostId(),
    ).toBe("host-owning");
    expect(
      capturedClientResolver?.(followingVars("epic-1", true))?.getActiveHostId(),
    ).toBe("host-1");
  });

  /**
   * And the consequence the gate and the cache both have to agree with: the
   * optimistic patch is scoped to the host the request is actually going to.
   * Patching the window's scope instead would flip a row in a list the write
   * never touches, and leave the owning host's list showing the old bit.
   */
  it("scopes the optimistic patch to the named host, not the window's", () => {
    const queryClient = new QueryClient();
    const owningKey = cloudEpicTasksQueryKey(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const windowKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(owningKey, pageWith([epicTask("epic-1", false)]));
    queryClient.setQueryData(windowKey, pageWith([epicTask("epic-1", false)]));
    // The session holds a verdict here (`beforeEach`), so admission is not what
    // this case is about - the SCOPE is.
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
      isLocalHome: true,
      hostId: "host-owning",
    });

    expect(context).toEqual({ hostId: "host-owning", userId: "user-1" });
    expect(pinnedById(queryClient.getQueryData(owningKey))).toEqual({
      "epic-1": true,
    });
    expect(pinnedById(queryClient.getQueryData(windowKey))).toEqual({
      "epic-1": false,
    });
  });

  /**
   * The pin READING cache - where a local-homed row's rendered pin state
   * actually comes from - must be reached by the write.
   *
   * It was not. The optimistic patch and the `onSuccess` invalidation both
   * matched only the History key (`cloud.listTasks`, user at index 5), while the
   * reading key is `["host", host, "epic.listTasks", params, user, "pin-reading"]`.
   * So a successful pin reached the owning host and changed the backend, and the
   * glyph kept the pre-click value indefinitely: `staleTime: Infinity` means
   * nothing refetches it on its own, and only a manual invalidation corrected it.
   */
  it("patches the pin-reading cache for the dispatch host, and only that host's", () => {
    const queryClient = new QueryClient();
    const ownerReadingKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherReadingKey = queryKeys.cloudEpicPinReading(
      "host-other",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      ownerReadingKey,
      pageWith([epicTask("epic-1", false)]),
    );
    queryClient.setQueryData(
      otherReadingKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
      isLocalHome: true,
      hostId: "host-owning",
    });

    expect(pinnedById(queryClient.getQueryData(ownerReadingKey))).toEqual({
      "epic-1": true,
    });
    // A different host's reading is a different machine's disk - untouched.
    expect(pinnedById(queryClient.getQueryData(otherReadingKey))).toEqual({
      "epic-1": false,
    });
  });

  it("rolls the pin-reading cache back when the write fails", () => {
    const queryClient = new QueryClient();
    const ownerReadingKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      ownerReadingKey,
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });
    const variables = {
      epicId: "epic-1",
      pinned: true,
      isLocalHome: true,
      hostId: "host-owning",
    };

    const context = capturedOptions.onMutate?.(variables);
    expect(pinnedById(queryClient.getQueryData(ownerReadingKey))).toEqual({
      "epic-1": true,
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      variables,
      context,
    );

    // Back to the host's real state. The rollback needs no enrollment of its
    // own - it inverts the bit through the same patch function - which is why
    // that enrollment lives in `setEpicPinnedInCloudTaskCaches` rather than at
    // the two call sites.
    expect(pinnedById(queryClient.getQueryData(ownerReadingKey))).toEqual({
      "epic-1": false,
    });
  });

  it("patches an UNPIN into the pin-reading cache too", () => {
    // The pin direction is not symmetric by construction - the patch writes
    // `variables.pinned` through - so unpin gets its own case rather than being
    // assumed from the pin one.
    const queryClient = new QueryClient();
    const ownerReadingKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      ownerReadingKey,
      pageWith([epicTask("epic-1", true)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: false,
      isLocalHome: true,
      hostId: "host-owning",
    });

    expect(pinnedById(queryClient.getQueryData(ownerReadingKey))).toEqual({
      "epic-1": false,
    });
  });

  it("leaves another USER's pin reading on the same host alone", () => {
    // The predicate checks `queryKey[4] === scope.userId`, one index earlier than
    // the History key's user. Host isolation is pinned above; this is the other
    // half of the scope, and the index is exactly what would make it silently
    // match every user.
    const queryClient = new QueryClient();
    const mineKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const theirsKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-2",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(mineKey, pageWith([epicTask("epic-1", false)]));
    queryClient.setQueryData(theirsKey, pageWith([epicTask("epic-1", false)]));
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    capturedOptions.onMutate?.({
      epicId: "epic-1",
      pinned: true,
      isLocalHome: true,
      hostId: "host-owning",
    });

    expect(pinnedById(queryClient.getQueryData(mineKey))).toEqual({
      "epic-1": true,
    });
    expect(pinnedById(queryClient.getQueryData(theirsKey))).toEqual({
      "epic-1": false,
    });
  });

  it("invalidates the dispatch host's pin reading on success", async () => {
    const queryClient = new QueryClient();
    const ownerReadingKey = queryKeys.cloudEpicPinReading(
      "host-owning",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const invalidated: Array<readonly unknown[]> = [];
    queryClient.setQueryData(
      ownerReadingKey,
      pageWith([epicTask("epic-1", true)]),
    );
    // Observed through the predicate rather than a refetch: this suite mocks
    // `useHostMutation`, so there is no real query observer to refetch - what is
    // being pinned is that the reading key is MATCHED by the success sweep.
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
    // `filters: X | undefined`, NOT `filters?: X` - the repo's no-optional-
    // parameter rule binds in tests too, and a stub standing in for a real
    // signature is exactly where that slips in unnoticed. The nested `predicate`
    // PROPERTY stays optional, which the rule permits: it is a property of an
    // object type, not a parameter.
    queryClient.invalidateQueries = (
      filters:
        | {
            predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
          }
        | undefined,
    ) => {
      if (filters?.predicate?.({ queryKey: ownerReadingKey }) === true) {
        invalidated.push(ownerReadingKey);
      }
      return Promise.resolve();
    };
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    await capturedOptions.onSuccess?.(
      { pinned: true },
      {
        epicId: "epic-1",
        pinned: true,
        isLocalHome: true,
        hostId: "host-owning",
      },
      { hostId: "host-owning", userId: "user-1" },
    );

    expect(invalidated).toEqual([ownerReadingKey]);
    queryClient.invalidateQueries = originalInvalidate;
  });

  it("resets the scope's pagination and refreshes the first page on success", async () => {
    // The committed reorder crosses server page boundaries, so retained
    // cursors are stale: success must drop the scope's tails (advancing
    // their generations so in-flight ones are rejected), remove the scope's
    // inactive first pages, and refetch the active ones - all without
    // disturbing other scopes or the already-correct optimistic display.
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const scopedQueryKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherQueryKey = cloudEpicTasksQueryKey(
      "host-2",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(
      scopedQueryKey,
      pageWith([epicTask("epic-1", true)]),
    );
    queryClient.setQueryData(
      otherQueryKey,
      pageWith([epicTask("epic-1", false)]),
    );
    const scopedIdentity = "host-1|user-1|recent";
    const otherIdentity = "host-2|user-1|recent";
    const pagesStore = useCloudEpicTasksPagesStore.getState();
    pagesStore.appendPage(
      scopedIdentity,
      cloudEpicTasksPageGeneration(scopedIdentity),
      pageWith([epicTask("epic-1", true)]),
    );
    pagesStore.appendPage(
      otherIdentity,
      cloudEpicTasksPageGeneration(otherIdentity),
      pageWith([epicTask("epic-1", false)]),
    );
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(queryClient),
    });

    await capturedOptions.onSuccess?.(
      { pinned: true },
      followingVars("epic-1", true),
      { hostId: "host-1", userId: "user-1" },
    );

    const state = useCloudEpicTasksPagesStore.getState();
    expect(state.pagesByIdentity[scopedIdentity]).toBeUndefined();
    expect(cloudEpicTasksPageGeneration(scopedIdentity)).toBe(1);
    expect(state.pagesByIdentity[otherIdentity]).toBeDefined();
    expect(cloudEpicTasksPageGeneration(otherIdentity)).toBe(0);
    // These seeded queries have no observers, so they are inactive - the
    // scoped one is removed outright while the other scope is retained.
    expect(queryClient.getQueryData(scopedQueryKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherQueryKey)).toBeDefined();
    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ type: "active" }),
    );
  });

  it("shows the host error fallback", () => {
    renderHook(() => useEpicSetPinned(), {
      wrapper: makeWrapper(new QueryClient()),
    });

    capturedOptions.onError?.(
      { code: "RPC_ERROR", message: "test", fatalDetails: null },
      followingVars("epic-1", true),
      undefined,
    );

    expect(toast.error).toHaveBeenCalledWith("Couldn't update pinned task.");
  });
});

describe("usePendingSetPinnedEpicIds", () => {
  it("tracks two concurrently pending epics independently and drops each as its own mutation settles", async () => {
    // A real `useMutation` sharing `epicMutationKeys.setPinned()` stands in
    // for two rows calling the same shared `useEpicSetPinned()` instance -
    // the mutation cache (not this local observer) is what the hook under
    // test reads from.
    const resolvers = new Map<string, (value: { pinned: boolean }) => void>();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    const { result } = renderHook(
      () => {
        const mutation = useMutation({
          mutationKey: epicMutationKeys.setPinned(),
          mutationFn: (variables: SetPinnedVariables) =>
            new Promise<{ pinned: boolean }>((resolve) => {
              resolvers.set(variables.epicId, resolve);
            }),
        });
        return {
          mutate: mutation.mutate,
          pending: usePendingSetPinnedEpicIds(),
        };
      },
      { wrapper: makeWrapper(queryClient) },
    );

    act(() => {
      result.current.mutate({ epicId: "epic-a", pinned: true });
      result.current.mutate({ epicId: "epic-b", pinned: false });
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual(new Set(["epic-a", "epic-b"]));
    });

    await act(async () => {
      resolvers.get("epic-a")?.({ pinned: true });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual(new Set(["epic-b"]));
    });

    await act(async () => {
      resolvers.get("epic-b")?.({ pinned: false });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.pending.size).toBe(0);
    });
  });
});
