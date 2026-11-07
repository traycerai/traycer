import { useSyncExternalStore } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { RouterHistory, UseNavigateResult } from "@tanstack/react-router";
import {
  type EpicRouteFocusIntent,
  useEpicRouteSynchronization,
} from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import {
  makeSelectActiveEpicArtifactId,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  makeOpenableNodeRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import {
  navigateNestedFocus,
  type NestedFocusNavigationRouter,
  type PrepareNestedFocusTarget,
} from "@/lib/epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { resetNestedFocusNavigationIntentsForTests } from "@/lib/nested-focus-navigation-intent";
import type { PersistentHistoryController } from "@/lib/persistent-history";
import {
  setEpicSurfaceVisibility,
  surfaceHostOpenedTab,
} from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { TILE_KIND_BROWSER_SESSION } from "@/stores/epics/canvas/tile-kinds";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * T156 (the real-store regression suite for the bot-channel artifact-open
 * defect). `use-epic-route-synchronization.test.tsx` mocks BOTH
 * `@/lib/epic-auto-open` and `@/lib/canvas/tile-open/open-tile`, which is
 * exactly why it never caught this: those two seams are the mechanism of
 * the defect, so this file keeps them REAL and drives the REAL canvas store
 * instead, asserting on the destination tab's actual tile/active-artifact
 * state rather than on a captured navigation intent.
 */

interface TestRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  /** The real record field's type, so an unopenable kind fails to compile. */
  readonly type: EpicNodeKind;
  readonly hostId: string;
}

const HOST_ID = "host-1";
const EPIC_ID = "route-focus-epic";
const TAB_ID = "route-focus-tab";

// `useEpicArtifactRecords` (`@/lib/epic-selectors`) is a controllable
// external store so case 4 can mount with NO records and push one in later,
// under `act`, and have the hook re-render on it - the same pattern
// `epic-tab-route-recency-wait.test.tsx` uses for its home reading.
const recordsStore = vi.hoisted(() => {
  let records: ReadonlyArray<TestRecord> = [];
  const listeners = new Set<() => void>();
  return {
    get: () => records,
    set(next: ReadonlyArray<TestRecord>): void {
      records = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const openEpicHandleState = vi.hoisted(() => ({
  setLastFocusedArtifactId: vi.fn(),
  setLastFocusedThreadId: vi.fn(),
}));

// Controllable so the supersession cases can cover both nested-history
// modes: `null` is OFF (the suite's prior default, mocked unconditionally),
// a truthy stand-in is ON. The controller's own shape is never read by this
// mock's callers - only nullness matters to `nestedFocusEnabled`.
const persistentHistoryState = vi.hoisted(() => ({
  controller: null as PersistentHistoryController | null,
}));

// Controllable so case 4 can start cold (no snapshot yet) and flip loaded
// mid-test, matching `useEpicArtifactRecords`'s own controllable-store
// pattern above.
const snapshotLoadedState = vi.hoisted(() => ({ loaded: true }));

/**
 * The part of a navigate call this suite reads: the search REDUCER the route
 * writes its focus params through. Declared so the mock carries a real call
 * signature - a parameterless `vi.fn` makes `mock.calls[n]` an empty tuple,
 * and indexing it to inspect the emitted search is then a type error rather
 * than an assertion.
 */
interface NavigateCallOptions {
  readonly search?: (prev: Record<string, unknown>) => Record<string, unknown>;
}

const navigateMock = vi.hoisted(() =>
  vi.fn(
    (_options: NavigateCallOptions) => Promise.resolve() as Promise<unknown>,
  ),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({
    history: {},
    navigate: navigateMock,
    state: {
      location: { pathname: `/epics/${EPIC_ID}/${TAB_ID}`, search: {} },
    },
  }),
}));

// Nested-focus route state is orthogonal to the original D1/D2 defect
// (which lives entirely in the legacy auto-open effect), and keeping it off
// by default collapses the hook down to that one effect's branch. The
// supersession cases below flip `persistentHistoryState.controller` to cover
// the ON mode too - the route-canonicalization effect (case 5) only runs
// under it.
vi.mock("@/lib/persistent-history", () => ({
  getHistoryController: () => persistentHistoryState.controller,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: { getState: () => openEpicHandleState },
  }),
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

// A SETTLED, successful, empty cloud chat list - none of these cases open a
// chat tile, so the reap/sweep effect's cloud-known exemption never needs to
// admit anything; it only needs to authorize the sweep (see the longer
// comment in `use-epic-route-synchronization.test.tsx` for why `isSuccess`
// must be explicit rather than left to answer `undefined`).
//
// Only the two HOOKS are stubbed. `cloudChatListAuthorizesRecordSweep` is the
// real pure function, reading the flags below: stubbing it to `true` would
// assert nothing about whether this stub actually authorizes the sweep, and
// would hide the day its required flags change.
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return {
    ...actual,
    useCloudChatList: () => ({
      data: { chats: [] as ReadonlyArray<CloudChatSummary> },
      isEnabled: true,
      isSuccess: true,
      isError: false,
      isPending: false,
      isFetching: false,
      error: null,
    }),
    useCloudChatHasCloudAuthorization: () => true,
  };
});

vi.mock("@/lib/epic-selectors", () => ({
  epicNodeRecency: () => ({}),
  useEpicArtifactRecords: (): ReadonlyArray<TestRecord> =>
    useSyncExternalStore(recordsStore.subscribe, recordsStore.get),
  useEpicChatRecordListAuthoritative: () => true,
  useEpicTuiAgentRecordListAuthoritative: () => true,
  useEpicLastFocusedArtifactId: () => null,
  useEpicSnapshotLoaded: () => snapshotLoadedState.loaded,
}));

function record(
  over: Partial<TestRecord> & { readonly id: string },
): TestRecord {
  return {
    parentId: null,
    name: over.id,
    type: "spec",
    hostId: HOST_ID,
    ...over,
  };
}

function activeArtifactId(tabId: string): string | null {
  return makeSelectActiveEpicArtifactId(tabId)(useEpicCanvasStore.getState());
}

/**
 * Every live tile on `tabId`'s canvas, across every pane.
 *
 * Read through the panes' own strips rather than off `tilesByInstanceId`, so
 * "open" means what the canvas shows: an entry still in the instance map but
 * in no pane is a closed tile, and counting it would let a stale instance
 * answer for a tile the person cannot see.
 */
function openTiles(tabId: string): ReadonlyArray<EpicCanvasTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) =>
    pane.tabInstanceIds.flatMap((instanceId) => {
      const tile = canvas.tilesByInstanceId[instanceId];
      return tile === undefined ? [] : [tile];
    }),
  );
}

