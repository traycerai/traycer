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
  // It bumps ONE record in a list whose `updatedAt`s are all tied, so the recency order does not move and the reorder chain the last case pins never fires.
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
    // The two cases above never exercise it: they have no active artifact, so `useAncestorIds` returns the shared empty constant and cannot churn.
    // It only churns when something IS active, and making that true through the panel would mean seeding the canvas store's tile layout - coupling this pin to machinery the defect has nothing to do with.
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
    // THE FIELD'S STIMULUS, and the one the other cases structurally cannot produce.
    // What must not follow is a new `expandedIds`: `deriveEffectiveExpanded` only ever ADDS the root ids to a Set, where order is meaningless, so a pure reorder produces a member-identical Set.
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

    // Non-vacuity, and the whole premise: the burst must actually have reordered the roots while leaving the membership alone.
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
    // `renameArtifact` cannot express that - the row renders the title, so a rename must re-render it - so this drives the stimulus directly, replacing each entry with an identical one whose `updatedAt` has moved.
    // The row's render inputs are `type` and `title`, both unchanged here, and the unread marker answers with a VARIANT rather than a timestamp - so a stamp that does not flip the variant is invisible to the row.
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
