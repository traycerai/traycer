import { describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import {
  createChatRecordTable,
  type ChatRecordTable,
} from "../runtime/chat-record-table";
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
 * (OWNER_A, CHAT_ID_A) -> "a" + SEP + "b" + SEP + "c" (OWNER_B, CHAT_ID_B) -> "a" + SEP + "b" +
 * SEP + "c" Both produce the same six-character-plus-separators sequence.
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

    // BOTH rows survive ingest.
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

/**
 * The SECOND way a bare `chatId` is mistaken for a record identity, on the same table and with no
 * separator trickery needed: a delta that carries no home reads the held home off the PUBLISHED
 */
describe("createChatRecordTable - a delta reads the home of its OWN row", () => {
  it("does not inherit a same-id chat's home from a different owner", () => {
    const SHARED_ID = "chat-shared";
    const DOC_OWNER = "owner-doc";
    const REGISTRY_OWNER = "owner-registry";

    // The viewer moves during the test, which is the whole point: the window in which the slice is
    // holding the STRANGER's row is precisely the null-viewer boot window, and the row whose home was
    let viewer: string | null = null;
    const table = createChatRecordTable({
      getCurrentUserId: () => viewer,
      onBeforePublish: () => undefined,
      now: () => 0,
    });

    // One `@1.1` answer stating both homes.
    const seeded = table.applyRecords(
      [
        record({
          chatId: SHARED_ID,
          ownerUserId: REGISTRY_OWNER,
          title: "Registry-homed",
          docResident: false,
          revision: 1,
        }),
        record({
          chatId: SHARED_ID,
          ownerUserId: DOC_OWNER,
          title: "Doc-homed",
          docResident: true,
          revision: 1,
        }),
      ],
      null,
    );
    if (seeded === null) {
      throw new Error("expected a publication from the first answer");
    }
    // Precondition, not the assertion under test: the slice's single slot for this id is the
    // STRANGER's row.
    expect(seeded.chatRecords.byId[SHARED_ID].docResident).toBe(true);

    // A `host.chatRecords.subscribe` delta for the REGISTRY-homed owner. It states nothing about the
    // home, so the table must carry that owner's own last stated home forward.
    const delta: ChatRecordDelta = {
      kind: "upsert",
      epicId: EPIC_ID,
      record: record({
        chatId: SHARED_ID,
        ownerUserId: REGISTRY_OWNER,
        title: "Registry-homed, renamed",
        revision: 9,
      }),
    };
    table.applyDelta(delta);

    // The viewer settles. The doc-homed stranger drops out of the slice and the registry-homed row
    // takes the slot, so its carried home is finally observable.
    viewer = REGISTRY_OWNER;
    const afterSignIn = table.beginPendingCreation({
      chatId: "chat-unrelated",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: REGISTRY_OWNER,
    });
    if (afterSignIn === null) {
      throw new Error("expected a publication once the viewer settled");
    }

    const settled = afterSignIn.chatRecords.byId[SHARED_ID];
    expect(settled.title).toBe("Registry-homed, renamed");
    // THE REDDENING ASSERTION.
    expect(settled.docResident).toBe(false);
  });
});

describe("createChatRecordTable - a rejected point-read still retires a pending creation", () => {
  const CHAT_ID = "chat-pointread";
  const pending: PendingChatCreation = {
    chatId: CHAT_ID,
    hostId: "host-1",
    parentChatId: null,
    title: "stand-in",
    ownerUserId: "user-a",
  };
  const held = record({
    chatId: CHAT_ID,
    ownerUserId: "user-a",
    title: "Held",
    revision: 2,
  });

  function tableWithHeldRowAndPending(): {
    readonly table: ChatRecordTable;
    readonly publishes: { value: number };
  } {
    const publishes = { value: 0 };
    const table = createChatRecordTable({
      getCurrentUserId: () => "user-a",
      onBeforePublish: () => {
        publishes.value += 1;
      },
      now: () => 0,
    });
    const seeded = table.applyRecords([held], null);
    if (seeded === null) {
      throw new Error("expected a publication seeding the held row");
    }
    // The held row shadows the stand-in, so republish's change gate returns
    // null even though the pending map accepted the entry.
    table.beginPendingCreation(pending);
    expect(table.current().byId[CHAT_ID].title).toBe("Held");
    return { table, publishes };
  }

  it("an equal point-read still retires the stand-in so an omitting snapshot cannot resurrect it", () => {
    const { table, publishes } = tableWithHeldRowAndPending();
    const publishesBefore = publishes.value;
    table.applyConfirmedMutation({
      kind: "upsert",
      record: record({
        chatId: CHAT_ID,
        ownerUserId: "user-a",
        title: "Equal replay",
        revision: 2,
      }),
    });
    expect(publishes.value).toBeGreaterThan(publishesBefore);
    expect(table.current().byId[CHAT_ID].title).toBe("Held");

    const omitted = table.applyRecords([], table.ingestSeq());
    if (omitted === null) {
      throw new Error("expected a publication omitting the held row");
    }
    expect(omitted.chatRecords.allIds).toEqual([]);
  });

  it("an older point-read still retires the stand-in so an omitting snapshot cannot resurrect it", () => {
    const { table, publishes } = tableWithHeldRowAndPending();
    const publishesBefore = publishes.value;
    table.applyConfirmedMutation({
      kind: "upsert",
      record: record({
        chatId: CHAT_ID,
        ownerUserId: "user-a",
        title: "Older replay",
        revision: 1,
      }),
    });
    expect(publishes.value).toBeGreaterThan(publishesBefore);

    const omitted = table.applyRecords([], table.ingestSeq());
    if (omitted === null) {
      throw new Error("expected a publication omitting the held row");
    }
    expect(omitted.chatRecords.allIds).toEqual([]);
  });
});
