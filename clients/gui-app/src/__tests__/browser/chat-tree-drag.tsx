import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  useDndContext,
  useDndMonitor,
  type DragMoveEvent,
} from "@dnd-kit/core";
import type {
  DragStep,
  DragStepResult,
} from "../../../browser-tests/support/chat-tree-drag-globals";
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
interface ScrollerGeometry {
  readonly scrollTop: number;
  readonly generation: number;
}

const geometryByScroller = new WeakMap<HTMLElement, ScrollerGeometry>();

function scrollerGeometry(scroller: HTMLElement): ScrollerGeometry {
  const previous = geometryByScroller.get(scroller);
  const scrollTop = scroller.scrollTop;
  if (previous?.scrollTop === scrollTop) return previous;
  const geometry = { scrollTop, generation: (previous?.generation ?? 0) + 1 };
  geometryByScroller.set(scroller, geometry);
  return geometry;
}

function sameScrollerGeometry(
  a: ScrollerGeometry,
  b: ScrollerGeometry,
): boolean {
  return a.generation === b.generation && a.scrollTop === b.scrollTop;
}

document.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.getAttribute("data-sidebar") === "content"
    ) {
      scrollEvents += 1;
      scrollerGeometry(target);
    }
  },
  true,
);
window.addEventListener("pointermove", (event) => {
  pointerY = event.clientY;
});

interface StepWatch {
  readonly result: Promise<DragStepResult>;
  readonly finishInput: () => void;
  readonly didCommit: () => void;
  readonly stop: () => void;
}
let stepWatch: StepWatch | null = null;
interface CommittedDrag {
  readonly active: DragMoveEvent["active"] | null;
  readonly collisions: DragMoveEvent["collisions"];
  readonly over: DragMoveEvent["over"];
  readonly scrollableAncestors: readonly Element[];
  readonly hasOverlayRect: boolean;
}
let committedDrag: CommittedDrag | null = null;
interface ProcessedStep {
  readonly serial: number;
  readonly active: string | number;
  readonly pointerY: number | null;
  readonly scrollTop: number;
  readonly collisionTop: number;
  readonly over: string | number | null;
}

let processedStep: ProcessedStep | null = null;
let moveSerial = 0;
let dragStartOffset = 0;

function matchesProcessedInput(
  step: ProcessedStep,
  input: {
    readonly kind: DragStep;
    readonly expectedY: number | null;
    readonly afterSerial: number;
    readonly scrollTop: number;
    readonly scrollRequested: boolean;
    readonly scrollEnded: boolean;
  },
): boolean {
  const {
    kind,
    expectedY,
    afterSerial,
    scrollTop,
    scrollRequested,
    scrollEnded,
  } = input;
  if (kind === "keyboard") {
    // The scroll-only sensor path may emit its move before scrollend, but it
    // must already encode the offset that native scrolling settled at.
    return (
      step.pointerY === null &&
      step.serial > afterSerial &&
      Math.abs(step.scrollTop - scrollTop) < 0.01 &&
      (!scrollRequested || scrollEnded)
    );
  }
  return (
    step.pointerY !== null &&
    expectedY !== null &&
    Math.abs(step.pointerY - expectedY) < 0.01 &&
    step.serial > afterSerial
  );
}

function matchesCommittedCollision(
  dnd: CommittedDrag,
  event: DragMoveEvent,
): boolean {
  return (
    dnd.active?.id === event.active.id &&
    dnd.hasOverlayRect &&
    event.collisions === dnd.collisions
  );
}

function matchesCommittedStep(
  dnd: CommittedDrag,
  move: ProcessedStep,
): boolean {
  return (
    dnd.active?.id === move.active &&
    dnd.active.rect.current.translated?.top === move.collisionTop &&
    (dnd.over?.id ?? null) === move.over &&
    (dnd.collisions?.[0]?.id ?? null) === move.over
  );
}

function observeProcessedMove(event: DragMoveEvent): void {
  const dnd = committedDrag;
  const { initial, translated } = event.active.rect.current;
  if (
    dnd === null ||
    !matchesCommittedCollision(dnd, event) ||
    initial === null ||
    translated === null
  ) {
    return;
  }
  const over = event.over?.id ?? null;
  if ((event.collisions?.[0]?.id ?? null) !== over) return;
  // The real root has no DndContext modifiers, and dnd-kit uses zero node
  // correction once the overlay is measured. Its translated rect encodes
  // the unsummed movement; event.delta is that movement plus scroll.
  const moveY = translated.top - initial.top;
  const activation = event.activatorEvent;
  if (
    !(activation instanceof KeyboardEvent) &&
    !(activation instanceof MouseEvent)
  )
    return;
  processedStep = {
    serial: ++moveSerial,
    active: event.active.id,
    pointerY:
      activation instanceof MouseEvent ? activation.clientY + moveY : null,
    scrollTop: dragStartOffset + event.delta.y - moveY,
    collisionTop: translated.top,
    over,
  };
  queueMicrotask(() => stepWatch?.didCommit());
}

function treeScroller(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-sidebar="content"]')]
    .filter((node) => node.querySelector("ul[role=tree]") !== null)
    .at(-1);
}

