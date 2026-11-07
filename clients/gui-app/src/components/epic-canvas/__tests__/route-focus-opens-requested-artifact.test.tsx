import { useSyncExternalStore } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
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

const navigateMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve() as Promise<unknown>),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({
    history: {},
    state: { location: { pathname: `/epics/${EPIC_ID}/${TAB_ID}` } },
  }),
}));

// No nested-focus route state in this suite - it is orthogonal to the
// defect under test (D1/D2 live entirely in the legacy auto-open effect),
// and keeping it off collapses the hook down to that one effect's branch.
vi.mock("@/lib/persistent-history", () => ({
  getHistoryController: () => null,
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
  useEpicSnapshotLoaded: () => true,
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
});
