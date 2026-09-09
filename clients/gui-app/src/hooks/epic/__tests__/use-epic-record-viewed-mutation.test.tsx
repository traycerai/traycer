import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import {
  cloudEpicTasksPageGeneration,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

interface TestState {
  activeHostId: string | null;
  userId: string | null;
}

const testState = vi.hoisted<TestState>(() => ({
  activeHostId: "host-1",
  userId: "user-1",
}));

const mockClient = {
  getActiveHostId: () => testState.activeHostId,
  getRequestContextUserId: () => testState.userId,
};

// `useHostBinding` is mocked alongside `useHostClient` because the hook now
// resolves its client through `useHostClientForHostId(hostId)`, which reads the
// BINDING to build a requester for a named host. `createRequesterForHostId`
// answers the same mock client: this suite's subject is the dispatch gate and
// the cache invalidation, not which machine a requester addresses - the host
// routing itself is pinned in `epic-recency-session-host.test.tsx`.
vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => mockClient,
  useHostBinding: () => ({
    hostId: testState.activeHostId,
    hostClient: {
      ...mockClient,
      createRequesterForHostId: () => mockClient,
    },
  }),
}));

interface MutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

let capturedOptions: {
  onMutate?: (variables: { epicId: string }) => MutationContext;
  onSuccess?: (
    response: { viewedAt: number },
    variables: { epicId: string },
    context: MutationContext,
  ) => Promise<void>;
} = {};

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: { options: typeof capturedOptions }) => {
    capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

import {
  EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE,
  useEpicRecordViewed,
} from "@/hooks/epic/use-epic-record-viewed-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

// The host the write is dispatched on. This suite mocks `useHostMutation`, so
// the id only has to be a stable non-null value - what it pins is that the hook
// now REQUIRES one rather than reaching for the window's effective host.
const RECORD_VIEWED_HOST_ID = "host-record-viewed";

const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useEpicRecordViewed", () => {
  beforeEach(() => {
    capturedOptions = {};
    testState.activeHostId = "host-1";
    testState.userId = "user-1";
    useCloudEpicTasksPagesStore.setState({
      pagesByIdentity: {},
      generationByIdentity: {},
    });
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });

  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("refuses a dispatch once the verdict is withdrawn, and admits it again when the verdict returns", () => {
    // The route's effect captured `cloudAuthorized === true` at render; the
    // demotion landed before the effect flushed. The verdict is re-read here.
    renderHook(() => useEpicRecordViewed(RECORD_VIEWED_HOST_ID), {
      wrapper: makeWrapper(new QueryClient()),
    });
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);

    expect(() => capturedOptions.onMutate?.({ epicId: "epic-1" })).toThrow(
      EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE,
    );

    // Non-vacuity: the verdict returning is what admits the same dispatch.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    expect(capturedOptions.onMutate?.({ epicId: "epic-1" })).toEqual({
      hostId: "host-1",
      userId: "user-1",
    });
  });

  it("refreshes only central last-viewed lists in the captured host/user scope", async () => {
    const queryClient = new QueryClient();
    const lastViewedRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    const lastViewedKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      lastViewedRequest,
    );
    const recentKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherHostKey = cloudEpicTasksQueryKey(
      "host-2",
      "user-1",
      lastViewedRequest,
    );
    [lastViewedKey, recentKey, otherHostKey].forEach((queryKey) => {
      queryClient.setQueryData(queryKey, { tasks: [], hasMore: false });
    });
    const lastViewedIdentity = `host-1|user-1|${JSON.stringify(lastViewedRequest)}`;
    const recentIdentity = `host-1|user-1|${JSON.stringify(LIST_CLOUD_TASKS_REQUEST)}`;
    const state = useCloudEpicTasksPagesStore.getState();
    state.appendPage(lastViewedIdentity, 0, { tasks: [], hasMore: false });
    state.appendPage(recentIdentity, 0, { tasks: [], hasMore: false });
    renderHook(() => useEpicRecordViewed(RECORD_VIEWED_HOST_ID), {
      wrapper: makeWrapper(queryClient),
    });

    const context = capturedOptions.onMutate?.({ epicId: "epic-1" });
    expect(context).toEqual({ hostId: "host-1", userId: "user-1" });
    await capturedOptions.onSuccess?.(
      { viewedAt: 1234 },
      { epicId: "epic-1" },
      context ?? { hostId: null, userId: null },
    );

    expect(queryClient.getQueryData(lastViewedKey)).toBeUndefined();
    expect(queryClient.getQueryData(recentKey)).toBeDefined();
    expect(queryClient.getQueryData(otherHostKey)).toBeDefined();
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[
        lastViewedIdentity
      ],
    ).toBeUndefined();
    expect(cloudEpicTasksPageGeneration(lastViewedIdentity)).toBe(1);
    expect(
      useCloudEpicTasksPagesStore.getState().pagesByIdentity[recentIdentity],
    ).toBeDefined();
  });
});
