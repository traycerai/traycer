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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { findOpenTileInTab } from "@/stores/epics/canvas/canvas-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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

const TERMINAL_AGENT_ID = "terminal-agent-1";

/** The seed plus one terminal agent whose record holds no title. */
function seedDocWithTitlelessTerminalAgent(): Uint8Array {
  const donor = new Y.Doc();
  Y.applyUpdate(donor, seedDoc());
  const agents = donor.getMap<unknown>("epic").get("tuiAgents");
  if (!(agents instanceof Y.Map)) throw new Error("expected tuiAgents map");
  const agent = new Y.Map<unknown>();
  agent.set("id", TERMINAL_AGENT_ID);
  agent.set("harnessId", "codex");
  agent.set("title", "");
  agent.set("parentId", null);
  agent.set("createdAt", 0);
  agent.set("updatedAt", 0);
  agent.set("userId", USER_ID);
  agent.set("hostId", SANDBOX_HOST_ID);
  agent.set("workspaceFolders", ["/repo"]);
  agent.set("model", null);
  agent.set("reasoningEffort", null);
  agent.set("agentMode", "regular");
  agent.set("harnessSessionId", null);
  agent.set("terminalShellCommand", null);
  agent.set("terminalShellArgs", null);
  agents.set(TERMINAL_AGENT_ID, agent);
  return Y.encodeStateAsUpdate(donor);
}

function createSession(): OpenedStoreForTest {
  return createSessionFrom(seedDoc());
}

function createSessionFrom(doc: Uint8Array): OpenedStoreForTest {
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
  captured.value.onSnapshot(makeMeta(), doc);
  return handle;
}

