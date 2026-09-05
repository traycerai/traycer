/**
 * A sidebar row must not re-render because a DIFFERENT row's `updatedAt` moved.
 *
 * ## The defect this pins (epic-sync-overhaul finding 12)
 *
 * The host stamps an artifact record's `updatedAt` on every body write batch -
 * roughly 4/s under typing-shaped load. `TreeNode` carries `updatedAt`
 * (`types.ts:285-293`), so the stamped node legitimately changes, `nodeById`
 * legitimately re-mints, and the whole `tree` slice gets a new identity. That
 * much is correct and is NOT what this pins: `replaceEqualDeep` is right to
 * refuse to reuse a slice whose content moved.
 *
 * What it pins is who reacts. Every row subscribed to the WHOLE slice -
 * `useEpicTreeIndex()`, i.e. `useEpicStore((s) => s.tree)` - directly in
 * `ArtifactNode` and transitively through `useFilteredPanelChildIds`, which
 * `ChatNode` uses too. Zustand re-renders every subscriber whose selector
 * output changed identity, so one stamp re-rendered all forty rows and their
 * whole subtrees (row button, status dot, per-row menus).
 *
 * `memo` cannot help here and never could. It only blocks a re-render
 * propagated from a PARENT with equal props; a store subscription inside the
 * component is an independent trigger. So this is not a memo defeated by a
 * churning prop - it is a memo bypassed entirely.
 *
 * ## Why it regressed exactly here
 *
 * The per-node subscriptions beside it (`useIsActiveEpicArtifact`,
 * `useEpicArtifactStatus`) were added to fix this same shape for CHAT TOKEN
 * churn, and the comment above the read states the premise out loud: "The tree
 * index is stable while streaming." That was true for chat tokens, which never
 * touch an artifact tree node. Body writes falsified it silently, because they
 * move `updatedAt` and the node carries it. The optimization outlived the
 * premise that made it correct.
 *
 * ## The probe, and why it is a leaf
 *
 * Each probe calls the real `useFilteredPanelChildIds` - the production hook,
 * not a restatement of it - for a LEAF artifact. A leaf has no children, so the
 * hook returns the shared empty array and provably needs nothing from the
 * bumped node. A row that demonstrably wants none of the changed data is the
 * starkest form of the defect: if it re-renders, nothing about the data
 * explains it, only the subscription does.
 *
 * The default sort is deliberate. Under a RECENCY comparator an `updatedAt`
 * bump can genuinely reorder siblings, and rows whose order moved must
 * re-render - that is correct O(k) behaviour this must not suppress. Asserting
 * O(1) under a recency sort would be asserting something false.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  SidebarSortContext,
  useFilteredPanelChildIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-filter";
import {
  makeNodeComparator,
  SORT_DIRECTION,
  SORT_FIELD,
} from "@/lib/epic-sort";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-row-subscription-churn";
const ROW_IDS = ["art-1", "art-2", "art-3", "art-4"] as const;
/** The one the host stamps. Every assertion below is about the others. */
const BUMPED_ID = ROW_IDS[0];

const ARTIFACT_FILTER = (type: string | null | undefined): boolean =>
  type === "spec" || type === "ticket" || type === "story" || type === "review";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Row subscription churn",
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

function artifactEntry(
  id: string,
  parentId: string | null,
  updatedAt: number,
): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("kind", "spec");
  entry.set("title", `Artifact ${id}`);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", updatedAt);
  return entry;
}

function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const artifacts = new Y.Map<unknown>();
  epic.set("artifacts", artifacts);
  for (const id of ROW_IDS) artifacts.set(id, artifactEntry(id, null, 1));
  return Y.encodeStateAsUpdate(donor);
}

function artifactsMap(handle: OpenedStoreForTest): Y.Map<unknown> {
  const epic = handle.doc.getMap<unknown>("epic");
  const artifacts = epic.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    throw new Error("the seeded doc has no artifacts map");
  }
  return artifacts;
}

/**
 * One artifact's record changes, and nothing else does.
 *
 * `renameArtifact` is the store's own write and moves exactly one record - its
 * title and its `updatedAt`. No probe below reads either field, so a re-render
 * here cannot be explained by the data a row displays; only by what it
 * subscribed to. A nested `updatedAt` poke straight into `handle.doc` would be
 * closer to the host's stamp in shape, but it does not reach the projection in
 * this harness at all, and a stimulus that changes nothing pins nothing.
 */
async function renameOne(
  handle: OpenedStoreForTest,
  id: string,
  title: string,
) {
  await handle.store.getState().renameArtifact(id, title);
}

function createSession(): OpenedStoreForTest {
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
  captured.value.onSnapshot(makeMeta(), seedDoc());
  return handle;
}

interface RenderCounts {
  readonly callback: ProfilerOnRenderCallback;
  readonly counts: Map<string, number>;
}

function makeCounts(): RenderCounts {
  const counts = new Map<string, number>();
  return {
    counts,
    callback: (id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    },
  };
}

/**
 * One sidebar row's tree subscription, and nothing else.
 *
 * Renders its answer in order, so a case can assert WHICH ids the row resolved
 * and not merely how many - what separates a re-render caused by a real
 * reordering from one caused by residual slice churn.
 */
function RowProbe({ nodeId }: { nodeId: string }) {
  const childIds = useFilteredPanelChildIds(nodeId, ARTIFACT_FILTER);
  return <span data-testid={`row-${nodeId}`}>{childIds.join(",")}</span>;
}

