/**
 * A memoized sidebar row must not re-render through its PARENT when a different
 * row's record changes.
 *
 * ## Why this exists beside the subscription pin (epic-sync-overhaul finding 12)
 *
 * `sidebar-row-tree-subscription-churn.test.tsx` pins the row's own store
 * subscription and it is green - but the field still rendered all forty rows
 * after that fix landed. The reason is structural: that pin renders a bare probe
 * under `EpicSessionContext` with NO PANEL ABOVE IT, so there is no parent to
 * propagate and it cannot exercise the parent path even in principle. It pins
 * one of two stacked mechanisms. This pins the other.
 *
 * ## The mechanism
 *
 * `ArtifactNode` is `memo`'d and receives 12 props. Eleven are identity-stable.
 * The twelfth, `expansion`, re-mints on every record change through a chain that
 * is unconditional:
 *
 *     body write -> `tree` slice re-mints
 *   -> `usePanelRootIds` useMemo (dep `tree`) recomputes
 *        -> `yDocRootIds.filter(...)` ALWAYS allocates a new array
 *   -> `rootIds` useMemo (dep allRootIds)
 *   -> `useEpicSidebarEffectiveExpanded` useMemo (dep rootIds)
 *        -> `deriveEffectiveExpanded` ALWAYS allocates a new Set
 *   -> `toggleExpanded` useCallback (dep expandedIds)
 *   -> `expansion` useMemo (dep toggleExpanded)
 *   -> every memoized `ArtifactNode` compares unequal and re-renders
 *
 * `useRootIds()` itself is NOT the churn: `stabilizeTree` preserves `rootIds`
 * identity when the id set is unchanged (`epic-projector.ts:1449-1451`). The
 * allocation is `usePanelRootIds`'s own filter.
 *
 * A second, conditional entry into the same choke point is `useAncestorIds`,
 * which returns a fresh `Set` per bump whenever the active artifact has
 * ancestors.
 *
 * ## Why it regressed
 *
 * `usePanelRootIds` carries a comment describing this precise chain from an
 * earlier round - it moved off `useEpicArtifactRecords()` because "the tree
 * index (`s.tree`) does NOT change on chat tokens". True for chat tokens. Body
 * writes move `updatedAt`, `TreeNode` carries it, and the premise is false. The
 * guard rail is present and correctly written; it is keyed on something that now
 * moves. Same class as the row-level half, one level up the same tree.
 *
 * ## The instrument
 *
 * Rows are rendered by the panel, so they cannot be wrapped in a `Profiler` from
 * out here. Instead the real `useFilteredPanelChildIds` - which every
 * `ArtifactNode` calls once per render, unconditionally, before any early
 * return - is wrapped in a counting delegate. The wrapper calls through to the
 * real implementation, so hook order and behaviour are unchanged and the count
 * is exactly "renders of the row with this id".
 *
 * The harness renders the REAL `ArtifactTreePanelBody` against a REAL store. The
 * only wrapper is a `QueryClientProvider`, which the row's mutation hooks
 * require. Nothing is mocked: the sibling suites that mock `use-epic-store` with
 * a fake state object cannot serve here at all, because a fake state never
 * re-mints the tree slice and the re-mint IS the stimulus.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useAncestorIds } from "@/lib/epic-selectors";
import { ArtifactTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const rowRenders = vi.hoisted(() => new Map<string, number>());

vi.mock(
  "@/components/epic-canvas/sidebar/epic-sidebar-filter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/sidebar/epic-sidebar-filter")
      >();
    return {
      ...actual,
      // Counts, then delegates. Every `ArtifactNode` calls this once per render
      // before any early return, so the tally is that row's render count.
      useFilteredPanelChildIds: (
        parentId: string,
        treeFilter: (type: string | null | undefined) => boolean,
      ): readonly string[] => {
        rowRenders.set(parentId, (rowRenders.get(parentId) ?? 0) + 1);
        return actual.useFilteredPanelChildIds(parentId, treeFilter);
      },
    };
  },
);

const EPIC_ID = "epic-panel-path-memo-churn";
const TAB_ID = "tab-panel-path";
const ROW_IDS = ["art-1", "art-2", "art-3", "art-4"] as const;
/** The one whose record moves. Every assertion is about the others. */
const BUMPED_ID = ROW_IDS[0];

/**
 * The FIELD's shape: forty roots, twelve of them bursted per round.
 *
 * The count matters, not just the ratio. The projector orders roots by recency
 * (`makeNodeComparator(DEFAULT_SORT_MODE)`), so how many nodes get stamped
 * decides whether the root ORDER moves - and the order moving is what drives
 * the defect this file's last case pins. Twelve of forty reorders; one of four,
 * all tied, does not.
 */
