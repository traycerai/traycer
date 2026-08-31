/**
 * Regression pin for `recordKey`'s composite-key join
 * (`runtime/chat-record-table.ts`).
 *
 * The row map inside `createChatRecordTable` (via the shared
 * `createRecordTable`) is keyed by `recordKey(ownerUserId, chatId)`, which
 * used to join the two components on ASCII code point 31 (the "Unit
 * Separator" control character) rather than the length-prefixed
 * `sessionKeyOf` it is now. Nothing on the wire stops an id from containing
 * that separator itself (the wire schemas are bare `z.string()`), so a
 * separator join is non-injective: putting the separator INSIDE one
 * component of a pair, at a different offset than the other pair uses, still
 * concatenates to the identical character sequence even though the two pairs
 * share no piece. Under the row map's own admission logic
 * (`createRecordTable.applySnapshot`), the SECOND row then silently
 * overwrites the first's map slot before either ever reaches the published
 * slice, so the first chat disappears from the sidebar exactly as if it
 * never existed - no error, no removal frame, nothing to explain it.
 *
 * There is currently no test file for `chat-record-table.ts` at all. The
 * `record()` fixture below mirrors `chat-records-union.test.ts`'s builder of
 * the same name; `getCurrentUserId: () => null` is that same file's
 * "nobody signed in" convention, under which `isOwnedRecordVisibleToUser`
 * short-circuits to visible-to-everyone so both colliding owners can be
 * observed side by side.
 *
 * IMPORTANT: the separator is built with `String.fromCharCode`, never typed
 * as a source-level escape or pasted as a raw control byte - either of those
 * risks landing an actual control byte in this file (git then flips it to
 * binary).
 */
import { describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import { createChatRecordTable } from "../runtime/chat-record-table";
import type { PendingChatCreation } from "../pending-chat-creations";

const EPIC_ID = "epic-collision";

/** Mirrors `chat-records-union.test.ts`'s `record()` fixture. */
function record(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
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

/** ASCII code point 31, the old join's separator - built at runtime so no
 * control byte is ever written into this source file. */
const UNIT_SEPARATOR = String.fromCharCode(31);

/**
 * The colliding pair under the OLD separator join: the separator sits
 * INSIDE one component of each pair, at a different offset, so the two
 * composites concatenate to the identical character sequence even though no
 * piece is shared between them.
 *
 *   (OWNER_A, CHAT_ID_A) -> "a"  + SEP + "b" + SEP + "c"
 *   (OWNER_B, CHAT_ID_B) -> "a" + SEP + "b"  + SEP + "c"
 *
 * Both produce the same six-character-plus-separators sequence.
 */
const CHAT_ID_A = `b${UNIT_SEPARATOR}c`;
const OWNER_A = "a";
const CHAT_ID_B = "c";
const OWNER_B = `a${UNIT_SEPARATOR}b`;

function freshTable() {
  return createChatRecordTable({
    getCurrentUserId: () => null,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
}

describe("createChatRecordTable - recordKey collision resistance", () => {
  it("keeps both rows of a colliding (ownerUserId, chatId) pair; updating or removing ONE leaves the other untouched", () => {
    const table = freshTable();

    const rowA = record({
      chatId: CHAT_ID_A,
      ownerUserId: OWNER_A,
      title: "Row A",
      revision: 1,
    });
    const rowB = record({
      chatId: CHAT_ID_B,
      ownerUserId: OWNER_B,
      title: "Row B",
      revision: 1,
    });

    const publication = table.applyRecords([rowA, rowB], null);
    if (publication === null) {
      throw new Error("expected a publication from the first snapshot");
    }

    // BOTH rows survive ingest. Under the old join, row B silently replaced
    // row A inside the table's own row map before either reached this slice,
    // so `allIds` would carry only one of the two chat ids.
    expect(publication.chatRecords.allIds.slice().sort()).toEqual(
      [CHAT_ID_A, CHAT_ID_B].sort(),
    );
    expect(publication.chatRecords.byId[CHAT_ID_A]).toBeDefined();
    expect(publication.chatRecords.byId[CHAT_ID_B]).toBeDefined();
    expect(publication.chatRecords.byId[CHAT_ID_A].title).toBe("Row A");
    expect(publication.chatRecords.byId[CHAT_ID_B].title).toBe("Row B");

    // Updating B (a push upsert) must not touch A.
    const upsertDelta: ChatRecordDelta = {
      kind: "upsert",
      epicId: EPIC_ID,
      record: record({
        chatId: CHAT_ID_B,
        ownerUserId: OWNER_B,
        title: "Row B renamed",
        revision: 2,
      }),
    };
    const afterUpsert = table.applyDelta(upsertDelta);
    if (afterUpsert === null) {
      throw new Error("expected a publication from the upsert");
    }
    expect(afterUpsert.chatRecords.byId[CHAT_ID_B].title).toBe("Row B renamed");
    expect(afterUpsert.chatRecords.byId[CHAT_ID_A].title).toBe("Row A");

    // Removing A (a push remove) must not touch B's already-updated row.
    const removeDelta: ChatRecordDelta = {
      kind: "remove",
      epicId: EPIC_ID,
      chatId: CHAT_ID_A,
      reason: "deleted",
    };
    const afterRemoval = table.applyDelta(removeDelta);
    if (afterRemoval === null) {
      throw new Error("expected a publication from the removal");
    }
    expect(afterRemoval.chatRecords.allIds).toEqual([CHAT_ID_B]);
    expect(afterRemoval.chatRecords.byId[CHAT_ID_B].title).toBe(
      "Row B renamed",
    );
    expect(afterRemoval.chatRecords.byId[CHAT_ID_A]).toBeUndefined();
  });

  it("keeps both PENDING creations of a colliding (ownerUserId, chatId) pair", () => {
    const table = freshTable();

    const pendingA: PendingChatCreation = {
      chatId: CHAT_ID_A,
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: OWNER_A,
    };
    const pendingB: PendingChatCreation = {
      chatId: CHAT_ID_B,
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: OWNER_B,
    };

    const afterA = table.beginPendingCreation(pendingA);
    if (afterA === null) {
      throw new Error("expected a publication registering pendingA");
    }
    expect(afterA.chatRecords.allIds).toEqual([CHAT_ID_A]);

    const afterB = table.beginPendingCreation(pendingB);
    if (afterB === null) {
      // Under the old join, `pendingCreations.has(key)` already reads TRUE
      // for pendingB's key (it collides with pendingA's), so registration is
      // refused outright - the second chat the user just created never even
      // gets a stand-in.
      throw new Error(
        "expected a publication registering pendingB - registration was refused, which means its key collided with pendingA's",
      );
    }
    expect(afterB.chatRecords.allIds.slice().sort()).toEqual(
      [CHAT_ID_A, CHAT_ID_B].sort(),
    );

    // Clearing A must not clear B.
    const afterClear = table.clearPendingCreation(CHAT_ID_A);
    if (afterClear === null) {
      throw new Error("expected a publication from clearing pendingA");
    }
    expect(afterClear.chatRecords.allIds).toEqual([CHAT_ID_B]);
  });
});
