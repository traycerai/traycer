/**
 * The sidebar row-churn fixes, driven on the LANE arm rather than the doc arm.
 *
 * ## Why this file exists beside the doc-arm pins
 *
 * `sidebar-panel-path-memo-churn.test.tsx` and
 * `sidebar-chat-row-node-churn.test.tsx` both drive the doc arm - a `Y.Doc` and
 * `epic.subscribe`. The capture these fixes were measured against runs the LANE
 * arm (`epic.state.subscribe` + `epic.status.subscribe`), and the two arms reach
 * the projection by different routes: the doc arm's incremental path rebuilds the
 * tree only when a `*_TREE_KEYS` member moves, while the lane arm runs a FULL
 * projection per update and re-mints every node's `updatedAt` from its record
 * unconditionally. A pin written against one door proves nothing about the other,
 * which is exactly how this epic spent two rounds of a perf gate.
 *
 * So this suite spends the plumbing to open the real lanes and hand the store a
 * real `epic.state.subscribe@1.0` snapshot, parsed by the wire's own schema. It
 * is deliberately ONE case: the arm is what is under test here, not the fixes'
 * every dimension, which the doc-arm suites already cover case by case.
 *
 * ## The stimulus, and why a snapshot rather than a delta
 *
 * The lead frame is a COMPLETE REPLACEMENT of the row set (see
 * `EpicStateStreamCallbacks.onSnapshot`), and the host re-sends it in band. That
 * makes a second snapshot the arm's own way of saying "these forty rows, twelve
 * of them stamped" - no structural-key gate anywhere in it, which is precisely
 * the property the doc-arm suites cannot exercise.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type {
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type {
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { ArtifactTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";

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
      // Counts, then delegates - every `ArtifactNode` calls this once per render.
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

const EPIC_ID = "epic-lane-arm-row-churn";
const TAB_ID = "tab-lane-arm";
const EPOCH = "epoch-1";
/** The field's shape: forty roots, twelve stamped per burst round. */
const ROW_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_unused, index) => `art-${index + 1}`,
);
const BUMPED_IDS: readonly string[] = ROW_IDS.slice(0, 12);

function statusSnapshot(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

/**
 * A real snapshot frame, parsed by the real schema, with `updatedAt` per id.
 *
 * Built as ONE frame rather than row by row so the wire's completeness rules
 * apply here rather than producing a half-populated head that happened to agree
 * on the fields a fixture bothered to set. Same construction as
 * `lane-legacy-projection-equivalence.test.ts`.
 */
function stateSnapshot(
  updatedAtById: ReadonlyMap<string, number>,
  generation: number,
): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    basis: "cold",
    position: generation,
    reconciledWithCloud: true,
    artifactRecords: ROW_IDS.map((id, index) => ({
      kind: "spec",
      id,
      folderName: id,
      title: `Artifact ${id}`,
      createdAt: 1,
      updatedAt: updatedAtById.get(id) ?? 1,
      createdManually: false,
      parentId: null,
      // Revisions must ADVANCE: the row store applies an upsert only when the
      // incoming revision beats the held one, so a replacement frame reusing
      // them would be dropped as stale and this suite would pin nothing.
      revision: generation * ROW_IDS.length + index + 1,
    })),
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: generation, claims: [] },
    epicMeta: {
      revision: generation,
      meta: { title: "Lane arm row churn", updatedAt: 1 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  /** Install the lanes: the status lead frame is what settles the arm. */
  open(): void;
  /** Replace the row set, with `updatedAt` per id. */
  publish(updatedAtById: ReadonlyMap<string, number>, generation: number): void;
}

function createLaneRig(): LaneRig {
  const captured: {
    status: EpicStatusStreamCallbacks | null;
    state: EpicStateStreamCallbacks | null;
  } = { status: null, state: null };

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    captured.status = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    captured.state = callbacks;
    return { close: () => undefined };
  };

  const laneSelection: EpicLaneSelectionSources = {
    // The relay shape: support never resolves, so the probe's own outcome
    // installs the lanes - the way a real remote connection reaches this arm,
    // rather than a manifest a test resolved by hand.
    support: () => "unknown",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: () => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    }),
  };

  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("the legacy doc stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });

  return {
    handle,
    open(): void {
      if (captured.status === null) throw new Error("no status lane opened");
      captured.status.onSnapshot(statusSnapshot());
    },
    publish(
      updatedAtById: ReadonlyMap<string, number>,
      generation: number,
    ): void {
      if (captured.state === null) throw new Error("no state lane opened");
      captured.state.onSnapshot(stateSnapshot(updatedAtById, generation));
    },
  };
}

describe("the sidebar rows, on the lane arm", () => {
  const opened: OpenedStoreForTest[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
    cleanup();
    rowRenders.clear();
  });

  it("holds every row still when twelve records are stamped", () => {
    const rig = createLaneRig();
    opened.push(rig.handle);
    rig.open();
    rig.publish(new Map(), 1);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <EpicSessionContext.Provider value={rig.handle}>
          <ArtifactTreePanelBody epicId={EPIC_ID} tabId={TAB_ID} />
        </EpicSessionContext.Provider>
      </QueryClientProvider>,
    );
    // Every row mounted, so a later "unchanged" reading is a row that held
    // still rather than one that was never there.
    expect(
      ROW_IDS.filter((id) => (rowRenders.get(id) ?? 0) > 0).length,
    ).toEqual(ROW_IDS.length);
    const before = new Map(rowRenders);
    const titlesBefore = ROW_IDS.map(
      (id) => rig.handle.store.getState().tree.nodeById[id].title,
    );

    act(() => {
      rig.publish(
        new Map(BUMPED_IDS.map((id, index) => [id, 500 + index] as const)),
        2,
      );
    });

    // Non-vacuity, and it is the whole point of paying for this arm: the stamps
    // reached the TREE with no structural key having moved - which is the thing
    // the doc arm's incremental path would NOT have done - and left the titles
    // alone.
    const nodesAfter = rig.handle.store.getState().tree.nodeById;
    expect(ROW_IDS.map((id) => nodesAfter[id].title)).toEqual(titlesBefore);
    expect(BUMPED_IDS.map((id) => nodesAfter[id].updatedAt)).toEqual(
      BUMPED_IDS.map((_unused, index) => 500 + index),
    );

    // THE PIN. An artifact row displays no timestamp, so a flat zero is the
    // honest assertion here - not the 28 bystanders, and not the 12 whose own
    // records moved.
    const rerendered = ROW_IDS.filter(
      (id) => (rowRenders.get(id) ?? 0) !== (before.get(id) ?? 0),
    );
    expect({ rowsThatRerendered: rerendered.length }).toEqual({
      rowsThatRerendered: 0,
    });
  });
});
