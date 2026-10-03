/**
 * `projector.projectChanges()` over a record-plane epic (lane sources, real
 * chat record table, real transactional sink). A stable-membership record
 * change rebuilds only the changed tree rows and the branches they sort in;
 * anything that can move membership or parentage falls back to the full
 * composition. `composeEpicProjection` is the oracle for every case, and
 * `collectRawTreeRecords` inputs are the work count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import { createTransactionalProjectionSink } from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactsSlice,
  ChatsSlice,
  EpicProjectedSlices,
  TerminalAgentsSlice,
} from "../types";
import { EMPTY_PROJECTED_SLICES, EMPTY_TERMINAL_AGENTS_SLICE } from "../types";
import { EMPTY_PENDING_OVERLAY } from "../pending-metadata-overlay";
import { changedTableIds } from "../runtime/projection-table-changes";

const collected = vi.hoisted(() => ({ rows: 0 }));

vi.mock("../projection-helpers", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../projection-helpers")>();
  return {
    ...original,
    collectRawTreeRecords: (
      artifacts: ArtifactsSlice,
      chats: ChatsSlice,
      tuiAgents: TerminalAgentsSlice,
    ) => {
      collected.rows +=
        artifacts.allIds.length + chats.allIds.length + tuiAgents.allIds.length;
      return original.collectRawTreeRecords(artifacts, chats, tuiAgents);
    },
  };
});

// Imported after the mock so the incremental helper binds the counting wrapper.
const { composeEpicProjection, RECORD_PLANE_COVERS_BOTH } =
  await import("../projection-helpers");
const { createChatRecordTable } = await import("../runtime/chat-record-table");
const { createEpicProjector } = await import("../runtime/epic-projector");

const EPIC_ID = "epic-projector-changed";
const OWNER = "user-a";
const CHILDREN = 50;
const CHANGED_COUNTS = [1, 10, 50] as const;

function record(
  chatId: string,
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId,
    ownerUserId: OWNER,
    originHostId: "host-1",
    title: `Title ${chatId}`,
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    ...overrides,
  };
}

/** Two parents, 25 children each; a higher index is more recently updated. */
function seedRecords(): ChatRecordSummaryV11[] {
  const children = Array.from({ length: CHILDREN }, (_, i) =>
    record(`c${i}`, {
      parentChatId: i < CHILDREN / 2 ? "p1" : "p2",
      updatedAt: 100 + i,
    }),
  );
  return [
    record("p1", { updatedAt: 500 }),
    record("p2", { updatedAt: 499 }),
    ...children,
  ];
}

