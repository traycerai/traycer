/**
 * Pins epics/1ef20d51-f355-48f6-861f-514f512a66f5/artifacts/react-perf/review-w1-e:
 * `m.li`'s `layoutDependency={orderIndex}` is a per-row `.map()` index, not a
 * description of the row's real position. Motion only re-measures a row
 * (`projection.willUpdate()` -> `getBoundingClientRect()`) when that prop
 * changes. Three moves that a bare index misses: (1) two siblings swap around
 * a stationary third row, (2) a preceding sibling expands/collapses, (3) a
 * preceding row's exit completes after a survivor's index already shifted.
 * Spies on `Element.prototype.getBoundingClientRect` (call-through) as a
 * real, load-bearing proxy for "Motion looked at this row".
 */
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";

// Same faked boundary as sidebar-chat-row-node-churn.test.tsx: no host.
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

// Loaded dynamically, AFTER the synthetic rAF below: motion-dom reads
// `requestAnimationFrame` ONCE at module load and jsdom has none, so a normal
// static import here would freeze framer-motion's frame scheduler on a
// permanent no-op for this whole file.
let ChatTreePanelBody: typeof import("@/components/epic-canvas/sidebar/epic-sidebar-chat-tree").ChatTreePanelBody;
// `m.*` needs a `<LazyMotion>` ancestor or it renders inert (no projection at
// all) - the app supplies one at the root (`traycer-app.tsx`), this suite
// does not mount the root, so it supplies its own.
let LazyMotion: typeof import("motion/react").LazyMotion;
let domMax: typeof import("motion/react").domMax;
// `processBatch` timestamps itself from real `performance.now()`, ignoring
// the rAF argument - simulated clocks can't speed it up. `instantAnimations`
// collapses a value animation's duration to 0 instead.
let MotionGlobalConfig: typeof import("motion/react").MotionGlobalConfig;

type FrameCallback = (time: number) => void;
let queuedFrames: FrameCallback[] = [];
let simulatedClock = performance.now();
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  writable: true,
  value: (callback: FrameCallback): number => {
    queuedFrames.push(callback);
    return queuedFrames.length;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  writable: true,
  value: (): void => undefined,
});

/** Ticks queued rAF callbacks `frames` times, 16ms apart. */
function flushAnimationFrames(frames: number): void {
  for (let i = 0; i < frames; i++) {
    simulatedClock += 16;
    const due = queuedFrames;
    queuedFrames = [];
    for (const callback of due) callback(simulatedClock);
  }
}

/** One rAF tick, committed and observable before the next line runs. */
async function tickAnimationFrame(): Promise<void> {
  await act(async () => {
    flushAnimationFrames(1);
    await Promise.resolve();
  });
}

/**
 * Settles any pending post-mount microtask (motion's `root.didUpdate`,
 * gated by its process-global `hasTakenAnySnapshot` flag) before a test
 * starts counting - otherwise it can land during the NEXT test's mount and
 * poison its baseline instead.
 */
async function settleMount(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeAll(async () => {
  ({ ChatTreePanelBody } =
    await import("@/components/epic-canvas/sidebar/epic-sidebar-chat-tree"));
  ({ LazyMotion, domMax, MotionGlobalConfig } = await import("motion/react"));
  MotionGlobalConfig.instantAnimations = true;
});

const EPIC_ID = "epic-layout-projection";
const TAB_ID = "tab-layout-projection";
const USER_ID = "user-1";
const PANEL_ID = "chats";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Layout projection",
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

function chatEntry(
  id: string,
  title: string,
  updatedAt: number,
  parentId: string | null,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", title);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", updatedAt);
  entry.set("hostId", "host-a");
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

interface SeedRow {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly parentId: string | null;
}

function seedDoc(rows: ReadonlyArray<SeedRow>): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chats = new Y.Map<unknown>();
  for (const row of rows) {
    chats.set(
      row.id,
      chatEntry(row.id, row.title, row.updatedAt, row.parentId),
    );
  }
  epic.set("title", "Layout projection");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

interface OpenedSession {
  readonly handle: OpenedStoreForTest;
  readonly callbacks: EpicStreamCallbacks;
}

function chatsMap(handle: OpenedStoreForTest): Y.Map<unknown> {
  const chats = handle.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    throw new Error("the seeded doc has no chats map");
  }
  return chats;
}

function createSession(rows: ReadonlyArray<SeedRow>): OpenedSession {
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
  captured.value.onSnapshot(makeMeta(), seedDoc(rows));
  return { handle, callbacks: captured.value };
}

/** `getBoundingClientRect()` calls, per `this` - default call-through, no faked geometry. */
let rectSpy: MockInstance<
  typeof Element.prototype.getBoundingClientRect
> | null = null;

function installRectSpy(): void {
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
}

function rectCallsOn(element: Element): number {
  if (rectSpy === null) throw new Error("installRectSpy() was not called");
  return rectSpy.mock.contexts.filter((context) => context === element).length;
}

