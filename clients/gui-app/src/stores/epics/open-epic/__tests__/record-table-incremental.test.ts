/**
 * The chat record table projects only the rows a write changed, and says which
 * ones (`projection-table-changes.ts`). Work is counted at the real boundary -
 * `chatRecordsSlice`, the per-row projection every publish runs - not timed.
 * Anything that can move membership falls back to the full projection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { HeldChatRecordRow } from "../types";
import type { ChatRecordTable } from "../runtime/chat-record-table";
import { changedTableIds } from "../runtime/projection-table-changes";

const projected = vi.hoisted(() => ({ rows: 0 }));

vi.mock("../projection-helpers", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../projection-helpers")>();
  return {
    ...original,
    chatRecordsSlice: (records: readonly HeldChatRecordRow[]) => {
      projected.rows += records.length;
      return original.chatRecordsSlice(records);
    },
  };
});

// Imported after the mock so the table binds the counting wrapper.
const { createChatRecordTable } = await import("../runtime/chat-record-table");

const EPIC_ID = "epic-incremental";
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

function seededTable() {
  const table = createChatRecordTable({
    getCurrentUserId: () => OWNER,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
  const seed = table.applyRecords(
    Array.from({ length: HELD }, (_, i) => record(i, {})),
    null,
  );
  if (seed === null) throw new Error("expected the seed publication");
  return { table, seed: seed.chatRecords };
}

function renameDelta(index: number, revision: number) {
  return {
    kind: "upsert" as const,
    epicId: EPIC_ID,
    record: record(index, { title: `Renamed ${index}`, revision }),
  };
}

beforeEach(() => {
  projected.rows = 0;
});

describe("chat record table - work scales with the rows a write changed", () => {
  it.each(CHANGED_COUNTS)(
    "projects only the %i rows that were upserted and reports exactly those ids",
    (count) => {
      const { table, seed } = seededTable();
      projected.rows = 0;

      let latest = seed;
      for (let i = 0; i < count; i += 1) {
        const publication = table.applyDelta(renameDelta(i, 2));
        if (publication === null) throw new Error("expected a publication");
        latest = publication.chatRecords;
      }

      expect(projected.rows).toBe(count);
      expect(latest.allIds).toBe(seed.allIds);
      for (let i = 0; i < HELD; i += 1) {
        const id = `chat-${i}`;
        if (i < count) expect(latest.byId[id].title).toBe(`Renamed ${i}`);
        else expect(latest.byId[id]).toBe(seed.byId[id]);
      }
      expect(changedTableIds(seed.byId, latest.byId)).toEqual(
        new Set(Array.from({ length: count }, (_, i) => `chat-${i}`)),
      );
    },
  );

  it.each(CHANGED_COUNTS)(
    "projects only the %i rows a recency patch touched",
    (count) => {
      const { table, seed } = seededTable();
      projected.rows = 0;

      const publication = table.applyTouches(
        Array.from({ length: count }, (_, i) => ({
          id: `chat-${i}`,
          ownerUserId: OWNER,
          updatedAt: 99,
          revision: 2,
        })),
      );
      if (publication === null) throw new Error("expected a publication");

      expect(projected.rows).toBe(count);
      expect(publication.chatRecords.byId["chat-0"].updatedAt).toBe(99);
      expect(publication.chatRecords.byId[`chat-${count}`]).toBe(
        seed.byId[`chat-${count}`],
      );
      expect(changedTableIds(seed.byId, publication.chatRecords.byId)).toEqual(
        new Set(Array.from({ length: count }, (_, i) => `chat-${i}`)),
      );
    },
  );

  it("projects nothing for a replay, a stale revision or a retracted id, and publishes nothing", () => {
    const { table } = seededTable();
    table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "chat-7",
      reason: "deleted",
    });
    projected.rows = 0;

    expect(table.applyDelta(renameDelta(3, 1))).toBeNull();
    expect(table.applyDelta(renameDelta(7, 5))).toBeNull();
    expect(projected.rows).toBe(0);
  });

  it("does not republish a row whose upsert projects identically", () => {
    const { table } = seededTable();
    // A newer revision carrying the same displayed content.
    expect(
      table.applyDelta({
        kind: "upsert",
        epicId: EPIC_ID,
        record: record(4, { revision: 2 }),
      }),
    ).toBeNull();
  });

  it.each([
    [
      "a removal",
      (table: ChatRecordTable) =>
        table.applyDelta({
          kind: "remove",
          epicId: EPIC_ID,
          chatId: "chat-0",
          reason: "deleted",
        }),
      Array.from({ length: HELD - 1 }, (_, i) => record(i + 1, {})),
      [],
    ],
    [
      "a row the table did not hold",
      (table: ChatRecordTable) =>
        table.applyDelta({
          kind: "upsert",
          epicId: EPIC_ID,
          record: record(HELD, {}),
        }),
      Array.from({ length: HELD + 1 }, (_, i) => record(i, {})),
      // A stream row cannot state the home of a chat the table never held, so
      // it is published as unknown (null), where a listed row states false.
      [`chat-${HELD}`],
    ],
  ])(
    "falls back to the full projection on %s and still equals a fresh build",
    (_name, write, expectedRecords, unstatedHomeIds) => {
      const { table } = seededTable();
      projected.rows = 0;

      const publication = write(table);
      if (publication === null) throw new Error("expected a publication");

      expect(projected.rows).toBe(expectedRecords.length);
      const fresh = createChatRecordTable({
        getCurrentUserId: () => OWNER,
        onBeforePublish: () => undefined,
        now: () => 0,
      });
      const rebuilt = fresh.applyRecords(expectedRecords, null);
      if (rebuilt === null) throw new Error("expected the rebuilt publication");
      const expectedById = { ...rebuilt.chatRecords.byId };
      for (const id of unstatedHomeIds) {
        expectedById[id] = { ...expectedById[id], docResident: null };
      }
      expect(publication.chatRecords.allIds).toEqual(
        rebuilt.chatRecords.allIds,
      );
      expect(publication.chatRecords.byId).toEqual(expectedById);
    },
  );

  it("drops a pending-only stand-in on removal instead of serving the previous slice", () => {
    const { table } = seededTable();
    const registered = table.beginPendingCreation({
      chatId: "pending-1",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: OWNER,
    });
    expect(registered?.chatRecords.allIds).toContain("pending-1");

    // No record was ever held for it: the removal changes plane state only.
    const removed = table.applyDelta({
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "pending-1",
      reason: "deleted",
    });
    if (removed === null) throw new Error("expected a publication");

    expect(removed.chatRecords.allIds).not.toContain("pending-1");
    expect(removed.chatRecords.allIds).toHaveLength(HELD);
    expect(table.current().byId["pending-1"]).toBeUndefined();
  });

  it("keeps the winning owner's row when an older same-id owner's write arrives, and switches with the viewer", () => {
    let viewer: string | null = null;
    const table = createChatRecordTable({
      getCurrentUserId: () => viewer,
      onBeforePublish: () => undefined,
      now: () => 0,
    });
    // Two owners hold one host-minted id; with no viewer the slice has one
    // slot for it and the later-retained row (owner b) takes it.
    table.applyRecords(
      [
        record(1, { chatId: "shared", ownerUserId: "user-a", title: "A" }),
        record(2, { chatId: "shared", ownerUserId: "user-b", title: "B" }),
      ],
      null,
    );
    expect(table.current().byId.shared.title).toBe("B");

    table.applyDelta({
      kind: "upsert",
      epicId: EPIC_ID,
      record: record(1, {
        chatId: "shared",
        ownerUserId: "user-a",
        title: "A renamed",
        revision: 2,
      }),
    });
    table.applyTouches([
      { id: "shared", ownerUserId: "user-a", updatedAt: 99, revision: 3 },
    ]);
    expect(table.current().byId.shared.title).toBe("B");

    viewer = "user-a";
    table.republishForCurrentUser();
    expect(table.current().byId.shared.title).toBe("A renamed");
  });
});