function setup() {
  const table = createChatRecordTable({
    getCurrentUserId: () => OWNER,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
  table.applyRecords(seedRecords(), null);
  const sink = createTransactionalProjectionSink<EpicProjectedSlices>(
    EMPTY_PROJECTED_SLICES,
    () => undefined,
  );
  const raw = {
    artifacts: EMPTY_PROJECTED_SLICES.artifacts,
    deletedArtifacts: EMPTY_PROJECTED_SLICES.deletedArtifacts,
    docChats: EMPTY_PROJECTED_SLICES.docChats,
    docTuiAgents: EMPTY_PROJECTED_SLICES.docTuiAgents,
    epicHeader: EMPTY_PROJECTED_SLICES.epic,
    roleClaims: [],
  };
  const inputs = () => ({
    chatRecords: table.current(),
    tuiAgentRecords: EMPTY_TERMINAL_AGENTS_SLICE,
    pendingOverlay: EMPTY_PENDING_OVERLAY,
    reportDeadMutations: () => undefined,
    docArm: RECORD_PLANE_COVERS_BOTH,
  });
  const projector = createEpicProjector({
    getCurrentUserId: () => OWNER,
    getChatRecords: () => table.current(),
    getTuiAgentRecords: () => EMPTY_TERMINAL_AGENTS_SLICE,
    getDocArm: () => RECORD_PLANE_COVERS_BOTH,
    getPendingOverlay: () => EMPTY_PENDING_OVERLAY,
    onDeadMutations: () => undefined,
  });
  projector.attachLaneSources(() => raw, sink);
  const oracle = () => composeEpicProjection(raw, OWNER, inputs());
  return { table, sink, projector, oracle };
}

function upsert(chatId: string, overrides: Partial<ChatRecordSummaryV11>) {
  const base = seedRecords().find((r) => r.chatId === chatId);
  return {
    kind: "upsert" as const,
    epicId: EPIC_ID,
    record: record(chatId, {
      ...(base === undefined ? {} : base),
      ...overrides,
    }),
  };
}

beforeEach(() => {
  collected.rows = 0;
});

describe("projector.projectChanges - record-plane changes rebuild only what changed", () => {
  it("starts from a projection that equals the oracle", () => {
    const { sink, oracle } = setup();
    expect(sink.read()).toEqual(oracle());
  });

  it.each(CHANGED_COUNTS)(
    "a title edit on %i chats touches %i tree rows, no branch, and equals the full projection",
    (count) => {
      const { table, sink, projector, oracle } = setup();
      const before = sink.read();
      collected.rows = 0;

      for (let i = 0; i < count; i += 1) {
        table.applyDelta(
          upsert(`c${i}`, { title: `Renamed ${i}`, revision: 2 }),
        );
      }
      const after = projector.projectChanges();

      expect(collected.rows).toBe(count);
      expect(
        changedTableIds(before.tree.nodeById, after.tree.nodeById),
      ).toEqual(new Set(Array.from({ length: count }, (_, i) => `c${i}`)));
      // Recency sort: a title edit reorders nothing, so every branch is kept.
      expect(after.tree.childrenByParent).toBe(before.tree.childrenByParent);
      expect(after.tree.rootIds).toBe(before.tree.rootIds);
      for (let i = count; i < CHILDREN; i += 1) {
        expect(after.tree.nodeById[`c${i}`]).toBe(
          before.tree.nodeById[`c${i}`],
        );
        expect(after.chats.byId[`c${i}`]).toBe(before.chats.byId[`c${i}`]);
      }
      expect(after.tree.nodeById.p1).toBe(before.tree.nodeById.p1);
      expect(after).toEqual(oracle());
    },
  );

  it("moving one child to the front rebuilds its branch only", () => {
    const { table, sink, projector, oracle } = setup();
    const before = sink.read();
    collected.rows = 0;

    // c0 is the least recently updated child of p1.
    table.applyDelta(upsert("c0", { updatedAt: 1000, revision: 2 }));
    const after = projector.projectChanges();

    expect(collected.rows).toBe(1);
    expect(after.tree.childrenByParent.p1[0]).toBe("c0");
    expect(
      changedTableIds(
        before.tree.childrenByParent,
        after.tree.childrenByParent,
      ),
    ).toEqual(new Set(["p1"]));
    expect(after.tree.childrenByParent.p2).toBe(
      before.tree.childrenByParent.p2,
    );
    expect(after.tree.rootIds).toBe(before.tree.rootIds);
    expect(after).toEqual(oracle());
  });

  it.each([
    ["a parent move", () => upsert("c0", { parentChatId: "p2", revision: 2 })],
    ["a new chat", () => upsert("c-new", { parentChatId: "p1", updatedAt: 7 })],
  ])("%s takes the full composition and equals it", (_name, delta) => {
    const { table, projector, oracle } = setup();
    collected.rows = 0;

    table.applyDelta(delta());
    const after = projector.projectChanges();

    // The incremental helper was never consulted for the tree.
    expect(collected.rows).toBe(0);
    expect(after).toEqual(oracle());
  });

  it("a removal takes the full composition and equals it", () => {
    const { table, projector, oracle } = setup();
    collected.rows = 0;

    table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "c0",
      reason: "deleted",
    });
    const after = projector.projectChanges();

    expect(collected.rows).toBe(0);
    expect(after.tree.nodeById.c0).toBeUndefined();
    expect(after).toEqual(oracle());
  });
});