function resetRectCounts(): void {
  rectSpy?.mockClear();
}

function rowLi(nodeId: string): Element {
  const item = screen.getByTestId(`epic-sidebar-item-${nodeId}`);
  const li = item.closest('li[role="treeitem"]');
  if (li === null) throw new Error(`no treeitem ancestor for ${nodeId}`);
  return li;
}

/** Root rows carrying `ids`, in actual rendered (DOM) order. */
function domOrder(ids: readonly string[]): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-sidebar-node-id]"),
  )
    .map((el) => el.getAttribute("data-sidebar-node-id") ?? "")
    .filter((id) => ids.includes(id));
}

describe("a sidebar row's Motion projection dependency", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(async () => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
    // Drain, don't discard, and YIELD microtasks between ticks: the
    // animation/projection frame loop is a process-wide singleton, and a
    // pending `root.didUpdate` microtask (motion's `hasTakenAnySnapshot`
    // flag) left unflushed here settles instead during the NEXT test's own
    // mount, corrupting its baseline before that test ever resets counts.
    for (let i = 0; i < 50 && queuedFrames.length > 0; i++) {
      await act(async () => {
        flushAnimationFrames(1);
        await Promise.resolve();
      });
    }
    await act(async () => {
      await Promise.resolve();
    });
    rectSpy?.mockRestore();
    rectSpy = null;
    queuedFrames = [];
    usePanelHeaderSearchStore.getState().closeSearch(TAB_ID, PANEL_ID);
    useEpicSidebarExpansionStore.setState({
      userExpandedByScope: {},
      userCollapsedByScope: {},
    });
    __resetAgentActivityStoreForTests();
  });

  // A(300, one child) > B(200) > C(100) by recency - order [A, B, C]. Roots
  // start expanded (epic-sidebar-expansion-store.ts), so A's child is visible.
  function renderThreeRootPanel(): OpenedSession {
    const session = createSession([
      { id: "row-a", title: "Chat row-a", updatedAt: 300, parentId: null },
      {
        id: "row-a-child",
        title: "Chat row-a child",
        updatedAt: 1,
        parentId: "row-a",
      },
      { id: "row-b", title: "Chat row-b", updatedAt: 200, parentId: null },
      { id: "row-c", title: "Chat row-c", updatedAt: 100, parentId: null },
    ]);
    opened.push(session.handle);
    installRectSpy();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LazyMotion features={domMax}>
          <EpicSessionContext.Provider value={session.handle}>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </EpicSessionContext.Provider>
        </LazyMotion>
      </QueryClientProvider>,
    );
    expect(domOrder(["row-a", "row-b", "row-c"])).toEqual([
      "row-a",
      "row-b",
      "row-c",
    ]);
    return session;
  }

  it("re-measures a sibling whose ARRAY index does not change when a reorder moves its neighbours", async () => {
    const session = renderThreeRootPanel();
    const aLi = rowLi("row-a");
    const bLi = rowLi("row-b");
    const cLi = rowLi("row-c");
    await settleMount();
    resetRectCounts();

    act(() => {
      session.handle.doc.transact(() => {
        const chats = chatsMap(session.handle);
        // C overtakes A. B's own record - and its `.map()` index - stay put.
        chats.set("row-c", chatEntry("row-c", "Chat row-c", 400, null));
        chats.set("row-a", chatEntry("row-a", "Chat row-a", 50, null));
      });
    });

    // Non-vacuity: A and C, whose index DID change, get re-measured.
    expect(domOrder(["row-a", "row-b", "row-c"])).toEqual([
      "row-c",
      "row-b",
      "row-a",
    ]);
    expect(rectCallsOn(aLi)).toBeGreaterThan(0);
    expect(rectCallsOn(cLi)).toBeGreaterThan(0);

    // THE PIN: B's neighbours both moved past it, but its `.map()` index
    // stayed at 1, so `layoutDependency` never changes and B is never
    // re-measured - it jumps instead of animating.
    expect(rectCallsOn(bLi)).toBeGreaterThan(0);
  });

  it("re-measures a later sibling when a PRECEDING sibling's subtree collapses, though no array index moves", async () => {
    renderThreeRootPanel();
    expect(
      screen.queryByTestId("epic-sidebar-item-row-a-child"),
    ).not.toBeNull();
    const bLi = rowLi("row-b");
    await settleMount();
    resetRectCounts();

    act(() => {
      useEpicSidebarExpansionStore
        .getState()
        .collapse(TAB_ID, PANEL_ID, "row-a");
    });

    // Non-vacuity: A's child is really gone, B's own row and index untouched.
    expect(screen.queryByTestId("epic-sidebar-item-row-a-child")).toBeNull();
    expect(domOrder(["row-a", "row-b", "row-c"])).toEqual([
      "row-a",
      "row-b",
      "row-c",
    ]);

    // THE PIN: collapsing A shortens the space above B, but no `.map()`
    // index changes on an expand/collapse, so B is never re-measured.
    expect(rectCallsOn(bLi)).toBeGreaterThan(0);
  });

  it("does NOT re-measure any row on activity churn that moves nothing", async () => {
    const session = renderThreeRootPanel();
    const aLi = rowLi("row-a");
    const bLi = rowLi("row-b");
    const cLi = rowLi("row-c");
    await settleMount();
    resetRectCounts();

    act(() => {
      session.handle.doc.transact(() => {
        const chats = chatsMap(session.handle);
        // A stays most-recent - order unchanged - but its `updatedAt` moves.
        chats.set("row-a", chatEntry("row-a", "Chat row-a", 305, null));
      });
    });
    act(() => {
      // A real activity-tier mutation (not just a timestamp): C starts an
      // active turn. Also does not move anyone's order.
      __setAgentActivityPlaneAnsweringForTests();
      __setAgentActivityStateForTests(
        { [EPIC_ID]: { working: ["row-c"], turn: ["row-c"] } },
        "local",
        "connected",
      );
    });

    // Non-vacuity: both stimuli really landed, order still unchanged.
    expect(
      session.handle.store.getState().tree.nodeById["row-a"].updatedAt,
    ).toBe(305);
    expect(domOrder(["row-a", "row-b", "row-c"])).toEqual([
      "row-a",
      "row-b",
      "row-c",
    ]);

    // Neither an activity timestamp nor a real activity-tier change may
    // invalidate the dependency for anyone. A fix that invalidates on every
    // render would pass the two regressions above and fail this one.
    expect(rectCallsOn(aLi)).toBe(0);
    expect(rectCallsOn(bLi)).toBe(0);
    expect(rectCallsOn(cLi)).toBe(0);
  });

  it("re-measures the surviving row once the row ABOVE it finishes exiting, not only when it starts", async () => {
    // Titled so a search can single one out while it still exists in the
    // store - the "filtered, not deleted" case; deletion makes the exiting
    // row's own content go null mid-exit, a different lifecycle.
    const session = createSession([
      {
        id: "exit-target",
        title: "Exit Target",
        updatedAt: 200,
        parentId: null,
      },
      {
        id: "exit-survivor",
        title: "Chat Survivor",
        updatedAt: 100,
        parentId: null,
      },
    ]);
    opened.push(session.handle);
    installRectSpy();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LazyMotion features={domMax}>
          <EpicSessionContext.Provider value={session.handle}>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </EpicSessionContext.Provider>
        </LazyMotion>
      </QueryClientProvider>,
    );
    expect(domOrder(["exit-target", "exit-survivor"])).toEqual([
      "exit-target",
      "exit-survivor",
    ]);

    const survivorLi = rowLi("exit-survivor");
    await settleMount();
    resetRectCounts();

    act(() => {
      // Matches "Chat Survivor" but not "Exit Target" - the target still
      // exists in the store, only the RENDERED root list drops it.
      usePanelHeaderSearchStore.getState().openSearch(TAB_ID, PANEL_ID, "");
      usePanelHeaderSearchStore
        .getState()
        .setSearchQuery(TAB_ID, PANEL_ID, "survivor");
    });

    // Non-vacuity, mid-exit: filtered from the rendered root list (survivor's
    // index already moved 1 -> 0) but still mounted - AnimatePresence's
    // default `sync` mode keeps an exiting child in flow until it finishes.
    expect(screen.getByTestId("epic-sidebar-item-exit-target")).toBeTruthy();

    // One committed rAF tick per sample (not one act around the whole loop),
    // so each frame's DOM/state settles before we read it - otherwise React
    // can defer the final unmount commit past the last read inside a single
    // multi-frame act, and the pin would compare two pre-commit snapshots.
    // Seeded with the pre-loop state above (mounted) so a fix fast enough to
    // finish on the very first tick still leaves a "still mounted" sample to
    // compare against.
    const trace: Array<{ rectCalls: number; targetMounted: boolean }> = [
      { rectCalls: rectCallsOn(survivorLi), targetMounted: true },
    ];
    for (let i = 0; i < 30; i++) {
      await tickAnimationFrame();
      trace.push({
        rectCalls: rectCallsOn(survivorLi),
        targetMounted:
          screen.queryByTestId("epic-sidebar-item-exit-target") !== null,
      });
    }

    // Non-vacuity: the exit actually completed - otherwise the pin below
    // would pass by the exit simply never finishing.
    expect(screen.queryByTestId("epic-sidebar-item-exit-target")).toBeNull();
    const lastMounted = trace.filter((sample) => sample.targetMounted).at(-1);
    if (lastMounted === undefined) {
      throw new Error("target was never observed mounted during the trace");
    }
    const final = trace.at(-1);
    if (final === undefined) throw new Error("empty trace");

    // THE PIN: completing the exit is when the survivor's real position
    // moves, but its `.map()` index already changed once, at the filter, and
    // does not change again on completion - so it is never re-measured then.
    expect(final.rectCalls).toBeGreaterThan(lastMounted.rectCalls);
  });
});
