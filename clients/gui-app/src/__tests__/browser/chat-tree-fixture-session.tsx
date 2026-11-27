import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * What the chat tree's browser fixture pages (`chat-tree-motion.tsx`,
 * `chat-tree-drag.tsx`) build the same way: an epic session over a seeded
 * store, the host runtime and session host client that answer a mounted row's
 * queries, the error capture and the page mount. The providers around the tree
 * are in `chat-tree-fixture-providers.tsx`. Each page keeps its own seed,
 * probe, handlers for what it drives, and the tree it renders.
 */

/** Opens the epic's session over the given snapshot and registers it. */
export function openFixtureSession(input: {
  readonly epicId: string;
  readonly userId: string | null;
  readonly meta: SnapshotMetaEpic;
  readonly seedDoc: Uint8Array;
}): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: input.epicId,
    userId: input.userId,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(input.meta, input.seedDoc);
  getOpenEpicRegistry().acquire(input.epicId, () => handle);
  return handle;
}

/**
 * Answered as a host would. The tree's panel observes these two reads and its
 * rows read the panel's result (`task-shared-reads-context.ts`); left
 * unanswered, the panel would hold a refusal for every row.
 */
export const ROW_QUERY_HANDLERS: MockHandlerMap<HostRpcRegistry> = {
  "epic.listTaskHosts": () => ({ hosts: [] }),
  "epic.listCollaborators": () => ({
    collaborators: [],
    collaboratorsAvailable: true,
  }),
};

export function createFixtureRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "http://127.0.0.1:9/sign-in",
    authnBaseUrl: "http://127.0.0.1:9",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/** The host runtime's messenger: the answers every tree page needs, plus `extra`. */
export function createFixtureMessengerFactory(input: {
  readonly requestIdPrefix: string;
  readonly extra: MockHandlerMap<HostRpcRegistry>;
}): MessengerFactory<HostRpcRegistry> {
  let requestCounter = 0;
  return ({ registry }) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry,
      requestId: () => `${input.requestIdPrefix}-${String(++requestCounter)}`,
      handlers: {
        "host.notifications.indicatorState": () => ({
          epics: {},
          chats: {},
          complete: true,
        }),
        "epic.getTaskContexts": () => ({ tasks: {} }),
        ...ROW_QUERY_HANDLERS,
        ...input.extra,
      },
    });
}

/** The session's own host client, the one the epic's commits send through. */
export function createFixtureSessionHostClient(input: {
  readonly queryClient: QueryClient;
  readonly requestId: () => string;
  readonly bearerToken: string;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
}): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(input.queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: input.requestId,
      handlers: input.handlers,
    }),
  });
  spine.setRequestContext(
    createRendererContextFixture({ bearerToken: input.bearerToken }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

/** Every uncaught error and unhandled rejection the page sees, as text. */
export function captureFixtureErrors(): string[] {
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    errors.push(
      event.error instanceof Error
        ? (event.error.stack ?? event.message)
        : event.message,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    errors.push(
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason),
    );
  });
  return errors;
}

/** Renders `page` at `/` under a memory router into the page's `#root`. */
export function mountFixturePage(page: () => ReactNode): void {
  const rootRoute = createRootRoute({ component: page });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.getElementById("root");
  if (container === null) throw new Error("no #root");
  createRoot(container).render(<RouterProvider router={router} />);
}