/** The kind the tile for `artifactId` actually opened as. */
function openTileKind(
  tabId: string,
  artifactId: string,
): EpicCanvasTileRef["type"] | null {
  return openTiles(tabId).find((tile) => tile.id === artifactId)?.type ?? null;
}

/** Every artifact id with a live tile on `tabId`'s canvas, across every pane. */
function openArtifactIds(tabId: string): ReadonlyArray<string> {
  return openTiles(tabId).map((tile) => tile.id);
}

/** Closes the tile holding `artifactId`, wherever on the canvas it sits. */
function closeTileFor(tabId: string, artifactId: string): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error("expected a seeded canvas");
  for (const pane of collectPanes(canvas.root)) {
    for (const instanceId of pane.tabInstanceIds) {
      if (canvas.tilesByInstanceId[instanceId]?.id !== artifactId) continue;
      useEpicCanvasStore.getState().closeCanvasTab(tabId, pane.id, instanceId);
      return;
    }
  }
  throw new Error(`expected an open tile for ${artifactId}`);
}

function tileInstanceCount(tabId: string, artifactId: string): number {
  return openTiles(tabId).filter((tile) => tile.id === artifactId).length;
}

function baseIntent(over: Partial<EpicRouteFocusIntent>): EpicRouteFocusIntent {
  return {
    epicId: EPIC_ID,
    tabId: TAB_ID,
    focusedAt: 1,
    focusArtifactId: undefined,
    focusThreadId: undefined,
    focusPaneId: undefined,
    focusTileInstanceId: undefined,
    ...over,
  };
}

function mountHook(intent: EpicRouteFocusIntent) {
  return renderHook(
    (props: EpicRouteFocusIntent) => useEpicRouteSynchronization(props),
    { initialProps: intent },
  );
}

/**
 * A minimal router for the real `navigateNestedFocus` boundary.
 * `getHistoryController` is mocked independently of `history`'s value, so
 * the field itself is never read for its content.
 *
 * `matchesCurrentRoute` controls whether the boundary sees itself as acting
 * on the tab the route-sync hook is mounted for. True lets an ON-mode call
 * proceed to its own `router.navigate` (case 1/4's canvas assertions don't
 * depend on it either way). Case 5 passes false: it is testing the
 * route-sync hook's OWN canonicalizing replace, and letting the boundary
 * ALSO commit here would register a two-second optimistic pending target
 * (`beginNestedFocusNavigation`) for this exact tab that the test never
 * drives to completion, which would defer that replace for the duration of
 * the guard - a real round trip clears it once the router's commit lands
 * and the URL reflects the new target, which this lightweight rig does not
 * simulate. `markExplicitNestedFocusIntent` - the one thing every case here
 * is actually about - fires unconditionally before this check either way.
 */
function makeNestedFocusRouter(
  navigate: UseNavigateResult<string>,
  matchesCurrentRoute: boolean,
): NestedFocusNavigationRouter {
  return {
    history: {} as RouterHistory,
    navigate,
    getLocation: () => ({
      pathname: matchesCurrentRoute
        ? `/epics/${EPIC_ID}/${TAB_ID}`
        : "/elsewhere",
      search: {},
    }),
  };
}

/** A `navigate` stand-in for `makeNestedFocusRouter` - never asserted on
 * itself; cases that inspect a navigate call read the hook's own
 * `navigateMock` instead. */
function fakeNavigate(): UseNavigateResult<string> {
  return vi.fn() as UseNavigateResult<string>;
}

