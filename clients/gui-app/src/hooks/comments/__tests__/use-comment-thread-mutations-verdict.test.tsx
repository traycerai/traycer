import type { ReactNode } from "react";
import {
  QueryClientProvider,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CommentThreadWire,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  COMMENT_WRITE_UNAUTHORIZED_MESSAGE,
  useDeleteCommentThreadForClient,
} from "@/hooks/comments/use-comment-thread-mutations";
import { useEpicCommentThreadsForClient } from "@/hooks/comments/use-epic-comment-threads";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * The comment writes re-read the cloud verdict at DISPATCH. The sidebar's
 * gate hides the controls once a session is demoted, but a control already
 * rendered - or a write already queued - still reaches `onMutate`, and the
 * Epic session's local-host context carries no renderer verdict. So a write
 * without a verdict must be refused before it reaches the wire, unless the
 * room is local-homed.
 */
const EPIC_ID = "epic-comment-verdict";

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let queryClient: QueryClient;
let epicHandle: OpenEpicStoreHandle;
let client: HostClient<HostRpcRegistry>;
/** How many `epic.deleteCommentThread` requests reached the mock host. */
const reached = { count: 0 };
/** How many `epic.listCommentThreads` requests reached the mock host. */
const reads = { count: 0 };
let listThreadsAnswer:
  | ListCommentThreadsResponse
  | Promise<ListCommentThreadsResponse> = { threads: [] };