function armStep(kind: DragStep, expectedY: number | null): void {
  if (stepWatch !== null) throw new Error("drag step is already armed");
  const selectedScroller = treeScroller();
  if (selectedScroller === undefined) throw new Error("no sidebar scroller");
  const scroller = selectedScroller;
  const before = scrollerGeometry(scroller);
  let pointerInput: ScrollerGeometry | null = null;
  const { promise, resolve } = Promise.withResolvers<DragStepResult>();
  let inputDone = false;
  let afterSerial = moveSerial;
  let keyboardInputSeen = kind !== "keyboard";
  let scrollRequested = false;
  let scrollEnded = false;

  function resolveEdge(
    dnd: CommittedDrag,
    move: ProcessedStep,
    geometry: ScrollerGeometry,
  ): void {
    const position = {
      scrollTop: geometry.scrollTop,
      scrollGeneration: geometry.generation,
    };
    if (geometry.scrollTop !== before.scrollTop) {
      resolve({ outcome: "advanced", ...position, keyboardScroll: null });
    } else if (
      pointerInput !== null &&
      sameScrollerGeometry(pointerInput, geometry) &&
      !dnd.scrollableAncestors.includes(scroller) &&
      (move.over === null ||
        String(move.over).startsWith("sidebar-reparent-panel:"))
    ) {
      resolve({ outcome: "panel-gap", ...position, keyboardScroll: null });
    }
  }

  function check(): void {
    const dnd = committedDrag;
    const move = processedStep;
    if (
      !inputDone ||
      !keyboardInputSeen ||
      (kind !== "keyboard" && pointerInput === null) ||
      dnd === null ||
      move === null ||
      !matchesCommittedStep(dnd, move)
    ) {
      return;
    }
    const geometry = scrollerGeometry(scroller);
    if (
      !matchesProcessedInput(move, {
        kind,
        expectedY,
        afterSerial,
        scrollTop: geometry.scrollTop,
        scrollRequested,
        scrollEnded,
      })
    ) {
      return;
    }
    if (kind === "edge") {
      resolveEdge(dnd, move, geometry);
      return;
    }
    let keyboardScroll: DragStepResult["keyboardScroll"] = null;
    if (kind === "keyboard") {
      keyboardScroll = scrollRequested ? "offset" : "stationary";
    }
    resolve({
      outcome: "committed",
      scrollTop: geometry.scrollTop,
      scrollGeneration: geometry.generation,
      keyboardScroll,
    });
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (event.isTrusted && event.code === "ArrowDown") {
      afterSerial = moveSerial;
      keyboardInputSeen = true;
    }
  };
  // The panel's committed ancestor list omits the scroller. Capture the
  // geometry before the sensor handles the trusted point, then require it
  // to survive through the matching commit before reporting a panel gap.
  const pointerMove = (event: PointerEvent): void => {
    if (event.isTrusted && event.clientY === expectedY) {
      afterSerial = moveSerial;
      pointerInput = scrollerGeometry(scroller);
    }
  };
  const scrollEnd = (): void => {
    scrollEnded = true;
    check();
  };
  scroller.addEventListener("scroll", check);
  scroller.addEventListener("scrollend", scrollEnd);
  if (kind === "keyboard") window.addEventListener("keydown", keyDown, true);
  else window.addEventListener("pointermove", pointerMove, true);

  // The stock keyboard sensor can use native scrolling without a position
  // action. Observe its intent synchronously, then wait for native scrollend
  // only when it actually requested a different offset.
  const restore: (() => void)[] = [];
  if (kind === "keyboard") {
    for (const method of ["scrollTo", "scrollBy"] as const) {
      const native = scroller[method];
      const own = Object.getOwnPropertyDescriptor(scroller, method);
      Object.defineProperty(scroller, method, {
        configurable: true,
        value: (
          options: ScrollToOptions | number | undefined,
          second: number | undefined,
        ): void => {
          const current = scroller.scrollTop;
          const top = typeof options === "number" ? second : options?.top;
          if (top !== undefined) {
            const wanted = method === "scrollBy" ? current + top : top;
            const limit = scroller.scrollHeight - scroller.clientHeight;
            if (Math.max(0, Math.min(limit, wanted)) !== current) {
              scrollRequested = true;
              scrollEnded = false;
            }
          }
          Reflect.apply(
            native,
            scroller,
            second === undefined ? [options] : [options, second],
          );
        },
      });
      restore.push(() => {
        if (own === undefined) Reflect.deleteProperty(scroller, method);
        else Object.defineProperty(scroller, method, own);
      });
    }
  }
  stepWatch = {
    result: promise,
    finishInput: () => {
      inputDone = true;
      check();
    },
    didCommit: check,
    stop: () => {
      scroller.removeEventListener("scroll", check);
      scroller.removeEventListener("scrollend", scrollEnd);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("pointermove", pointerMove, true);
      for (const undo of restore) undo();
    },
  };
}

Reflect.set(window, "__chatTreeDragProbe", {
  ready: false,
  armStep,
  scrollGeneration: () => {
    const scroller = treeScroller();
    if (scroller === undefined) throw new Error("no sidebar scroller");
    return scrollerGeometry(scroller).generation;
  },
  finishInput: () => stepWatch?.finishInput(),
  stepResult: () => {
    if (stepWatch === null) throw new Error("no armed drag step");
    return stepWatch.result;
  },
  stopStep: () => {
    stepWatch?.stop();
    stepWatch = null;
  },
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
  const scroller = treeScroller();
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
    committedDrag = {
      active: dnd.active,
      collisions: dnd.collisions,
      over: dnd.over,
      scrollableAncestors: dnd.scrollableAncestors,
      hasOverlayRect: dnd.dragOverlay.rect !== null,
    };
    queueMicrotask(() => stepWatch?.didCommit());
  });
  useDndMonitor({
    onDragStart: () => {
      processedStep = null;
      dragStartOffset = treeScroller()?.scrollTop ?? 0;
    },
    onDragMove: observeProcessedMove,
    onDragOver: observeProcessedMove,
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
    <div className="flex h-safe-dvh bg-canvas text-canvas-foreground">
      <FrameProbe />
      <div
        data-fixture-panel
        className="flex h-full w-full max-w-80 flex-col border-r border-border bg-background"
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