/**
 * The `prepare` shape of a genuine tile-open gesture: opens `artifactId`
 * into the tab through the real canvas store (not a direct
 * `markExplicitNestedFocusIntent` call) and returns its resulting focus
 * target, exactly what a real call site hands `navigateNestedFocus`.
 */
function prepareOpenArtifact(
  artifactId: string,
  instanceId: string,
): PrepareNestedFocusTarget {
  return () =>
    useEpicCanvasStore.getState().prepareOpenTileInTabFocusTarget(
      TAB_ID,
      makeOpenableNodeRef({
        id: artifactId,
        instanceId,
        type: "spec",
        name: artifactId,
        hostId: HOST_ID,
      }),
    );
}

/**
 * A `navigate` stand-in that APPLIES the search reducer the boundary emits to
 * `initialSearch`, as the router does, and keeps the result. The other cases
 * hand the boundary a bare mock and never look at what it would commit, which
 * is how a committed target that interacts badly with a waiting request went
 * unseen.
 */
function makeCommittingNavigate(initialSearch: Record<string, unknown>): {
  readonly navigate: UseNavigateResult<string>;
  readonly committed: { search: Record<string, unknown> | null };
} {
  const committed: { search: Record<string, unknown> | null } = {
    search: null,
  };
  const navigate = vi.fn();
  navigate.mockImplementation((options: NavigateCallOptions) => {
    committed.search = options.search?.(initialSearch) ?? null;
    return Promise.resolve();
  });
  return { navigate: navigate as UseNavigateResult<string>, committed };
}

/** The nested target a committed search names, or a failure if it names none. */
function committedNestedFocus(search: Record<string, unknown> | null): {
  readonly focusPaneId: string;
  readonly focusTileInstanceId: string;
} {
  const focusPaneId = search?.focusPaneId;
  const focusTileInstanceId = search?.focusTileInstanceId;
  if (
    typeof focusPaneId !== "string" ||
    typeof focusTileInstanceId !== "string"
  ) {
    throw new Error("expected the committed search to name a nested target");
  }
  return { focusPaneId, focusTileInstanceId };
}