/** A real `HostClient` whose viewer cloud list answers with `listCloudChats`. */
function createHostClient(
  queryClient: QueryClient,
  listCloudChats: () => Promise<{ chats: CloudChatSummary[] }>,
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
        "epic.listCloudChats": listCloudChats,
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
    useEpicCanvasStore.getState().clearAllTitleGenerationPending();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("lists it once, under the arm row's title, before its first publication", async () => {
    const queryClient = createAppQueryClient();
    const client = createHostClient(queryClient, () =>
      Promise.resolve({ chats: [] }),
    );
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
  it("keeps the stand-in while the list that would draw the arm row has not answered", async () => {
    const queryClient = createAppQueryClient();
    // The viewer's first list request is still in flight, so the rendered
    // list has no rows yet, the arm's included.
    const client = createHostClient(
      queryClient,
      () => new Promise<{ chats: CloudChatSummary[] }>(() => undefined),
    );
    const session = createSession();
    opened.push(session);
    armRows.value = [armRow()];
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
    render(
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
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId(`epic-sidebar-item-${CHAT_ID}`)).toBeTruthy();
    });
    expect(
      screen.queryByTestId(`epic-sidebar-cloud-item-${CHAT_ID}`),
    ).toBeNull();
  });

  describe("while the chat's first title is awaited", () => {
    function renderTree(
      session: OpenedStoreForTest,
      queryClient: QueryClient,
    ): void {
      const client = createHostClient(queryClient, () =>
        Promise.resolve({ chats: [] }),
      );
      render(
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
        </QueryClientProvider>,
      );
    }

    async function holdSentChat(session: OpenedStoreForTest): Promise<void> {
      session.store.getState().beginPendingChatCreation({
        chatId: CHAT_ID,
        hostId: SANDBOX_HOST_ID,
        parentChatId: null,
        title: "",
        ownerUserId: USER_ID,
      });
      await vi.waitFor(() => {
        expect(
          Object.hasOwn(session.store.getState().chats.byId, CHAT_ID),
        ).toBe(true);
      });
    }

    it("names the row New agent, then the title in the same single row", async () => {
      const queryClient = createAppQueryClient();
      const session = createSession();
      opened.push(session);
      await holdSentChat(session);
      renderTree(session, queryClient);
      await vi.waitFor(() => {
        expect(screen.getByTestId(`epic-sidebar-item-${CHAT_ID}`)).toBeTruthy();
      });
      act(() => {
        useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "");
      });

      await vi.waitFor(() => {
        expect(
          screen
            .getByTestId(`epic-sidebar-item-${CHAT_ID}`)
            .getAttribute("aria-label"),
        ).toContain("New agent");
      });
      expect(screen.getAllByText("New agent")).toHaveLength(1);
      expect(screen.queryByText("Untitled agent")).toBeNull();

      // The tree reads its node's title from the tree slice, which the
      // projection rebuilds alongside the chat record: land both.
      act(() => {
        const state = session.store.getState();
        const held = state.chats.byId[CHAT_ID];
        const node = state.tree.nodeById[CHAT_ID];
        session.store.setState({
          chats: {
            allIds: [CHAT_ID],
            byId: {
              [CHAT_ID]: {
                ...held,
                title: "Generated title",
                updatedAt: Date.now() + 1_000,
              },
            },
          },
          tree: {
            ...state.tree,
            nodeById: {
              ...state.tree.nodeById,
              [CHAT_ID]: { ...node, title: "Generated title" },
            },
          },
        });
      });

      await vi.waitFor(() => {
        expect(screen.getAllByText("Generated title")).toHaveLength(1);
      });
      expect(screen.queryByText("New agent")).toBeNull();
      expect(
        screen
          .getByTestId(`epic-sidebar-item-${CHAT_ID}`)
          .getAttribute("aria-label"),
      ).toContain("Generated title");
      expect(
        screen.getAllByTestId(`epic-sidebar-item-${CHAT_ID}`),
      ).toHaveLength(1);
    });

    it("opens the row's tile and seeds its rename with the raw name, never New agent", async () => {
      const queryClient = createAppQueryClient();
      const session = createSession();
      opened.push(session);
      await holdSentChat(session);
      useEpicCanvasStore.getState().openEpicTabWithId(TAB_ID, EPIC_ID, "Epic");
      renderTree(session, queryClient);
      await vi.waitFor(() => {
        expect(screen.getByTestId(`epic-sidebar-item-${CHAT_ID}`)).toBeTruthy();
      });
      act(() => {
        useEpicCanvasStore.getState().markChatTitlePending(CHAT_ID, "");
      });
      const row = await screen.findByLabelText(/^New agent/);

      fireEvent.click(row);

      await vi.waitFor(() => {
        expect(
          findOpenTileInTab(TAB_ID, { id: CHAT_ID, hostId: SANDBOX_HOST_ID }),
        ).not.toBeNull();
      });
      const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
      const names = Object.values(canvas?.tilesByInstanceId ?? {}).map(
        (tile) => tile?.name,
      );
      expect(names).toEqual(["Untitled agent"]);

      fireEvent.contextMenu(row);
      fireEvent.click(
        await screen.findByTestId(`epic-sidebar-context-rename-${CHAT_ID}`),
      );
      const input = await screen.findByTestId(
        `epic-sidebar-rename-input-${CHAT_ID}`,
      );
      if (!(input instanceof HTMLInputElement))
        throw new Error("expected input");
      expect(input.value).toBe("Untitled agent");
    });

    it("never labels a terminal agent whose record holds no title", async () => {
      const queryClient = createAppQueryClient();
      const session = createSessionFrom(seedDocWithTitlelessTerminalAgent());
      opened.push(session);
      act(() => {
        useEpicCanvasStore
          .getState()
          .markChatTitlePending(TERMINAL_AGENT_ID, "");
      });
      renderTree(session, queryClient);

      await vi.waitFor(() => {
        expect(
          screen.getByTestId(`epic-sidebar-item-${TERMINAL_AGENT_ID}`),
        ).toBeTruthy();
      });
      expect(screen.queryByText("New agent")).toBeNull();
      expect(
        screen
          .getByTestId(`epic-sidebar-item-${TERMINAL_AGENT_ID}`)
          .getAttribute("aria-label"),
      ).not.toContain("New agent");
    });
  });
});