describe("a sidebar row's tree subscription", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
  });

  function sessionUnderTest(): OpenedStoreForTest {
    const handle = createSession();
    opened.push(handle);
    return handle;
  }

  function renderRows(handle: OpenedStoreForTest): RenderCounts {
    const counts = makeCounts();
    render(
      <EpicSessionContext.Provider value={handle}>
        {ROW_IDS.map((id) => (
          <Profiler key={id} id={id} onRender={counts.callback}>
            <RowProbe nodeId={id} />
          </Profiler>
        ))}
      </EpicSessionContext.Provider>,
    );
    // Every row mounted, so a zero below is a row that never rendered rather
    // than a row that correctly held still.
    for (const id of ROW_IDS) {
      expect(counts.counts.get(id) ?? 0).toBeGreaterThan(0);
    }
    return counts;
  }

  it("does not re-render when a DIFFERENT row's record changes", async () => {
    const handle = sessionUnderTest();
    const counts = renderRows(handle);
    const before = new Map(counts.counts);

    // Four stamps, as a body-write burst produces. One would leave the result
    // ambiguous between "held still" and "coalesced".
    await act(async () => {
      await renameOne(handle, BUMPED_ID, "Stamped once");
      await renameOne(handle, BUMPED_ID, "Stamped twice");
      await renameOne(handle, BUMPED_ID, "Stamped thrice");
      await renameOne(handle, BUMPED_ID, "Stamped again");
    });

    // THE PIN. These rows are leaves: their `useFilteredPanelChildIds` answer
    // is the shared empty array before and after, and none of them reads the
    // stamped row at all. Any re-render here is the subscription, not the data.
    for (const id of ROW_IDS.filter((candidate) => candidate !== BUMPED_ID)) {
      expect({ id, renders: counts.counts.get(id) ?? 0 }).toEqual({
        id,
        renders: before.get(id) ?? 0,
      });
    }
  });

  it("still re-renders the row whose own children changed", () => {
    // The counterpart, and the reason this is a scoping fix rather than a
    // stop-reacting one: a fix that simply severed the subscription would pass
    // the case above and leave every row frozen. This is the same guard the
    // suite next door applies to its `rootIds` subscriber.
    const handle = sessionUnderTest();
    const counts = renderRows(handle);
    const before = counts.counts.get(ROW_IDS[1]) ?? 0;

    act(() => {
      handle.doc.transact(() => {
        artifactsMap(handle).set(
          "art-2-child",
          artifactEntry("art-2-child", ROW_IDS[1], 1),
        );
      });
    });

    expect(counts.counts.get(ROW_IDS[1]) ?? 0).toBeGreaterThan(before);
  });

  it("DOES re-render under a recency sort when a stamp reorders siblings", () => {
    // The other half of the contract, and the reason the first case pins under
    // the default order. `useFilteredPanelChildIds` re-sorts whenever the panel
    // carries a non-default comparator, and a recency comparator reads the very
    // field the host stamps - so under one, an `updatedAt` bump genuinely
    // changes a parent row's answer and that row MUST re-render.
    //
    // A fix that suppressed this would be over-suppressing: the row would keep
    // rendering its children in a stale order. So this is the guard that keeps
    // the first case honest about what it is asking for - subscribe to your own
    // answer, not stop reacting.
    const handle = sessionUnderTest();
    const parent = ROW_IDS[1];
    // Two children, because `sortNodeIds` passes a shorter list straight
    // through and would make any ordering claim below vacuous.
    act(() => {
      handle.doc.transact(() => {
        artifactsMap(handle).set("kid-a", artifactEntry("kid-a", parent, 1));
        artifactsMap(handle).set("kid-b", artifactEntry("kid-b", parent, 2));
      });
    });

    const counts = makeCounts();
    const view = render(
      <EpicSessionContext.Provider value={handle}>
        <SidebarSortContext.Provider
          value={makeNodeComparator({
            field: SORT_FIELD.Updated,
            direction: SORT_DIRECTION.Asc,
          })}
        >
          <Profiler id={parent} onRender={counts.callback}>
            <RowProbe nodeId={parent} />
          </Profiler>
        </SidebarSortContext.Provider>
      </EpicSessionContext.Provider>,
    );
    const row = view.getByTestId(`row-${parent}`);
    // OLDEST first, and deliberately so. The projector already orders children
    // with `makeNodeComparator(DEFAULT_SORT_MODE)` - recency, most recent on
    // top (`projection-helpers.ts:1298`) - so a DESCENDING comparator here
    // would reproduce the order the row receives and this case would pass
    // whether or not `sortNodeIds` ever ran. Ascending is the strict reverse of
    // the projector's own order, so every assertion below fails if the
    // comparator stops being applied.
    expect(row.textContent).toBe("kid-a,kid-b");
    const before = counts.counts.get(parent) ?? 0;
    expect(before).toBeGreaterThan(0);

    // Re-set the whole entry rather than poking `updatedAt` on the nested map:
    // a top-level set is what reaches the projection in this harness, and it is
    // the same stimulus the case above uses.
    act(() => {
      handle.doc.transact(() => {
        artifactsMap(handle).set("kid-a", artifactEntry("kid-a", parent, 9));
      });
    });

    // Both halves, so a pass cannot come from churn that happened to re-render
    // the row while leaving its order stale. `kid-a` is now the most recent, so
    // ascending puts it last - the reverse of what the projector hands over.
    expect(row.textContent).toBe("kid-b,kid-a");
    expect(counts.counts.get(parent) ?? 0).toBeGreaterThan(before);
  });
});