describe("route focus opens the requested artifact (T156)", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useEpicCanvasStore
      .getState()
      .openEpicTabWithId(TAB_ID, EPIC_ID, "Route focus");
    recordsStore.set([]);
    navigateMock.mockClear();
    openEpicHandleState.setLastFocusedArtifactId.mockClear();
    openEpicHandleState.setLastFocusedThreadId.mockClear();
    persistentHistoryState.controller = null;
    snapshotLoadedState.loaded = true;
    resetNestedFocusNavigationIntentsForTests();
  });

  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it.each([
    ["html", "artifact-html"],
    ["canvas", "artifact-canvas"],
    ["file", "artifact-file"],
  ] as const)(
    "opens and activates a %s artifact whose record is already present",
    async (type, id) => {
      recordsStore.set([record({ id, type, name: "Target" })]);

      mountHook(baseIntent({ focusArtifactId: id, focusedAt: 100 }));

      await waitFor(() => {
        expect(openArtifactIds(TAB_ID)).toContain(id);
      });
      expect(activeArtifactId(TAB_ID)).toBe(id);
      // The KIND is the subject: the request was dropped because the resolver
      // refused these three, so a tile that opened under some other kind would
      // be a different defect wearing this one's green.
      expect(openTileKind(TAB_ID, id)).toBe(type);
    },
  );

  it("opens a markdown ticket once its record arrives AFTER mount", async () => {
    const TICKET_ID = "ticket-late";
    recordsStore.set([]);

    mountHook(baseIntent({ focusArtifactId: TICKET_ID, focusedAt: 200 }));

    expect(openArtifactIds(TAB_ID)).not.toContain(TICKET_ID);

    act(() => {
      recordsStore.set([
        record({ id: TICKET_ID, type: "ticket", name: "Late ticket" }),
      ]);
    });

    await waitFor(
      () => {
        expect(openArtifactIds(TAB_ID)).toContain(TICKET_ID);
      },
      { timeout: 1000 },
    );
    expect(activeArtifactId(TAB_ID)).toBe(TICKET_ID);
  });

  it("activates the requested artifact over one already focused, without closing it", async () => {
    const OTHER_ID = "artifact-other";
    const REQUESTED_ID = "artifact-requested";
    recordsStore.set([
      record({ id: OTHER_ID, type: "spec", name: "Other" }),
      record({ id: REQUESTED_ID, type: "spec", name: "Requested" }),
    ]);
    useEpicCanvasStore.getState().openTileInTab(
      TAB_ID,
      makeOpenableNodeRef({
        id: OTHER_ID,
        instanceId: "inst-other",
        type: "spec",
        name: "Other",
        hostId: HOST_ID,
      }),
    );
    expect(activeArtifactId(TAB_ID)).toBe(OTHER_ID);

    mountHook(baseIntent({ focusArtifactId: REQUESTED_ID, focusedAt: 300 }));

    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(REQUESTED_ID);
    });
    expect(openArtifactIds(TAB_ID)).toContain(OTHER_ID);
  });

  it("re-opens a closed artifact on a fresh focusedAt, and focuses rather than duplicates it while still open", async () => {
    const ARTIFACT_ID = "artifact-repeat";
    recordsStore.set([
      record({ id: ARTIFACT_ID, type: "spec", name: "Repeatable" }),
    ]);

    const hook = mountHook(
      baseIntent({ focusArtifactId: ARTIFACT_ID, focusedAt: 400 }),
    );

    await waitFor(() => {
      expect(openArtifactIds(TAB_ID)).toContain(ARTIFACT_ID);
    });
    expect(tileInstanceCount(TAB_ID, ARTIFACT_ID)).toBe(1);

    // Still open but NOT active: the person has moved to another tile since.
    // Activating something else first is what makes the re-request reach
    // dedupe at all - re-requesting the ALREADY-ACTIVE artifact returns on the
    // effect's `activeArtifactId === target.id` guard before any open is
    // resolved, so it would hold this assertion without exercising it.
    useEpicCanvasStore.getState().openTileInTab(
      TAB_ID,
      makeOpenableNodeRef({
        id: "artifact-bystander",
        instanceId: "inst-bystander",
        type: "spec",
        name: "Bystander",
        hostId: HOST_ID,
      }),
    );
    expect(activeArtifactId(TAB_ID)).toBe("artifact-bystander");

    hook.rerender(baseIntent({ focusArtifactId: ARTIFACT_ID, focusedAt: 401 }));
    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(ARTIFACT_ID);
    });
    expect(tileInstanceCount(TAB_ID, ARTIFACT_ID)).toBe(1);

    // Now close it, then click again with a fresh `focusedAt`. The pane holds
    // the bystander too, so the instance is found by artifact id rather than
    // by strip position.
    closeTileFor(TAB_ID, ARTIFACT_ID);
    expect(openArtifactIds(TAB_ID)).not.toContain(ARTIFACT_ID);

    hook.rerender(baseIntent({ focusArtifactId: ARTIFACT_ID, focusedAt: 402 }));

    await waitFor(() => {
      expect(openArtifactIds(TAB_ID)).toContain(ARTIFACT_ID);
    });
    expect(tileInstanceCount(TAB_ID, ARTIFACT_ID)).toBe(1);
  });

  it("never opens a tile for an id with no record, and never retries unboundedly", async () => {
    vi.useFakeTimers();
    try {
      mountHook(
        baseIntent({ focusArtifactId: "ghost-artifact", focusedAt: 500 }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(openArtifactIds(TAB_ID)).toEqual([]);
      expect(activeArtifactId(TAB_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a markdown ticket whose record is present (control: sound both before and after the fix)", async () => {
    const TICKET_ID = "ticket-present";
    recordsStore.set([
      record({ id: TICKET_ID, type: "ticket", name: "Present ticket" }),
    ]);

    mountHook(baseIntent({ focusArtifactId: TICKET_ID, focusedAt: 600 }));

    await waitFor(() => {
      expect(openArtifactIds(TAB_ID)).toContain(TICKET_ID);
    });
    expect(activeArtifactId(TAB_ID)).toBe(TICKET_ID);
  });

  it.each([
    ["nested history OFF", false],
    ["nested history ON", true],
  ] as const)(
    "a pending artifact request is superseded when the person opens something else first (%s)",
    async (_label, nestedHistoryOn) => {
      persistentHistoryState.controller = nestedHistoryOn
        ? ({} as PersistentHistoryController)
        : null;
      const PENDING_ID = "artifact-pending-case1";
      const CHOSEN_ID = "artifact-chosen-case1";
      // CHOSEN has a live record from the start: opening it is a real tile
      // open (its record sweep must not immediately evict it), and only
      // PENDING's record is what "arrives" during the test.
      recordsStore.set([
        record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
      ]);

      mountHook(baseIntent({ focusArtifactId: PENDING_ID, focusedAt: 800 }));

      act(() => {
        navigateNestedFocus(
          makeNestedFocusRouter(fakeNavigate(), true),
          { epicId: EPIC_ID, tabId: TAB_ID },
          prepareOpenArtifact(CHOSEN_ID, "inst-chosen-case1"),
          "user",
        );
      });
      expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);

      act(() => {
        recordsStore.set([
          record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
          record({ id: PENDING_ID, type: "spec", name: "Pending" }),
        ]);
      });

      await waitFor(() => {
        expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);
      });
      expect(openArtifactIds(TAB_ID)).not.toContain(PENDING_ID);
    },
  );

  it("opens a markdown ticket once its record arrives AFTER mount, with nested history ON", async () => {
    persistentHistoryState.controller = {} as PersistentHistoryController;
    const TICKET_ID = "ticket-late-nested-on";
    recordsStore.set([]);

    mountHook(baseIntent({ focusArtifactId: TICKET_ID, focusedAt: 201 }));

    expect(openArtifactIds(TAB_ID)).not.toContain(TICKET_ID);

    act(() => {
      recordsStore.set([
        record({ id: TICKET_ID, type: "ticket", name: "Late ticket" }),
      ]);
    });

    await waitFor(
      () => {
        expect(openArtifactIds(TAB_ID)).toContain(TICKET_ID);
      },
      { timeout: 1000 },
    );
    expect(activeArtifactId(TAB_ID)).toBe(TICKET_ID);
  });

  it("a pre-existing bystander tile does not retire a pending request whose record has not arrived", async () => {
    const BYSTANDER_ID = "artifact-bystander-case3";
    const PENDING_ID = "artifact-pending-case3";
    useEpicCanvasStore.getState().openTileInTab(
      TAB_ID,
      makeOpenableNodeRef({
        id: BYSTANDER_ID,
        instanceId: "inst-bystander-case3",
        type: "spec",
        name: "Bystander",
        hostId: HOST_ID,
      }),
    );
    expect(activeArtifactId(TAB_ID)).toBe(BYSTANDER_ID);
    recordsStore.set([]);

    mountHook(baseIntent({ focusArtifactId: PENDING_ID, focusedAt: 900 }));

    expect(openArtifactIds(TAB_ID)).not.toContain(PENDING_ID);

    act(() => {
      recordsStore.set([
        record({ id: PENDING_ID, type: "spec", name: "Pending" }),
      ]);
    });

    await waitFor(() => {
      expect(openArtifactIds(TAB_ID)).toContain(PENDING_ID);
    });
    expect(activeArtifactId(TAB_ID)).toBe(PENDING_ID);
  });

  it("a boundary action during cold load still supersedes a pending request once the snapshot loads", async () => {
    snapshotLoadedState.loaded = false;
    const PENDING_ID = "artifact-pending-case4";
    const CHOSEN_ID = "artifact-chosen-case4";
    recordsStore.set([]);

    mountHook(baseIntent({ focusArtifactId: PENDING_ID, focusedAt: 1000 }));

    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        prepareOpenArtifact(CHOSEN_ID, "inst-chosen-case4"),
        "user",
      );
    });

    act(() => {
      snapshotLoadedState.loaded = true;
      recordsStore.set([
        record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
        record({ id: PENDING_ID, type: "spec", name: "Pending" }),
      ]);
    });

    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);
    });
    expect(openArtifactIds(TAB_ID)).not.toContain(PENDING_ID);
  });

  it("canonicalizes the route to where the person actually is once a pending request is retired (nested history ON)", async () => {
    persistentHistoryState.controller = {} as PersistentHistoryController;
    const PENDING_ID = "artifact-pending-case5";
    const CHOSEN_ID = "artifact-chosen-case5";
    recordsStore.set([record({ id: CHOSEN_ID, type: "spec", name: "Chosen" })]);

    mountHook(baseIntent({ focusArtifactId: PENDING_ID, focusedAt: 1100 }));

    // Captured so the final assertion can name the EXACT pane/tile CHOSEN
    // landed on, rather than merely "some search patch arrived" - the old
    // auto-open effect (pre-fix) also drives a `replaceNestedFocusRoute`
    // call once PENDING's record lands, just naming PENDING's own tile after
    // stealing activation back from CHOSEN. A `toBeDefined()` check on
    // `focusPaneId` alone would pass on that wrong target too.
    // Held on an object rather than in a `let`, so the type stays what it is
    // declared as: TypeScript narrows a `let` assigned only inside a callback
    // back to `null` afterwards, and the cast that would paper over that is
    // exactly what hides a target the boundary never returned.
    const chosen: { target: NestedFocusTarget | null } = { target: null };
    act(() => {
      chosen.target = navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), false),
        { epicId: EPIC_ID, tabId: TAB_ID },
        prepareOpenArtifact(CHOSEN_ID, "inst-chosen-case5"),
        "user",
      );
    });
    expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);

    act(() => {
      recordsStore.set([
        record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
        record({ id: PENDING_ID, type: "spec", name: "Pending" }),
      ]);
    });

    // The retirement must hold, not just the route write: if PENDING had
    // reclaimed activation, a later-arriving navigate call could still name
    // PENDING's own (now-active) tile and slip past the target check below.
    expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const search = navigateMock.mock.calls.at(-1)?.[0].search?.({});
    // Both named before the comparisons, because those read through `?.`: with
    // no target captured and no search emitted they would compare `undefined`
    // to `undefined` and pass on a route that was never canonicalized.
    expect(chosen.target).not.toBeNull();
    expect(search).toBeDefined();
    expect(search?.focusPaneId).toBe(chosen.target?.paneId);
    expect(search?.focusTileInstanceId).toBe(chosen.target?.tileInstanceId);
  });

  it("closing the only open tile through the boundary supersedes a pending request, and a fresh click starts a new one", async () => {
    const ARTIFACT_ID = "artifact-case6-7";
    recordsStore.set([]);

    const hook = mountHook(
      baseIntent({ focusArtifactId: ARTIFACT_ID, focusedAt: 1200 }),
    );

    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        () => null,
        "user",
      );
    });

    act(() => {
      recordsStore.set([
        record({ id: ARTIFACT_ID, type: "spec", name: "Case 6/7" }),
      ]);
    });

    expect(openArtifactIds(TAB_ID)).not.toContain(ARTIFACT_ID);

    hook.rerender(
      baseIntent({ focusArtifactId: ARTIFACT_ID, focusedAt: 1201 }),
    );

    await waitFor(() => {
      expect(openArtifactIds(TAB_ID)).toContain(ARTIFACT_ID);
    });
    expect(activeArtifactId(TAB_ID)).toBe(ARTIFACT_ID);
  });

  // Both cases below mount under a ROOT StrictMode (`reactStrictMode` on
  // `renderHook`; a nested <StrictMode> wrapper does not replay). The sequence
  // is made nonzero BEFORE mount by a real boundary call, so the replayed
  // mount's stamp drop has something to reset. Nested history OFF.
  it("a root StrictMode mount replay does not retire a pending request nobody touched", async () => {
    const PENDING_ID = "artifact-strict-replay";
    recordsStore.set([]);
    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        () => null,
        "user",
      );
    });

    renderHook(
      (props: EpicRouteFocusIntent) => useEpicRouteSynchronization(props),
      {
        initialProps: baseIntent({
          focusArtifactId: PENDING_ID,
          focusedAt: 1300,
        }),
        reactStrictMode: true,
      },
    );

    act(() => {
      recordsStore.set([
        record({ id: PENDING_ID, type: "spec", name: "Pending" }),
      ]);
    });

    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(PENDING_ID);
    });
    expect(openArtifactIds(TAB_ID)).toContain(PENDING_ID);
  });

  it("after a StrictMode replay dropped the stamp, a genuine later gesture still retires the request", async () => {
    const PENDING_ID = "artifact-strict-pending";
    const CHOSEN_ID = "artifact-strict-chosen";
    recordsStore.set([record({ id: CHOSEN_ID, type: "spec", name: "Chosen" })]);
    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        () => null,
        "user",
      );
    });

    renderHook(
      (props: EpicRouteFocusIntent) => useEpicRouteSynchronization(props),
      {
        initialProps: baseIntent({
          focusArtifactId: PENDING_ID,
          focusedAt: 1400,
        }),
        reactStrictMode: true,
      },
    );

    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(fakeNavigate(), true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        prepareOpenArtifact(CHOSEN_ID, "inst-strict-chosen"),
        "user",
      );
    });
    expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);

    act(() => {
      recordsStore.set([
        record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
        record({ id: PENDING_ID, type: "spec", name: "Pending" }),
      ]);
    });

    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);
    });
    expect(openArtifactIds(TAB_ID)).not.toContain(PENDING_ID);
  });

  // The push cases drive the REAL `surfaceHostOpenedTab` through the REAL
  // boundary. Human-gesture retirement in this same rig, in both modes, is
  // already held by "superseded when the person opens something else first".
  it.each([
    ["agent", "nested history OFF", false],
    ["agent", "nested history ON", true],
    ["page", "nested history OFF", false],
    ["page", "nested history ON", true],
  ] as const)(
    "a host-opened browser tab (source %s, %s) does not retire a pending artifact request",
    async (source, _label, nestedHistoryOn) => {
      persistentHistoryState.controller = nestedHistoryOn
        ? ({} as PersistentHistoryController)
        : null;
      const priorSurfacing = useSettingsStore.getState().agentTabSurfacing;
      useSettingsStore.setState({ agentTabSurfacing: "surface" });
      setEpicSurfaceVisibility(EPIC_ID, TAB_ID, true);
      try {
        const PENDING_ID = "artifact-push-pending";
        recordsStore.set([]);

        mountHook(baseIntent({ focusArtifactId: PENDING_ID, focusedAt: 1500 }));

        act(() => {
          expect(
            surfaceHostOpenedTab({
              epicId: EPIC_ID,
              viewTabId: TAB_ID,
              hostId: HOST_ID,
              sessionId: "session-push",
              tabId: "tab-push",
              source,
              navigateNested: (epicId, tabId, prepare, provenance) =>
                navigateNestedFocus(
                  makeNestedFocusRouter(fakeNavigate(), true),
                  { epicId, tabId },
                  prepare,
                  provenance,
                ),
            }),
          ).toBe(true);
        });
        // The push itself must still work.
        expect(openTiles(TAB_ID).map((tile) => tile.type)).toContain(
          TILE_KIND_BROWSER_SESSION,
        );

        act(() => {
          recordsStore.set([
            record({ id: PENDING_ID, type: "spec", name: "Pending" }),
          ]);
        });

        await waitFor(() => {
          expect(activeArtifactId(TAB_ID)).toBe(PENDING_ID);
        });
        expect(openArtifactIds(TAB_ID)).toContain(PENDING_ID);
      } finally {
        // `beforeEach` resets the canvas store and the history controller but
        // not the settings store, so this override is restored here rather than
        // left for whichever test runs next.
        useSettingsStore.setState({ agentTabSurfacing: priorSurfacing });
        setEpicSurfaceVisibility(EPIC_ID, TAB_ID, false);
      }
    },
  );
  // The push cases above hand the boundary a bare navigate, so they never see
  // the search the push commits. Here the real reducer runs against the URL
  // the click landed on, and its output is fed back to the hook as the route.
  it("a pushed browser tab's committed nested target does not defeat a waiting artifact request (nested history ON)", async () => {
    persistentHistoryState.controller = {} as PersistentHistoryController;
    const priorSurfacing = useSettingsStore.getState().agentTabSurfacing;
    useSettingsStore.setState({ agentTabSurfacing: "surface" });
    setEpicSurfaceVisibility(EPIC_ID, TAB_ID, true);
    try {
      const REQUESTED_ID = "artifact-push-outranked";
      const FOCUSED_AT = 1600;
      recordsStore.set([]);

      const hook = mountHook(
        baseIntent({ focusArtifactId: REQUESTED_ID, focusedAt: FOCUSED_AT }),
      );

      const { navigate, committed } = makeCommittingNavigate({
        focusArtifactId: REQUESTED_ID,
        focusedAt: FOCUSED_AT,
      });
      act(() => {
        expect(
          surfaceHostOpenedTab({
            epicId: EPIC_ID,
            viewTabId: TAB_ID,
            hostId: HOST_ID,
            sessionId: "session-outranked",
            tabId: "tab-outranked",
            source: "agent",
            navigateNested: (epicId, tabId, prepare, provenance) =>
              navigateNestedFocus(
                makeNestedFocusRouter(navigate, true),
                { epicId, tabId },
                prepare,
                provenance,
              ),
          }),
        ).toBe(true);
      });
      expect(openTiles(TAB_ID).map((tile) => tile.type)).toContain(
        TILE_KIND_BROWSER_SESSION,
      );
      // The commit keeps the pending request in the URL; that is the premise.
      expect(committed.search?.focusArtifactId).toBe(REQUESTED_ID);
      expect(committed.search?.focusedAt).toBe(FOCUSED_AT);
      const nested = committedNestedFocus(committed.search);

      // The route now carries the committed browser target AND the request.
      hook.rerender(
        baseIntent({
          focusArtifactId: REQUESTED_ID,
          focusedAt: FOCUSED_AT,
          focusPaneId: nested.focusPaneId,
          focusTileInstanceId: nested.focusTileInstanceId,
        }),
      );

      act(() => {
        recordsStore.set([
          record({ id: REQUESTED_ID, type: "html", name: "Requested" }),
        ]);
      });

      await waitFor(() => {
        expect(openArtifactIds(TAB_ID)).toContain(REQUESTED_ID);
      });
      await waitFor(() => {
        expect(activeArtifactId(TAB_ID)).toBe(REQUESTED_ID);
      });
      expect(openArtifactIds(TAB_ID)).toContain(REQUESTED_ID);
    } finally {
      useSettingsStore.setState({ agentTabSurfacing: priorSurfacing });
      setEpicSurfaceVisibility(EPIC_ID, TAB_ID, false);
    }
  });

  it("a nested target the person commits through the boundary still outranks a waiting artifact request (nested history ON)", async () => {
    persistentHistoryState.controller = {} as PersistentHistoryController;
    const REQUESTED_ID = "artifact-human-outranks";
    const CHOSEN_ID = "artifact-human-chosen";
    const FOCUSED_AT = 1700;
    recordsStore.set([record({ id: CHOSEN_ID, type: "spec", name: "Chosen" })]);

    const hook = mountHook(
      baseIntent({ focusArtifactId: REQUESTED_ID, focusedAt: FOCUSED_AT }),
    );

    const { navigate, committed } = makeCommittingNavigate({
      focusArtifactId: REQUESTED_ID,
      focusedAt: FOCUSED_AT,
    });
    act(() => {
      navigateNestedFocus(
        makeNestedFocusRouter(navigate, true),
        { epicId: EPIC_ID, tabId: TAB_ID },
        prepareOpenArtifact(CHOSEN_ID, "inst-human-chosen"),
        "user",
      );
    });
    expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);
    expect(committed.search?.focusArtifactId).toBe(REQUESTED_ID);
    const nested = committedNestedFocus(committed.search);

    hook.rerender(
      baseIntent({
        focusArtifactId: REQUESTED_ID,
        focusedAt: FOCUSED_AT,
        focusPaneId: nested.focusPaneId,
        focusTileInstanceId: nested.focusTileInstanceId,
      }),
    );

    act(() => {
      recordsStore.set([
        record({ id: CHOSEN_ID, type: "spec", name: "Chosen" }),
        record({ id: REQUESTED_ID, type: "html", name: "Requested" }),
      ]);
    });

    await waitFor(() => {
      expect(activeArtifactId(TAB_ID)).toBe(CHOSEN_ID);
    });
    expect(openArtifactIds(TAB_ID)).not.toContain(REQUESTED_ID);
  });

  it("a request arriving to a route that already names a nested target does not outrank it (Back / cold load, nested history ON)", async () => {
    persistentHistoryState.controller = {} as PersistentHistoryController;
    const REQUESTED_ID = "artifact-stale-request";
    const BYSTANDER_ID = "artifact-route-target";
    recordsStore.set([
      record({ id: BYSTANDER_ID, type: "spec", name: "Route target" }),
    ]);
    // The tile the route's nested target names, already on the canvas.
    const target = useEpicCanvasStore
      .getState()
      .prepareOpenTileInTabFocusTarget(
        TAB_ID,
        makeOpenableNodeRef({
          id: BYSTANDER_ID,
          instanceId: "inst-route-target",
          type: "spec",
          name: "Route target",
          hostId: HOST_ID,
        }),
      );
    if (target === null) throw new Error("expected a focus target");
    expect(activeArtifactId(TAB_ID)).toBe(BYSTANDER_ID);

    mountHook(
      baseIntent({
        focusArtifactId: REQUESTED_ID,
        focusedAt: 1800,
        focusPaneId: target.paneId,
        focusTileInstanceId: target.tileInstanceId,
      }),
    );

    act(() => {
      recordsStore.set([
        record({ id: BYSTANDER_ID, type: "spec", name: "Route target" }),
        record({ id: REQUESTED_ID, type: "html", name: "Requested" }),
      ]);
    });

    // Negative: the request must stay unopened once the record has projected.
    await act(async () => {
      await Promise.resolve();
    });
    expect(activeArtifactId(TAB_ID)).toBe(BYSTANDER_ID);
    expect(openArtifactIds(TAB_ID)).not.toContain(REQUESTED_ID);
  });
  // Drives the REAL close hook, which serves a close button and a lifecycle
  // effect alike. A shell exiting by itself commits a close through the same
  // boundary a person's click does, and must not read as them turning away.
  describe.each([
    ["the last tile on the canvas", false],
    ["a tile with a sibling left behind", true],
  ] as const)(
    "closing %s while an artifact request waits",
    (_shape, sibling) => {
      const REQUESTED_ID = "artifact-close-waiting";
      const CLOSED_ID = "artifact-close-closed";
      const SIBLING_ID = "artifact-close-sibling";

      function setUpWaitingRequest() {
        persistentHistoryState.controller = {} as PersistentHistoryController;
        const present = [
          record({ id: CLOSED_ID, type: "spec", name: "Closed" }),
          ...(sibling
            ? [record({ id: SIBLING_ID, type: "spec", name: "Sibling" })]
            : []),
        ];
        recordsStore.set(present);
        if (sibling) {
          useEpicCanvasStore.getState().openTileInTab(
            TAB_ID,
            makeOpenableNodeRef({
              id: SIBLING_ID,
              instanceId: "inst-close-sibling",
              type: "spec",
              name: "Sibling",
              hostId: HOST_ID,
            }),
          );
        }
        useEpicCanvasStore.getState().openTileInTab(
          TAB_ID,
          makeOpenableNodeRef({
            id: CLOSED_ID,
            instanceId: "inst-close-closed",
            type: "spec",
            name: "Closed",
            hostId: HOST_ID,
          }),
        );
        const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
        if (canvas === undefined) throw new Error("expected the canvas");
        const pane = collectPanes(canvas.root).find((candidate) =>
          candidate.tabInstanceIds.includes("inst-close-closed"),
        );
        if (pane === undefined)
          throw new Error("expected the closed tile's pane");

        mountHook(
          baseIntent({ focusArtifactId: REQUESTED_ID, focusedAt: 1900 }),
        );
        return { present, paneId: pane.id };
      }

      it.each([
        ["automatic", "does not retire", false],
        ["user", "retires", true],
      ] as const)(
        "%s: a close %s a waiting request",
        async (origin, _label, retires) => {
          const { present, paneId } = setUpWaitingRequest();
          const close = renderHook(() =>
            useCloseCanvasTileWithNestedFocus(
              TAB_ID,
              paneId,
              "inst-close-closed",
            ),
          );

          act(() => {
            // Provenance is stated by the INVOCATION now, not baked into the
            // callback - which is the whole point of the contract: one closure
            // serves a Close button and an exit effect alike.
            close.result.current(origin);
          });
          expect(openArtifactIds(TAB_ID)).not.toContain(CLOSED_ID);
          const focusAfterClose = activeArtifactId(TAB_ID);
          expect(focusAfterClose).toBe(sibling ? SIBLING_ID : null);

          act(() => {
            recordsStore.set([
              ...present.filter((r) => r.id !== CLOSED_ID),
              record({ id: REQUESTED_ID, type: "html", name: "Requested" }),
            ]);
          });

          if (retires) {
            // The request is the person's to lose, so what their close left
            // focused stands and the artifact never opens.
            await act(async () => {
              await Promise.resolve();
            });
            expect(openArtifactIds(TAB_ID)).not.toContain(REQUESTED_ID);
            expect(activeArtifactId(TAB_ID)).toBe(focusAfterClose);
          } else {
            await waitFor(() => {
              expect(activeArtifactId(TAB_ID)).toBe(REQUESTED_ID);
            });
            expect(openArtifactIds(TAB_ID)).toContain(REQUESTED_ID);
          }
        },
      );
    },
  );
});
