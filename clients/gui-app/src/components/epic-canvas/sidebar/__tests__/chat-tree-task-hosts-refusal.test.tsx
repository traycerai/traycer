/**
 * A refused task-hosts read, under the Agents tree that observes it.
 *
 * THE PROOF: the tree keeps its `useTaskHostsView` observer mounted whatever
 * the view reads, so a terminal refusal lands in place and the host is asked
 * once. A consumer that mounted only while the view was not "none" would
 * unmount on the query's own error and mount again, asking the host on each
 * mount.
 *
 * The real `ChatTreePanelBody` over a real epic store (the harness
 * `agent-row-reach-mark.test.tsx` uses), a real `HostClient` and the real
 * `useTaskHostsView`; the seams replaced are the ones that throw outside a
 * `<HostRuntimeProvider>`, which this suite does not stand up.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

// The three seams `agent-row-reach-mark` stubs: host reachability, the per-host
// client beneath a row (a null client disables the queries under it), a row's
// owner PR references, and the notification indicator query.
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (hostId: string): HostReachability => ({
      status: "reachable",
      hostLabel: hostId,
      unavailability: null,
      basis: "directory",
      hostKind: "unknown",
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
}));

vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    const { EMPTY_INDICATOR_STATE_RESPONSE } =
      await import("@/stores/notifications/notification-indicator-state");
    const frozen = {
      data: EMPTY_INDICATOR_STATE_RESPONSE,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    } as const;
    return { ...actual, useHostNotificationIndicators: () => frozen };
  },
);

const EPIC_ID = "epic-task-hosts-refusal";
const TAB_ID = "tab-task-hosts-refusal";
const USER_ID = "viewer-1";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Task hosts refusal",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chat = new Y.Map<unknown>();
  chat.set("id", "chat-1");
  chat.set("title", "Chat chat-1");
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("userId", USER_ID);
  chat.set("hostId", "host-1");
  chat.set("archivedAt", null);
  chat.set("messages", new Y.Array<unknown>());
  const chats = new Y.Map<unknown>();
  chats.set("chat-1", chat);
  epic.set("title", "Task hosts refusal");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function createSession(): OpenedStoreForTest {
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
    epicId: EPIC_ID,
    userId: USER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc());
  return handle;
}

/** A real `HostClient` whose `epic.listTaskHosts` is the given handler. */
function createHostClient(
  queryClient: QueryClient,
  listTaskHosts: () => Promise<never>,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "task-hosts",
      handlers: { "epic.listTaskHosts": listTaskHosts },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

const opened: OpenedStoreForTest[] = [];

describe("the Agents tree over a refused task-hosts read", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: USER_ID, username: USER_ID },
    });
  });

  afterEach(() => {
    cleanup();
    for (const handle of opened.splice(0)) handle.dispose();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("a terminal refusal renders in place and asks the host once", async () => {
    const requests = { value: 0 };
    const queryClient = createAppQueryClient();
    const client = createHostClient(queryClient, () => {
      requests.value += 1;
      return Promise.reject(
        new HostRpcError({
          code: "FORBIDDEN",
          message: "refused",
          requestId: `task-hosts-${String(requests.value)}`,
          method: "epic.listTaskHosts",
          fatalDetails: null,
        }),
      );
    });
    const session = createSession();
    opened.push(session);
    const tree: ReactNode = (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <EpicSessionContext.Provider value={session}>
            <EpicSessionHostClientContext.Provider value={client}>
              <ChatTreePanelBody
                epicId={EPIC_ID}
                tabId={TAB_ID}
                messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
              />
            </EpicSessionHostClientContext.Provider>
          </EpicSessionContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    );
    render(tree);

    await vi.waitFor(() => {
      const refused = queryClient.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey.includes("epic.listTaskHosts") &&
          query.state.status === "error",
      });
      expect(refused).toHaveLength(1);
    });
    // Let a consumer that remounts on the error reach the host again.
    for (let flush = 0; flush < 5; flush += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    expect(requests.value).toBe(1);
    expect(screen.getByTestId("epic-sidebar-item-chat-1")).toBeTruthy();
  });
});
