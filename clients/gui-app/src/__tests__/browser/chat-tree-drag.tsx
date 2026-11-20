import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useDndContext } from "@dnd-kit/core";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import * as Y from "yjs";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EpicLeftPanelHost } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
  handleHostClients,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * The REAL chat tree, panel and drag provider: `EpicLeftPanelHost` (the
 * virtualised chat tree inside its panel drop zone) under the real
 * `RootDndProvider`, over a seeded epic session. Driven by
 * `browser-tests/sidebar-tree-drag.spec.ts` with real pointer input.
 *
 * `?chats=N` sets how many root chats there are (default 300, so most rows
 * start unmounted). The first roots are shaped for the specs:
 * - `chat-002` has the children `chat-002-a` and `chat-002-b`, EXPANDED, so a
 *   nested chat can be un-nested.
 * - `chat-0` + a folder index: the folder (see `FOLDER_ID`) has three children
 *   and starts COLLAPSED.
 *
 * `window.__chatTreeDragProbe` carries what a spec reads back: the parent the
 * session's projected tree gives a chat, and the `epic.reparentChat` requests
 * the host received.
 */
const EPIC_ID = "fixture-chat-tree-drag";
const TAB_ID = "tab-chat-tree-drag";
const HOST_ID = mockLocalHostEntry.hostId;
const ROOT_COUNT = Number(
  new URLSearchParams(window.location.search).get("chats") ?? "300",
);
const FOLDER_ID = "chat-001";

function rootId(index: number): string {
  return `chat-${String(index).padStart(3, "0")}`;
}

interface Seed {
  readonly tree: {
    readonly rootIds: string[];
    readonly childrenByParent: Record<string, string[]>;
    readonly nodeById: Record<string, TreeNode>;
  };
  readonly chats: Record<string, ChatProjection>;
}

