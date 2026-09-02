import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
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

beforeEach(() => {
  reached.count = 0;
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
