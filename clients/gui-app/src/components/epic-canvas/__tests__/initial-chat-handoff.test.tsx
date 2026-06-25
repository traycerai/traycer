import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
} from "@/lib/registries/epic-session-registry";
import { useInitialChatHandoff } from "@/components/epic-canvas/hooks/use-initial-chat-handoff";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";

const EPIC_ID = "epic-initial-chat";
const CHAT_ID = "host-chat";
const USER_ID = "owner-1";
const HOST_ID = "host-test";
const HANDOFF_SCOPE = {
  hostId: HOST_ID,
  userId: USER_ID,
  epicId: EPIC_ID,
};
const HANDOFF_CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Start the epic" }],
    },
  ],
} satisfies JsonContent;
const HANDOFF_SETTINGS = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
} satisfies ChatRunSettings;

const testState = vi.hoisted(() => ({
  request: vi.fn((_method: string) => Promise.resolve<unknown>({})),
  events: [] as string[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => () => undefined,
  };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => ({
    request: testState.request,
    getActiveHostId: () => HOST_ID,
    getActiveHost: () => null,
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => ({
    request: testState.request,
    getActiveHostId: () => HOST_ID,
    getActiveHost: () => null,
  }),
}));

// `EpicSessionProvider` opens its own durable transport via this factory, but
// the coordinator under test installs an `__setEpicStreamClientFactoryForTests`
// override that short-circuits before `openTransport` runs - so a stable stub
// opener that is never invoked lets the provider mount without the full host
// runtime.
const openTransportStub = vi.hoisted(() => () => {
  throw new Error("openTransport must not be called in this test");
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => openTransportStub,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST_ID,
}));

function CoordinatorOnly(props: {
  readonly epicId: string;
  readonly tabId: string;
}): null {
  useInitialChatHandoff(props.epicId, props.tabId);
  return null;
}

function renderWithProviders(children: ReactNode): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
  return queryClient;
}

function makeMeta(permissionRole: PermissionRole | null): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      permissionRole === null
        ? null
        : {
            id: EPIC_ID,
            title: "New Epic",
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            createdBy: USER_ID,
            version: "1",
          },
    permissionRole,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function registerPendingHandoff(): void {
  useInitialChatHandoffStore.getState().register({
    ...HANDOFF_SCOPE,
    chatId: CHAT_ID,
    content: HANDOFF_CONTENT,
    settings: HANDOFF_SETTINGS,
    worktreeIntent: null,
    placement: { kind: "active-tile" },
    messageId: "msg-test",
    clientActionId: "cai-test",
    createdAt: 1,
  });
}

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_ID);
  chat.set("userId", USER_ID);
  chat.set("title", "New chat");
  chat.set("parentId", null);
  chat.set("createdAt", 2);
  chat.set("updatedAt", 2);
  chat.set("type", "gui");
  chat.set("messages", new Y.Array());
  const chats = new Y.Map<unknown>();
  chats.set(CHAT_ID, chat);
  epic.set("title", "New Epic");
  epic.set("artifacts", new Y.Map());
  epic.set("chats", chats);
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
    selfDeletedArtifactIds: new Set<string>(),
    preAckRootCreatesByEpic: {},
    pendingRootCreatesByEpic: {},
  });
  useEpicCanvasStore
    .getState()
    .seedEpic(EPIC_ID, { tabId: EPIC_ID, name: "New Epic" }, []);
}

function handoffStatus(): string | null {
  return (
    Object.values(useInitialChatHandoffStore.getState().handoffs).at(0)
      ?.status ?? null
  );
}

function canvasChatTabs() {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[EPIC_ID];
  if (canvas === undefined) throw new Error("expected seeded epic view canvas");
  return collectPanes(canvas.root).flatMap((group) =>
    paneTabRefs(canvas, group),
  );
}