const FIELD_ROW_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_unused, index) => `art-${index + 1}`,
);
const FIELD_BUMPED_IDS: readonly string[] = FIELD_ROW_IDS.slice(0, 12);

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Panel path memo churn",
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

function artifactEntry(id: string): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("kind", "spec");
  entry.set("title", `Artifact ${id}`);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  return entry;
}

function seedDoc(ids: readonly string[]): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const artifacts = new Y.Map<unknown>();
  epic.set("artifacts", artifacts);
  for (const id of ids) artifacts.set(id, artifactEntry(id));
  return Y.encodeStateAsUpdate(donor);
}

function createSession(ids: readonly string[]): OpenedStoreForTest {
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
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc(ids));
  return handle;
}

function artifactsMap(handle: OpenedStoreForTest): Y.Map<unknown> {
  const epic = handle.doc.getMap<unknown>("epic");
  const artifacts = epic.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    throw new Error("the seeded doc has no artifacts map");
  }
  return artifacts;
}

describe("a memoized sidebar row, through the panel", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
    rowRenders.clear();
  });

  function sessionForHook(): OpenedStoreForTest {
    const handle = createSession(ROW_IDS);
    opened.push(handle);
    return handle;
  }

  function renderPanel(): OpenedStoreForTest {
    const handle = createSession(ROW_IDS);
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    // Every row mounted, so a later "unchanged" reading is a row that held
    // still rather than a row that was never there.
    for (const id of ROW_IDS) {
      expect(rowRenders.get(id) ?? 0).toBeGreaterThan(0);
    }
    return handle;
  }

  // NOTE: this case does NOT cover the field, and must not be read as doing so.
  // It bumps ONE record in a list whose `updatedAt`s are all tied, so the
  // recency order does not move and the reorder chain the last case pins never
  // fires. It pins a real and distinct property - a row must not re-render for
  // a sibling's change when nothing about the list moved - and it stays for
  // that. The field's stimulus is the last case in this file.
  it("does not re-render when a DIFFERENT row's record changes", async () => {
    const handle = renderPanel();
    const before = new Map(rowRenders);

    // Four record changes, as a body-write burst produces. One would leave the
    // result ambiguous between "held still" and "coalesced".
    await act(async () => {
      const { renameArtifact } = handle.store.getState();
      await renameArtifact(BUMPED_ID, "Stamped once");
      await renameArtifact(BUMPED_ID, "Stamped twice");
      await renameArtifact(BUMPED_ID, "Stamped thrice");
      await renameArtifact(BUMPED_ID, "Stamped again");
    });

    // THE PIN. These rows are memoized, none of their props changed, and none
    // of them reads the bumped row. Any render here arrived through the parent.
    for (const id of ROW_IDS.filter((candidate) => candidate !== BUMPED_ID)) {
      expect({ id, renders: rowRenders.get(id) ?? 0 }).toEqual({
        id,
        renders: before.get(id) ?? 0,
      });
    }
  });

  it("keeps ancestor-set identity across a bump that leaves the chain alone", async () => {
    // The SECOND entry into the same choke point, pinned at its own invariant.
    //
    // The two cases above never exercise it: they have no active artifact, so
    // `useAncestorIds` returns the shared empty constant and cannot churn. It
    // only churns when something IS active, and making that true through the
    // panel would mean seeding the canvas store's tile layout - coupling this
    // pin to machinery the defect has nothing to do with. So this asserts the
    // invariant directly: same ancestor chain in, same Set out.
    //
    // That is the whole of what stabilizes `forcedExpandedIds`, which is the
    // only thing this chain contributes to `expandedIds`.
    const handle = sessionForHook();
    act(() => {
      handle.doc.transact(() => {
        const child = artifactEntry("art-2-child");
        child.set("parentId", ROW_IDS[1]);
        artifactsMap(handle).set("art-2-child", child);
      });
    });

    const { result } = renderHook(() => useAncestorIds("art-2-child"), {
      wrapper: ({ children }) => (
        <EpicSessionContext.Provider value={handle}>
          {children}
        </EpicSessionContext.Provider>
      ),
    });
    const before = result.current;
    // Non-vacuity: an empty set is the shared constant and would be stable for
    // free, proving nothing. This one has a real member.
    expect([...before]).toEqual([ROW_IDS[1]]);

    await act(async () => {
      await handle.store.getState().renameArtifact(BUMPED_ID, "Stamped");
    });

    // THE PIN. A different root's record moved; `art-2-child`'s ancestry did
    // not, so the very same Set must come back.
    expect(result.current).toBe(before);
  });

  it("holds untouched rows still when a burst REORDERS the roots", async () => {
    // THE FIELD'S STIMULUS, and the one the other cases structurally cannot
    // produce. The capture bursts body text into 12 of 40 artifacts per round;
    // each write stamps `updatedAt`, and the projector orders roots by recency,
    // so the root ORDER genuinely changes.
    //
    // That reorder is a real change and `usePanelRootIds` is right to report it
    // (zustand's shallow compares arrays positionally). What must not follow is
    // a new `expandedIds`: `deriveEffectiveExpanded` only ever ADDS the root ids
    // to a Set, where order is meaningless, so a pure reorder produces a
    // member-identical Set. Rebuilding it re-mints `toggleExpanded` ->
    // `expansion` and defeats memo on every row.
    //
    // The rows that were bursted do re-render, legitimately - their own
    // `updatedAt` moved and `useEpicTreeNode` hands them the whole node. This
    // case is only about the 28 that were not touched at all.
    const handle = createSession(FIELD_ROW_IDS);
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    const before = new Map(rowRenders);
    expect(before.size).toBe(FIELD_ROW_IDS.length);
    const rootsBefore = handle.store.getState().tree.rootIds;

    await act(async () => {
      const { renameArtifact } = handle.store.getState();
      for (const id of FIELD_BUMPED_IDS)
        await renameArtifact(id, `burst ${id}`);
    });

    // Non-vacuity, and the whole premise: the burst must actually have
    // reordered the roots while leaving the membership alone. If this stops
    // holding, the case below is asserting something else.
    const rootsAfter = handle.store.getState().tree.rootIds;
    expect([...rootsAfter].sort()).toEqual([...rootsBefore].sort());
    expect(rootsAfter.join()).not.toBe(rootsBefore.join());

    // THE PIN.
    const rerendered = FIELD_ROW_IDS.filter(
      (id) =>
        !FIELD_BUMPED_IDS.includes(id) &&
        (rowRenders.get(id) ?? 0) !== (before.get(id) ?? 0),
    );
    expect({ untouchedThatRerendered: rerendered.length }).toEqual({
      untouchedThatRerendered: 0,
    });
  });

  it("holds even the BURSTED rows still when only `updatedAt` moves", () => {
    // The field's write is a BODY append: it stamps `updatedAt` and changes
    // nothing the row displays. `renameArtifact` cannot express that - the row
    // renders the title, so a rename must re-render it - so this drives the
    // stimulus directly, replacing each entry with an identical one whose
    // `updatedAt` has moved. A top-level `set` on the artifacts map is what
    // reaches the projection in this harness.
    //
    // The row's render inputs are `type` and `title`, both unchanged here, and
    // the unread marker answers with a VARIANT rather than a timestamp - so a
    // stamp that does not flip the variant is invisible to the row. Before this
    // fix the row read the whole `TreeNode`, which carries `updatedAt`, and so
    // re-rendered on every stamp along with its unmemoized chrome subtree.
    const handle = createSession(FIELD_ROW_IDS);
    opened.push(handle);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={handle}>
          <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    const before = new Map(rowRenders);
    expect(before.size).toBe(FIELD_ROW_IDS.length);
    const titlesBefore = FIELD_BUMPED_IDS.map(
      (id) => handle.store.getState().tree.nodeById[id].title,
    );

    act(() => {
      handle.doc.transact(() => {
        const artifacts = artifactsMap(handle);
        FIELD_BUMPED_IDS.forEach((id, index) => {
          const entry = artifactEntry(id);
          entry.set("updatedAt", 100 + index);
          artifacts.set(id, entry);
        });
      });
    });

    // Non-vacuity: the stamps really landed in the projection, and really left
    // the titles alone. Without this the case could pass by doing nothing.
    const nodesAfter = handle.store.getState().tree.nodeById;
    expect(FIELD_BUMPED_IDS.map((id) => nodesAfter[id].title)).toEqual(
      titlesBefore,
    );
    expect(FIELD_BUMPED_IDS.map((id) => nodesAfter[id].updatedAt)).toEqual(
      FIELD_BUMPED_IDS.map((_unused, index) => 100 + index),
    );

    // THE PIN: no row re-renders at all - not the 28 bystanders, and not the
    // 12 whose own timestamps moved.
    const rerendered = FIELD_ROW_IDS.filter(
      (id) => (rowRenders.get(id) ?? 0) !== (before.get(id) ?? 0),
    );
    expect({ rowsThatRerendered: rerendered.length }).toEqual({
      rowsThatRerendered: 0,
    });
  });

  it("still re-renders the row whose OWN record changed", async () => {
    // The counterpart. A fix that froze the panel's props wholesale would pass
    // the case above and leave the renamed row showing its old title.
    const handle = renderPanel();
    const before = rowRenders.get(BUMPED_ID) ?? 0;

    await act(async () => {
      await handle.store.getState().renameArtifact(BUMPED_ID, "Renamed");
    });

    expect(rowRenders.get(BUMPED_ID) ?? 0).toBeGreaterThan(before);
  });
});