beforeEach(() => {
  reached.count = 0;
  reads.count = 0;
  listThreadsAnswer = { threads: [] };
  queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "epic.deleteCommentThread": () => {
          reached.count += 1;
          return { ok: true as const };
        },
        "epic.listCommentThreads": () => {
          reads.count += 1;
          return listThreadsAnswer;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client = spine.createRequester(mockLocalHostEntry);
  epicHandle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-1",
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
});

afterEach(() => {
  cleanup();
  epicHandle.dispose();
  queryClient.clear();
  useAuthStore.getState().setSignedOut();
});

function signIn(): void {
  signInAs("user-1");
}

function signInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.test` },
      { userId, username: userId },
      [],
    );
}

function demoteToUnverified(): void {
  useAuthStore
    .getState()
    .setUnverifiedSession(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
    );
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        {props.children}
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

const REQUEST = {
  epicId: EPIC_ID,
  artifactType: "spec" as const,
  artifactId: "artifact-1",
  threadId: "thread-1",
};

function threadFixtureFor(userId: string, threadId: string): CommentThreadWire {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: `comment-${threadId}`,
        content: { type: "doc", content: [] },
        createdAt: 1,
        updatedAt: null,
        author: { userId, fallbackHandle: userId },
      },
    ],
    data: { createdByUserId: userId, quotedText: `synthetic-${userId}` },
  };
}

function isListCommentThreadsResponse(
  value: unknown,
): value is ListCommentThreadsResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "threads" in value &&
    Array.isArray(value.threads)
  );
}

function queryWithThread(
  currentQueryClient: QueryClient,
  threadId: string,
): Query {
  const query = currentQueryClient
    .getQueryCache()
    .getAll()
    .find((entry) => {
      const data: unknown = entry.state.data;
      return (
        isListCommentThreadsResponse(data) &&
        data.threads.some((thread) => thread.threadId === threadId)
      );
    });
  if (query === undefined) {
    throw new Error(`No comment query contains ${threadId}`);
  }
  return query;
}

describe("comment writes re-read the cloud verdict at dispatch", () => {
  it("refuses a cloud-backed room's write after a demotion, before the wire", async () => {
    signIn();
    epicHandle.store.setState({ durabilityStatus: "cloud" });
    const { result } = renderHook(
      () => useDeleteCommentThreadForClient(client),
      { wrapper },
    );
    // Rendered under a verdict; demoted before the click reaches `onMutate`.
    demoteToUnverified();

    await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow(
      COMMENT_WRITE_UNAUTHORIZED_MESSAGE,
    );
    expect(reached.count).toBe(0);
  });

  it("lets a local-homed room's write through without a verdict", async () => {
    demoteToUnverified();
    epicHandle.store.setState({ durabilityStatus: "local" });
    const { result } = renderHook(
      () => useDeleteCommentThreadForClient(client),
      { wrapper },
    );

    await expect(result.current.mutateAsync(REQUEST)).resolves.toEqual({
      ok: true,
    });
    expect(reached.count).toBe(1);
  });

  it("keeps the local-home exemption through a reconnect beat, from the RETAINED statement", async () => {
    // `startedSubscriptionCycle` clears the cycle's durability status and
    // deliberately keeps the retained pair; the comment-room gate renders
    // from current-then-retained, so the control stays offered. The dispatch
    // gate must read the same selection, or the write it offers is refused.
    demoteToUnverified();
    epicHandle.store.setState({
      durabilityStatus: null,
      retainedDurabilityStatus: "local",
    });
    const { result } = renderHook(
      () => useDeleteCommentThreadForClient(client),
      { wrapper },
    );

    await expect(result.current.mutateAsync(REQUEST)).resolves.toEqual({
      ok: true,
    });
    expect(reached.count).toBe(1);
  });

  it("lets the cycle's own statement outrank a retained local one", async () => {
    // Non-vacuity for the order: a promoted epic reports `cloud` this cycle,
    // and the stale retained `local` must not re-admit the write.
    demoteToUnverified();
    epicHandle.store.setState({
      durabilityStatus: "cloud",
      retainedDurabilityStatus: "local",
    });
    const { result } = renderHook(
      () => useDeleteCommentThreadForClient(client),
      { wrapper },
    );

    await expect(result.current.mutateAsync(REQUEST)).rejects.toThrow(
      COMMENT_WRITE_UNAUTHORIZED_MESSAGE,
    );
    expect(reached.count).toBe(0);
  });

  it("lets a cloud-backed room's write through under a verdict (non-vacuity)", async () => {
    signIn();
    epicHandle.store.setState({ durabilityStatus: "cloud" });
    const { result } = renderHook(
      () => useDeleteCommentThreadForClient(client),
      { wrapper },
    );

    await expect(result.current.mutateAsync(REQUEST)).resolves.toEqual({
      ok: true,
    });
    expect(reached.count).toBe(1);
  });
});

/**
 * The READ half of the same gate, and the reason it is not covered by the
 * sidebar's `enabled` flag.
 *
 * `enabled: !commentsUnavailable` stops the NEXT fetch. It does not stop a
 * `refetch()` override, and it does not stop the transient-retry episode
 * already in flight when the session was demoted - and a same-user demotion
 * retains the host credential those retries ride. So the verdict is re-read
 * inside the queryFn, exactly as the writes re-read it inside `onMutate`, and
 * it is on the HOOK rather than at the sidebar call site because the collab
 * tile and its hover popover dispatch the same cloud-backed read with no
 * availability gate at all.
 */
describe("the comment-thread read re-reads the cloud verdict at dispatch", () => {
  function renderThreadsQuery() {
    return renderHook(
      () =>
        useEpicCommentThreadsForClient({
          client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: "artifact-1",
          options: { enabled: true, laneDroppedAt: null },
        }),
      { wrapper },
    );
  }

  it("refuses a cloud-backed room's read after a demotion, before the wire", async () => {
    signIn();
    epicHandle.store.setState({ durabilityStatus: "cloud" });
    demoteToUnverified();
    const { result } = renderThreadsQuery();

    // Longer than the default 1s wait ON PURPOSE. The refusal is an ordinary
    // `HostRpcError`, so the app query client's `failureCount < 1` predicate
    // grants it one retry with backoff - and that retry re-enters the queryFn
    // and is refused again. Waiting for the terminal `isError` is therefore
    // waiting for the WHOLE episode, which is the thing being pinned: the
    // count below stays zero across both attempts, not just the first.
    await waitFor(
      () => {
        expect(result.current.isError).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(reads.count).toBe(0);
  });

  it("lets a local-homed room's read through without a verdict", async () => {
    demoteToUnverified();
    epicHandle.store.setState({ durabilityStatus: "local" });
    const { result } = renderThreadsQuery();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(reads.count).toBe(1);
  });

  it("keeps the local-home exemption through a reconnect beat, from the RETAINED statement", async () => {
    // Same current-then-retained selection the write gate takes: a reconnect
    // clears the cycle's own status while the retained pair still stands, and
    // the surface keeps offering the panel through that beat.
    demoteToUnverified();
    epicHandle.store.setState({
      durabilityStatus: null,
      retainedDurabilityStatus: "local",
    });
    const { result } = renderThreadsQuery();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(reads.count).toBe(1);
  });

  it("lets a cloud-backed room's read through under a verdict (non-vacuity)", async () => {
    signIn();
    epicHandle.store.setState({ durabilityStatus: "cloud" });
    const { result } = renderThreadsQuery();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(reads.count).toBe(1);
  });
});

describe("comment-thread query and writer cache identity", () => {
  it("keeps another account's thread rows out and invalidates the writing account's list", async () => {
    signInAs("synthetic-account-a");
    epicHandle.store.setState({ durabilityStatus: "cloud" });
    listThreadsAnswer = {
      threads: [threadFixtureFor("synthetic-account-a", "synthetic-thread-a")],
    };
    let resolveAccountB: (value: ListCommentThreadsResponse) => void = () => {
      throw new Error("account B comment response was not requested");
    };
    const pendingAccountBAnswer = new Promise<ListCommentThreadsResponse>(
      (resolve) => {
        resolveAccountB = resolve;
      },
    );
    const rendered = renderHook(
      (props: { readonly enabled: boolean }) =>
        useEpicCommentThreadsForClient({
          client,
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: "artifact-1",
          options: { enabled: props.enabled, laneDroppedAt: null },
        }),
      { wrapper, initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(rendered.result.current.data?.threads[0]?.threadId).toBe(
        "synthetic-thread-a",
      );
    });
    expect(reads.count).toBe(1);

    listThreadsAnswer = pendingAccountBAnswer;
    act(() => {
      signInAs("synthetic-account-b");
    });
    rendered.rerender({ enabled: true });

    expect(rendered.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(reads.count).toBe(2);
    });
    expect(rendered.result.current.data).toBeUndefined();
    await act(async () => {
      resolveAccountB({
        threads: [
          threadFixtureFor("synthetic-account-b", "synthetic-thread-b"),
        ],
      });
      await pendingAccountBAnswer;
    });
    await waitFor(() => {
      expect(rendered.result.current.data?.threads[0]?.threadId).toBe(
        "synthetic-thread-b",
      );
    });

    const accountAQuery = queryWithThread(queryClient, "synthetic-thread-a");
    const accountBQuery = queryWithThread(queryClient, "synthetic-thread-b");
    rendered.rerender({ enabled: false });
    const mutation = renderHook(() => useDeleteCommentThreadForClient(client), {
      wrapper,
    });
    await mutation.result.current.mutateAsync({
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: "artifact-1",
      threadId: "synthetic-thread-b",
    });

    expect(reached.count).toBe(1);
    await waitFor(() => {
      expect(accountBQuery.state.isInvalidated).toBe(true);
    });
    expect(accountAQuery.state.isInvalidated).toBe(false);
  });
});
