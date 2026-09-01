/**
 * Regression pin for the doc-over-doc waiver in
 * `chatRowSupersedesOnSnapshot` (`runtime/chat-record-table.ts`).
 *
 * A doc-resident chat has no registry head seq, so the host reports
 * `revision: 0` on EVERY answer (`chat-record-summary.ts`, which says so).
 * The table's snapshot rule was `candidate.revision > held.revision`, and
 * `0 > 0` is false - so the first answer of the session won permanently and
 * every later read of the same live doc map was discarded. For a caller with
 * no doc replica that answer is those chats' only source, so a rename or an
 * archive performed anywhere else stayed invisible until the chat was adopted
 * into the store.
 *
 * The waiver is keyed on `docResident` and scoped to the SNAPSHOT path, and
 * the two controls below are what make it a waiver rather than a hole: it must
 * not fire between two registry-backed rows (that comparison is what stops an
 * answer already in flight from clobbering a delta-advanced row), and it must
 * not fire when only ONE side is doc-resident.
 *
 * The `record()` fixture mirrors `chat-record-key-collision.test.ts`'s, whose
 * header explains the `getCurrentUserId: () => null` convention.
 */
import { describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import { createChatRecordTable } from "../runtime/chat-record-table";

const CHAT_ID = "chat-doc-1";

function record(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: CHAT_ID,
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

function freshTable() {
  return createChatRecordTable({
    getCurrentUserId: () => null,
    onBeforePublish: () => undefined,
    now: () => 0,
  });
}

describe("createChatRecordTable - refreshing a doc-resident row", () => {
  it("takes the later of two doc reads, which both report revision 0", () => {
    const table = freshTable();

    const first = table.applyRecords(
      [record({ docResident: true, revision: 0, title: "Original" })],
      null,
    );
    if (first === null) {
      throw new Error("expected a publication from the first snapshot");
    }
    expect(first.chatRecords.byId[CHAT_ID].title).toBe("Original");

    // A second list call. `readDocResidentSummaries` re-read the live map and
    // found a rename; the row still reports `revision: 0`, because a doc entry
    // has no seq to report.
    const second = table.applyRecords(
      [
        record({
          docResident: true,
          revision: 0,
          title: "Renamed elsewhere",
          archived: true,
          archivedAt: 99,
        }),
      ],
      null,
    );

    // THE REDDENING ASSERTION - and it reddens twice over. Under `0 > 0` the
    // row is rejected, so the slice is unchanged and `applyRecords` publishes
    // NOTHING at all.
    if (second === null) {
      throw new Error(
        "expected a publication: the refreshed doc row was discarded",
      );
    }
    expect(second.chatRecords.byId[CHAT_ID].title).toBe("Renamed elsewhere");
    // The archive travels too - the projection carries it as `archivedAt`.
    // Two fields, because a rename and an archive reach the sidebar through
    // different affordances and the freeze hid both.
    expect(second.chatRecords.byId[CHAT_ID].archivedAt).toBe(99);
  });

  it("still refuses a stale in-flight answer between two REGISTRY rows", () => {
    // The control that keeps the waiver narrow. The revision test on the
    // snapshot path is what stops an answer issued before a delta from
    // clobbering the row that delta advanced - waiving it for every pair, or
    // keying it on something both registry rows also satisfy, would reopen
    // exactly that.
    const table = freshTable();

    table.applyRecords(
      [record({ docResident: false, revision: 5, title: "Current" })],
      null,
    );

    const stale = table.applyRecords(
      [record({ docResident: false, revision: 3, title: "Stale answer" })],
      null,
    );

    // No change to publish: the older answer was rejected outright.
    expect(stale).toBeNull();
  });

  it("refuses a candidate when only ONE side is doc-resident", () => {
    // The other half of the key. A rule keyed on the held row alone - or on
    // the candidate alone - passes the first case above and lets a registry
    // row at an equal revision displace a doc row, and vice versa, neither of
    // which the "same authority, later read" argument covers.
    const table = freshTable();

    table.applyRecords(
      [record({ docResident: true, revision: 0, title: "Doc row" })],
      null,
    );

    const registryAtSameRevision = table.applyRecords(
      [record({ docResident: false, revision: 0, title: "Registry row" })],
      null,
    );
    expect(registryAtSameRevision).toBeNull();

    const heldRegistry = freshTable();
    heldRegistry.applyRecords(
      [record({ docResident: false, revision: 0, title: "Registry row" })],
      null,
    );
    const docAtSameRevision = heldRegistry.applyRecords(
      [record({ docResident: true, revision: 0, title: "Doc row" })],
      null,
    );
    expect(docAtSameRevision).toBeNull();
  });
});