describe("initial chat handoff route coordinator", () => {
  let callbacks: EpicStreamCallbacks | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    callbacks = null;
    testState.events.length = 0;
    testState.request.mockClear();
    testState.request.mockImplementation((method: string) => {
      testState.events.push(method);
      return Promise.resolve({});
    });
    resetCanvasStore();
    useInitialChatHandoffStore.getState().resetForTests();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: USER_ID,
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: USER_ID, username: "Owner" },
    });
    __setEpicStreamClientFactoryForTests((_epicId, nextCallbacks) => {
      testState.events.push("epic.subscribe");
      callbacks = nextCallbacks;
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    __setEpicStreamClientFactoryForTests(null);
    __getOpenEpicRegistryForTests().disposeAll();
    useInitialChatHandoffStore.getState().resetForTests();
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
    resetCanvasStore();
  });

  it("never fires epic.createChat - the first chat is folded into epic.create", async () => {
    registerPendingHandoff();
    const queryClient = renderWithProviders(
      <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
        <EpicSessionGate fallback={null}>
          <CoordinatorOnly epicId={EPIC_ID} tabId={EPIC_ID} />
        </EpicSessionGate>
      </EpicSessionProvider>,
    );

    expect(testState.events).toEqual(["epic.subscribe"]);
    if (callbacks === null) throw new Error("expected epic callbacks");
    const epicCallbacks = callbacks;

    // Owner snapshot with no chat seeded yet (epic.create's chat write has not
    // projected). The hook eager-opens the tab but must not create a chat.
    act(() => {
      epicCallbacks.onConnectionStatus("open", null);
      epicCallbacks.onSnapshot(
        makeMeta("owner"),
        Y.encodeStateAsUpdate(new Y.Doc()),
      );
    });

    await waitFor(() => {
      expect(canvasChatTabs()).toContainEqual(
        expect.objectContaining({
          id: CHAT_ID,
          type: "chat",
          // No chat projected yet (projectedChatTitle null) → the node opens
          // with the "Untitled chat" render fallback, never "New chat".
          name: "Untitled chat",
          hostId: HOST_ID,
        }),
      );
    });
    expect(testState.request).not.toHaveBeenCalledWith(
      "epic.createChat",
      expect.anything(),
    );
    expect(testState.events).toEqual(["epic.subscribe"]);
    // No chat projected yet → still pending.
    expect(handoffStatus()).toBe("pending");
    queryClient.clear();
  });

  it("advances pending → waitingChat once the folded chat projects", async () => {
    registerPendingHandoff();
    const queryClient = renderWithProviders(
      <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
        <EpicSessionGate fallback={null}>
          <CoordinatorOnly epicId={EPIC_ID} tabId={EPIC_ID} />
        </EpicSessionGate>
      </EpicSessionProvider>,
    );
    if (callbacks === null) throw new Error("expected epic callbacks");
    const epicCallbacks = callbacks;

    const donor = new Y.Doc();
    seedDocWithChat(donor);
    act(() => {
      epicCallbacks.onConnectionStatus("open", null);
      epicCallbacks.onSnapshot(makeMeta("owner"), Y.encodeStateAsUpdate(donor));
    });

    await waitFor(() => {
      const handoff = Object.values(
        useInitialChatHandoffStore.getState().handoffs,
      ).at(0);
      expect(handoff).toMatchObject({
        status: "waitingChat",
        chatId: CHAT_ID,
        content: HANDOFF_CONTENT,
        settings: HANDOFF_SETTINGS,
      });
    });
    expect(testState.request).not.toHaveBeenCalledWith(
      "epic.createChat",
      expect.anything(),
    );
    expect(canvasChatTabs()).toContainEqual(
      expect.objectContaining({
        id: CHAT_ID,
        type: "chat",
        name: "New chat",
        hostId: HOST_ID,
      }),
    );
    queryClient.clear();
  });

  it("does not advance while the epic is still loading / viewer-only", async () => {
    registerPendingHandoff();
    const queryClient = renderWithProviders(
      <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
        <EpicSessionGate fallback={null}>
          <CoordinatorOnly epicId={EPIC_ID} tabId={EPIC_ID} />
        </EpicSessionGate>
      </EpicSessionProvider>,
    );
    if (callbacks === null) throw new Error("expected epic callbacks");
    const epicCallbacks = callbacks;

    const donor = new Y.Doc();
    seedDocWithChat(donor);
    act(() => {
      epicCallbacks.onConnectionStatus("open", null);
      // Viewer is not `epicReady`, so adoption must not advance the handoff.
      epicCallbacks.onSnapshot(
        makeMeta("viewer"),
        Y.encodeStateAsUpdate(donor),
      );
    });

    await Promise.resolve();
    expect(handoffStatus()).toBe("pending");
    queryClient.clear();
  });
});
