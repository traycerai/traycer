/**
 * A team host's chat, sent and not yet published, in the Agents tree.
 *
 * THE PROOF: the creator holds the chat as an untitled stand-in until its
 * first publication, while the environment arm already serves it, titled, as
 * a cloud row. The tree lists it once, under the arm row's title - not as an
 * "Untitled agent" beside it.
 *
 * The real `ChatTreePanelBody` over a real epic store and a real `HostClient`
 * (the `chat-tree-task-hosts-refusal.test.tsx` harness). The arm, a team
 * environment's own stream, is the one source replaced.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
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

const armRows = vi.hoisted((): { value: readonly CloudChatSummary[] } => ({
  value: [],
}));
vi.mock("@/hooks/environment/use-environment-arms", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/environment/use-environment-arms")
    >();
  return {
    ...actual,
    useEnvironmentArmChats: (taskId: string) =>
      taskId.length === 0 ? [] : armRows.value,
  };
});

const EPIC_ID = "epic-arm-stand-in";
const TAB_ID = "tab-arm-stand-in";
const USER_ID = "viewer-1";
const CHAT_ID = "chat-sent";
const SANDBOX_HOST_ID = "sbx-host";
const ARM_TITLE = "E2E Sandbox Test";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Arm stand-in",
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
  epic.set("title", "Arm stand-in");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", new Y.Map<unknown>());
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

/** A real `HostClient` whose viewer cloud list holds nothing of the task. */
function createHostClient(
  queryClient: QueryClient,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "arm-stand-in",
      handlers: {
        "epic.listCloudChats": () => Promise.resolve({ chats: [] }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

// The team environment's row for the sent chat: filed under the environment,
// on the sandbox the create went to, before its first publication.
function armRow(): CloudChatSummary {
  return {
    identity: { taskId: EPIC_ID, chatId: CHAT_ID, ownerUserId: "env-pool" },
    ownerHostId: SANDBOX_HOST_ID,
    createdAt: 1,
    visibility: "task",
    title: ARM_TITLE,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 2,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: false,
  };
}

const opened: OpenedStoreForTest[] = [];

describe("the Agents tree over a sent team-host chat", () => {
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
    armRows.value = [];
  });

  it("lists it once, under the arm row's title, before its first publication", async () => {
    const queryClient = createAppQueryClient();
    const client = createHostClient(queryClient);
    const session = createSession();
    opened.push(session);
    armRows.value = [armRow()];
    // What the create leaves behind: the creator's stand-in, untitled, on the
    // sandbox the chat was sent to.
    session.store.getState().beginPendingChatCreation({
      chatId: CHAT_ID,
      hostId: SANDBOX_HOST_ID,
      parentChatId: null,
      title: "",
      ownerUserId: USER_ID,
    });
    await vi.waitFor(() => {
      expect(Object.hasOwn(session.store.getState().chats.byId, CHAT_ID)).toBe(
        true,
      );
    });
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
      expect(
        screen.getByTestId(`epic-sidebar-cloud-item-${CHAT_ID}`),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId(`epic-sidebar-item-${CHAT_ID}`)).toBeNull();
    expect(screen.getAllByText(ARM_TITLE)).toHaveLength(1);
    expect(screen.queryByText("Untitled agent")).toBeNull();
  });
});
