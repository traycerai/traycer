import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useDndContext } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EpicLeftPanelHost } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  EpicSessionContext,
  handleHostClients,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import { FixtureProviders } from "./chat-tree-fixture-providers";
import {
  captureFixtureErrors,
  createFixtureMessengerFactory,
  createFixtureRunnerHost,
  createFixtureSessionHostClient,
  mountFixturePage,
  openFixtureSession,
} from "./chat-tree-fixture-session";
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
 * - the folder (see `FOLDER_ID`) has three children.
 * - `?folders=1` also gives every second root from `chat-010` to `chat-058` three
 *   children, so a folder is always among the rows an auto-scroll brings in.
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
const EXTRA_FOLDERS =
  new URLSearchParams(window.location.search).get("folders") === "1";
const EXTRA_FOLDER_IDS: readonly string[] = EXTRA_FOLDERS
  ? Array.from({ length: 25 }, (_, step) => rootId(10 + step * 2))
  : [];

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
    ...EXTRA_FOLDER_IDS.flatMap((folder): Array<readonly [string, string]> => [
      [folder, `${folder}-a`],
      [folder, `${folder}-b`],
      [folder, `${folder}-c`],
    ]),
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

const SESSION = openFixtureSession({
  epicId: EPIC_ID,
  userId: null,
  meta: makeMeta(),
  seedDoc: Y.encodeStateAsUpdate(new Y.Doc()),
});
const seeded = seed();
SESSION.store.setState({
  tree: seeded.tree,
  chats: { allIds: Object.keys(seeded.chats), byId: seeded.chats },
});
handleHostIds.set(SESSION, HOST_ID);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const runnerHost = createFixtureRunnerHost();

let requestCounter = 0;
const messengerFactory = createFixtureMessengerFactory({
  requestIdPrefix: "chat-tree-drag",
  extra: {
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
  },
});

// The session's own host client: the one the drop commit sends
// `epic.reparentChat` through.
const sessionHostClient = createFixtureSessionHostClient({
  queryClient,
  requestId: () => `chat-tree-drag-session-${String(++requestCounter)}`,
  bearerToken: "token",
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
});
recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["epic.reparentChat"]);
handleHostClients.set(SESSION, sessionHostClient);

interface AncestorFrame {
  readonly id: string;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}
interface DragFrame {
  /** The ancestors dnd-kit passes to its auto-scroller. */
  readonly ancestors: AncestorFrame[];
  readonly treeScrollerInDndAncestors: boolean;
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

function treeScrollerFrame(
  scrollableAncestors: readonly Element[],
): Pick<
  DragFrame,
  | "scrollTop"
  | "scrollHeight"
  | "clientHeight"
  | "scrollerTop"
  | "scrollerBottom"
  | "treeScrollerInDndAncestors"
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
      treeScrollerInDndAncestors: false,
    };
  }
  const rect = scroller.getBoundingClientRect();
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scrollerTop: rect.top,
    scrollerBottom: rect.bottom,
    treeScrollerInDndAncestors: scrollableAncestors.includes(scroller),
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
      dragFrames.push({
        ancestors: now.scrollableAncestors.map(describeScrollable),
        t: Math.round(performance.now()),
        ...treeScrollerFrame(now.scrollableAncestors),
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

Reflect.set(window, "__chatTreeDragErrors", captureFixtureErrors());

mountFixturePage(() => (
  <FixtureProviders
    queryClient={queryClient}
    runnerHost={runnerHost}
    messengerFactory={messengerFactory}
  >
    <EpicSessionContext value={SESSION}>
      <SnapshotLoadingProvider
        value={{ snapshotLoaded: true, snapshotFetchError: null }}
      >
        <RootDndProvider>
          <Fixture />
        </RootDndProvider>
      </SnapshotLoadingProvider>
    </EpicSessionContext>
  </FixtureProviders>
));