function seed(): Seed {
  const rootIds: string[] = [];
  const childrenByParent: Record<string, string[]> = {};
  const nodeById: Record<string, TreeNode> = {};
  const chats: Record<string, ChatProjection> = {};
  const add = (id: string, parentId: string | null, rank: number): void => {
    // Newer first: the default order lists rows by this clock, descending.
    const stamp = 1_000_000 - rank;
    nodeById[id] = {
      id,
      parentId,
      title: `Chat ${id}`,
      type: "chat",
      status: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    chats[id] = {
      id,
      title: `Chat ${id}`,
      parentId,
      createdAt: stamp,
      updatedAt: stamp,
      userId: null,
      ownedByViewer: true,
      hostId: HOST_ID,
      isTitleEditedByUser: false,
      docResident: false,
      archivedAt: null,
      settings: null,
    };
    if (parentId === null) rootIds.push(id);
    else
      childrenByParent[parentId] = [...(childrenByParent[parentId] ?? []), id];
  };
  for (let index = 0; index < ROOT_COUNT; index += 1) {
    add(rootId(index), null, index * 10);
  }
  const children: ReadonlyArray<readonly [string, string]> = [
    ["chat-002", "chat-002-a"],
    ["chat-002", "chat-002-b"],
    [FOLDER_ID, `${FOLDER_ID}-a`],
    [FOLDER_ID, `${FOLDER_ID}-b`],
    [FOLDER_ID, `${FOLDER_ID}-c`],
  ];
  for (const [parent, child] of children) {
    if (!Object.hasOwn(nodeById, parent)) continue;
    add(child, parent, Number(parent.slice(5)) * 10 + 1);
  }
  return { tree: { rootIds, childrenByParent, nodeById }, chats };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Chat tree drag",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function moveChat(chatId: string, newParentId: string | null): void {
  SESSION.store.setState((state) => {
    const node = state.tree.nodeById[chatId];
    const oldParent = node.parentId;
    const childrenByParent = { ...state.tree.childrenByParent };
    let rootIds = state.tree.rootIds;
    if (oldParent === null) rootIds = rootIds.filter((id) => id !== chatId);
    else {
      childrenByParent[oldParent] = childrenByParent[oldParent].filter(
        (id) => id !== chatId,
      );
    }
    if (newParentId === null) rootIds = [...rootIds, chatId];
    else {
      childrenByParent[newParentId] = [
        ...(childrenByParent[newParentId] ?? []),
        chatId,
      ];
    }
    return {
      tree: {
        rootIds,
        childrenByParent,
        nodeById: {
          ...state.tree.nodeById,
          [chatId]: { ...node, parentId: newParentId },
        },
      },
      chats: {
        ...state.chats,
        byId: {
          ...state.chats.byId,
          [chatId]: { ...state.chats.byId[chatId], parentId: newParentId },
        },
      },
    };
  });
}

const reparentRequests: Array<{
  readonly chatId: string;
  readonly newParentId: string | null;
}> = [];

function openSession() {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const streamClientFactory: EpicStreamClientFactory = (_id, callbacks) => {
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
    userId: null,
    factories: { streamClientFactory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  const seeded = seed();
  handle.store.setState({
    tree: seeded.tree,
    chats: { allIds: Object.keys(seeded.chats), byId: seeded.chats },
  });
  getOpenEpicRegistry().acquire(EPIC_ID, () => handle);
  return handle;
}

const SESSION = openSession();
handleHostIds.set(SESSION, HOST_ID);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `chat-tree-drag-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "host.notifications.indicatorState": () => ({
        epics: {},
        chats: {},
        complete: true,
      }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

// The session's own host client: the one the drop commit sends
// `epic.reparentChat` through.
const spine = new HostClient({
  registry: hostRpcRegistry,
  invalidator: createHostQueryInvalidator(queryClient),
  messenger: new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => `chat-tree-drag-session-${String(++requestCounter)}`,
    handlers: {
      "epic.reparentChat": (params) => {
        reparentRequests.push({
          chatId: params.chatId,
          newParentId: params.newParentId,
        });
        // The host's answer: the record moves and the tree is told, as the
        // record channel's push would.
        moveChat(params.chatId, params.newParentId);
        return { updated: true };
      },
    },
  }),
  findHostById: (hostId) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
});
const sessionHostClient = spine.createRequester(mockLocalHostEntry);
sessionHostClient.setRequestContext(
  createRendererContextFixture({ bearerToken: "token" }),
);
recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["epic.reparentChat"]);
handleHostClients.set(SESSION, sessionHostClient);

interface AncestorFrame {
  readonly id: string;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}
interface DragFrame {
  readonly ancestors: AncestorFrame[];
  readonly t: number;
  readonly scrollTop: number | null;
  readonly scrollHeight: number | null;
  readonly clientHeight: number | null;
  readonly scrollerTop: number | null;
  readonly scrollerBottom: number | null;
  readonly overId: string | null;
  readonly overConnected: boolean | "no-node" | null;
  readonly activeConnected: boolean | null;
  readonly activeNodeTop: number | null;
  readonly pointerY: number | null;
  readonly mountedRows: number;
  readonly scrollEvents: number;
  readonly activeElement: string;
}
const FRAME_RING = 600;
const dragFrames: DragFrame[] = [];
let pointerY: number | null = null;
let scrollEvents = 0;
document.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.getAttribute("data-sidebar") === "content"
    ) {
      scrollEvents += 1;
    }
  },
  true,
);
window.addEventListener("pointermove", (event) => {
  pointerY = event.clientY;
});

Reflect.set(window, "__chatTreeDragProbe", {
  ready: false,
  frames: (last: number): DragFrame[] => dragFrames.slice(-last),
  parentOf: (id: string): string | null | undefined =>
    SESSION.store.getState().tree.nodeById[id]?.parentId,
  reparentRequests: (): ReadonlyArray<{
    readonly chatId: string;
    readonly newParentId: string | null;
  }> => [...reparentRequests],
  expand: (id: string): void =>
    useEpicSidebarExpansionStore.getState().expand(TAB_ID, "chats", id),
  collapse: (id: string): void =>
    useEpicSidebarExpansionStore.getState().collapse(TAB_ID, "chats", id),
});

function describeScrollable(element: Element): AncestorFrame {
  const label =
    element.getAttribute("data-testid") ??
    element.getAttribute("data-sidebar") ??
    "";
  return {
    id: `${element.tagName.toLowerCase()}${label}.${element.classList.item(0) ?? ""}`,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/** Every scrollable ancestor of `from`, innermost first, then the document's scroller. */
function scrollableAncestors(from: HTMLElement | null): AncestorFrame[] {
  const ancestors: AncestorFrame[] = [];
  for (
    let el = from?.parentElement ?? null;
    el !== null;
    el = el.parentElement
  ) {
    const overflowY = getComputedStyle(el).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      ancestors.push(describeScrollable(el));
    }
  }
  if (document.scrollingElement !== null) {
    ancestors.push(describeScrollable(document.scrollingElement));
  }
  return ancestors;
}

function treeScrollerFrame(): Pick<
  DragFrame,
  | "scrollTop"
  | "scrollHeight"
  | "clientHeight"
  | "scrollerTop"
  | "scrollerBottom"
> {
  const scroller = [
    ...document.querySelectorAll<HTMLElement>('[data-sidebar="content"]'),
  ]
    .filter((node) => node.querySelector("ul[role=tree]") !== null)
    .at(-1);
  if (scroller === undefined) {
    return {
      scrollTop: null,
      scrollHeight: null,
      clientHeight: null,
      scrollerTop: null,
      scrollerBottom: null,
    };
  }
  const rect = scroller.getBoundingClientRect();
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scrollerTop: rect.top,
    scrollerBottom: rect.bottom,
  };
}

function overConnection(
  hasOver: boolean,
  overNode: HTMLElement | null,
): DragFrame["overConnected"] {
  if (!hasOver) return null;
  return overNode === null ? "no-node" : overNode.isConnected;
}

function activeElementLabel(): string {
  const active = document.activeElement;
  if (active === null) return "none";
  return active.getAttribute("data-testid") ?? active.tagName.toLowerCase();
}

/** Records the drag's state every frame, for diagnosing a stalled auto-scroll. */
function FrameProbe(): null {
  const dnd = useDndContext();
  const latest = useRef(dnd);
  useLayoutEffect(() => {
    latest.current = dnd;
  });
  const dragging = dnd.active !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = (): void => {
      const now = latest.current;
      const overNode =
        now.over === null
          ? null
          : (now.droppableContainers.get(now.over.id)?.node.current ?? null);
      const source = overNode ?? now.activeNode;
      dragFrames.push({
        ancestors: scrollableAncestors(
          source instanceof HTMLElement ? source : null,
        ),
        t: Math.round(performance.now()),
        ...treeScrollerFrame(),
        overId: now.over === null ? null : String(now.over.id),
        overConnected: overConnection(now.over !== null, overNode),
        activeConnected: now.activeNode?.isConnected ?? null,
        activeNodeTop: now.activeNodeRect?.top ?? null,
        pointerY,
        mountedRows: document.querySelectorAll("[data-index]").length,
        scrollEvents,
        activeElement: activeElementLabel(),
      });
      if (dragFrames.length > FRAME_RING) dragFrames.shift();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
  return null;
}

export function Fixture(): ReactNode {
  useEffect(() => {
    Reflect.set(Reflect.get(window, "__chatTreeDragProbe"), "ready", true);
  }, []);
  return (
    <div className="flex h-dvh bg-canvas text-canvas-foreground">
      <FrameProbe />
      <div
        data-fixture-panel
        className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-background"
      >
        <SidebarProvider className="min-h-0 flex-1">
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>
      </div>
      <main
        data-fixture-content
        className="min-w-0 flex-1 bg-background p-4 text-ui-sm"
      />
    </div>
  );
}

const fixtureErrors: string[] = [];
window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__chatTreeDragErrors", fixtureErrors);

const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <EpicSessionContext value={SESSION}>
                <SnapshotLoadingProvider
                  value={{ snapshotLoaded: true, snapshotFetchError: null }}
                >
                  <RootDndProvider>
                    <Fixture />
                  </RootDndProvider>
                </SnapshotLoadingProvider>
              </EpicSessionContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  ),
});
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
