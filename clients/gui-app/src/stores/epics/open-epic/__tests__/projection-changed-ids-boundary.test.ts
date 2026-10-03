/**
 * Chat record table -> projection encoder -> structured clone -> store. The
 * table names the ids it changed, so the encoder must not re-compare the other
 * rows (`chatProjectionsEq` calls are the count); a slice with no provenance,
 * a removal, and a dropped delta all still land the same content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { ChatProjection, ChatsSlice } from "../types";
import type { EpicStreamClientFactory } from "../store";
import type { EpicProjectionPatch } from "../runtime/projection-wire";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";

const compared = vi.hoisted(() => ({ rows: 0 }));

vi.mock("../projection-helpers", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../projection-helpers")>();
  return {
    ...original,
    chatProjectionsEq: (a: ChatProjection, b: ChatProjection) => {
      compared.rows += 1;
      return original.chatProjectionsEq(a, b);
    },
  };
});

// Imported after the mock so the modules bind the counting wrapper.
const { createChatRecordTable } = await import("../runtime/chat-record-table");
const { createProjectionEncoder } = await import("../runtime/projection-wire");

const EPIC_ID = "epic-changed-ids";
const OWNER = "user-a";
const HELD = 200;
const CHANGED_COUNTS = [1, 10, 50] as const;

function record(
  index: number,
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: `chat-${index}`,
    ownerUserId: OWNER,
    originHostId: "host-1",
    title: `Chat ${index}`,
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

const fakeFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `chat-${i}`);
}

describe("changed table ids - record table to store", () => {
  let handle: OpenedStoreForTest | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  beforeEach(() => {
    compared.rows = 0;
  });

  /** A table holding HELD chats, whose first publication is already in the store. */
  function shipped() {
    handle = openStoreForTest({
      epicId: EPIC_ID,
      userId: null,
      factories: { streamClientFactory: fakeFactory, laneSelection: null },
      writeCommand: null,
    });
    const table = createChatRecordTable({
      getCurrentUserId: () => OWNER,
      onBeforePublish: () => undefined,
      now: () => 0,
    });
    const encoder = createProjectionEncoder();
    const seed = table.applyRecords(
      Array.from({ length: HELD }, (_, i) => record(i, {})),
      null,
    );
    if (seed === null) throw new Error("expected the seed publication");
    handle.projection.apply(
      structuredClone(encoder.encode({ chatRecords: seed.chatRecords })),
      1,
    );
    return { handle, table, encoder, seed: seed.chatRecords };
  }

  function chatRecordsDelta(patch: EpicProjectionPatch) {
    const delta = patch.sliceDeltas?.find((d) => d.key === "chatRecords");
    if (delta === undefined) throw new Error("expected a chatRecords delta");
    return delta.tables.byId;
  }

  it.each(CHANGED_COUNTS)(
    "ships %i changed rows without re-comparing the rest, and the store keeps every other row's identity",
    (count) => {
      const { handle: opened, table, encoder } = shipped();
      const before = opened.store.getState().chatRecords;

      let latest: ChatsSlice = before;
      for (let i = 0; i < count; i += 1) {
        const publication = table.applyDelta({
          kind: "upsert",
          epicId: EPIC_ID,
          record: record(i, { title: `Renamed ${i}`, revision: 2 }),
        });
        if (publication === null) throw new Error("expected a publication");
        latest = publication.chatRecords;
      }

      compared.rows = 0;
      const patch = encoder.encode({ chatRecords: latest });
      expect(compared.rows).toBe(0);

      const delta = chatRecordsDelta(patch);
      expect(Object.keys(delta.upserts).sort()).toEqual(ids(count).sort());
      expect(delta.removed).toEqual([]);

      opened.projection.apply(structuredClone(patch), 2);
      const after = opened.store.getState().chatRecords;
      for (let i = 0; i < HELD; i += 1) {
        const id = `chat-${i}`;
        if (i < count) expect(after.byId[id].title).toBe(`Renamed ${i}`);
        else expect(after.byId[id]).toBe(before.byId[id]);
      }
    },
  );

  it("falls back to comparing every row when the slice carries no provenance, with the same delta", () => {
    const { table, encoder } = shipped();
    const publication = table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record(3, { title: "Renamed 3", revision: 2 }),
    });
    if (publication === null) throw new Error("expected a publication");
    // Same content, but a copy the table never published: history is unknown.
    const unmarked: ChatsSlice = {
      byId: { ...publication.chatRecords.byId },
      allIds: publication.chatRecords.allIds,
    };

    compared.rows = 0;
    const delta = chatRecordsDelta(encoder.encode({ chatRecords: unmarked }));

    expect(compared.rows).toBe(HELD);
    expect(Object.keys(delta.upserts)).toEqual(["chat-3"]);
  });

  it("ships a removal as removed, comparing every remaining row", () => {
    const { handle: opened, table, encoder } = shipped();
    const publication = table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "chat-0",
      reason: "deleted",
    });
    if (publication === null) throw new Error("expected a publication");

    compared.rows = 0;
    const patch = encoder.encode({ chatRecords: publication.chatRecords });

    expect(compared.rows).toBe(HELD - 1);
    expect(chatRecordsDelta(patch).removed).toEqual(["chat-0"]);
    opened.projection.apply(structuredClone(patch), 2);
    expect(opened.store.getState().chatRecords.allIds).not.toContain("chat-0");
  });

  it("resumes id-only encoding after a full-fallback publication", () => {
    const { handle: opened, table, encoder } = shipped();
    const removal = table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "chat-0",
      reason: "deleted",
    });
    if (removal === null) throw new Error("expected a publication");
    opened.projection.apply(
      structuredClone(encoder.encode({ chatRecords: removal.chatRecords })),
      2,
    );

    const rename = table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record(5, { title: "Renamed 5", revision: 2 }),
    });
    if (rename === null) throw new Error("expected a publication");
    compared.rows = 0;
    const patch = encoder.encode({ chatRecords: rename.chatRecords });

    expect(compared.rows).toBe(0);
    const delta = chatRecordsDelta(patch);
    expect(Object.keys(delta.upserts)).toEqual(["chat-5"]);
    expect(delta.removed).toEqual([]);
    opened.projection.apply(structuredClone(patch), 3);
    expect(opened.store.getState().chatRecords.byId["chat-5"].title).toBe(
      "Renamed 5",
    );
  });

  it("repairs a dropped id-only delta from the encoder snapshot", () => {
    const { handle: opened, table, encoder } = shipped();
    for (const [revision, index] of [
      [2, 1],
      [2, 2],
    ] as const) {
      const publication = table.applyDelta({
        kind: "upsert",
        epicId: EPIC_ID,
        record: record(index, { title: `Renamed ${index}`, revision }),
      });
      if (publication === null) throw new Error("expected a publication");
      // Encoded, never applied: the worker bridge lost this delta.
      encoder.encode({ chatRecords: publication.chatRecords });
    }

    opened.projection.apply(structuredClone(encoder.snapshot()), 3);

    const repaired = opened.store.getState().chatRecords;
    expect(repaired.byId["chat-1"].title).toBe("Renamed 1");
    expect(repaired.byId["chat-2"].title).toBe("Renamed 2");
    expect(repaired.allIds).toEqual(table.current().allIds);
    expect(repaired.byId).toEqual(table.current().byId);
  });
});
