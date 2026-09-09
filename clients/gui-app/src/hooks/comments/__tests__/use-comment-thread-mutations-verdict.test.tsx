import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
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

beforeEach(() => {
  reached.count = 0;
  reads.count = 0;
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
          return { threads: [] };
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
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
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
