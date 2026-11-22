import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CollaboratorEntry,
  ListEpicCollaboratorsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

export const EPIC_ID = "epic-1";
export const VIEWER_USER_ID = "user-1";

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

export { collaboratorEntry } from "@/lib/identity/__tests__/collaborator-fixture";

export function collaboratorsResponse(
  collaborators: ReadonlyArray<CollaboratorEntry>,
): ListEpicCollaboratorsResponse {
  return { collaborators: [...collaborators], collaboratorsAvailable: true };
}

export interface PersonAvatarHarness {
  readonly queryClient: QueryClient;
  /** How many times the mock host was asked for the collaborators list. */
  readonly collaboratorRequests: () => number;
  /** The session's `epic.listCollaborators` entry, as another reader leaves it. */
  readonly publishCollaborators: (
    response: ListEpicCollaboratorsResponse,
  ) => void;
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly wrap: (children: ReactNode) => ReactNode;
  readonly dispose: () => void;
}

/**
 * The providers a comment surface reads a person through: a real query client,
 * a real host client over a mock messenger that records what it is asked, and
 * an open epic session whose host client is that same client. The viewer is
 * signed in as `user-1`.
 */
export function createPersonAvatarHarness(): PersonAvatarHarness {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: VIEWER_USER_ID, userName: "Viewer", email: "v@example.com" },
      { userId: VIEWER_USER_ID, username: "Viewer" },
      [],
    );
  const queryClient = createAppQueryClient();
  let collaboratorRequests = 0;
  // What the mock host answers a list request with, so a surface that does
  // ask (the reply composer's mention picker) cannot overwrite what a test
  // published with an empty list.
  let served = collaboratorsResponse([]);
  let requestCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${String((requestCount += 1))}`,
      handlers: {
        "epic.listCollaborators": () => {
          collaboratorRequests += 1;
          return served;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const hostClient = spine.createRequester(mockLocalHostEntry);
  const epicHandle: OpenEpicStoreHandle = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_USER_ID,
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  epicHandle.store.setState({ durabilityStatus: null });
  return {
    queryClient,
    hostClient,
    collaboratorRequests: () => collaboratorRequests,
    publishCollaborators: (response) => {
      served = response;
      queryClient.setQueryData(
        queryKeys.hostMethod<HostRpcRegistry, "epic.listCollaborators">(
          mockLocalHostEntry.hostId,
          "epic.listCollaborators",
          { epicId: EPIC_ID },
        ),
        response,
      );
    },
    wrap: (children) => (
      <QueryClientProvider client={queryClient}>
        <EpicSessionContext.Provider value={epicHandle}>
          <EpicSessionHostClientContext.Provider value={hostClient}>
            {children}
          </EpicSessionHostClientContext.Provider>
        </EpicSessionContext.Provider>
      </QueryClientProvider>
    ),
    dispose: () => {
      epicHandle.dispose();
      queryClient.clear();
      useAuthStore.getState().setSignedOut();
    },
  };
}
