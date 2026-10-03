/**
 * `createProjectionEncoder` output, cloned as if crossing postMessage, applied
 * through `handle.projection.apply` (`store.ts`'s `applyProjection`).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProjection } from "../types";
import { createProjectionEncoder } from "../runtime/projection-wire";
import type { EpicStreamClientFactory } from "../store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";

function chatProjection(
  overrides: Partial<ChatProjection> & { readonly id: string },
): ChatProjection {
  return {
    title: "Untitled",
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId: "user-a",
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: null,
    settings: null,
    archivedAt: null,
    ...overrides,
  };
}

/** Same shape as `replica-runtime-behavior-identity.test.ts`'s `fakeFactory`. */
function fakeFactory(): EpicStreamClientFactory {
  return (_epicId, _callbacks) => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => undefined,
  });
}

describe("projection wire - encoder output applied through the store boundary", () => {
  let handle: OpenedStoreForTest | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it("ships the first slice whole, then only its changed/removed rows, and keeps an untouched row's identity and the docChats/chats alias across the wire", () => {
    handle = openStoreForTest({
      epicId: "epic-wire",
      userId: null,
      factories: { streamClientFactory: fakeFactory(), laneSelection: null },
      writeCommand: null,
    });
    const opened = handle;
    const encoder = createProjectionEncoder();

    const c1First = chatProjection({ id: "c1", title: "First" });
    const c2 = chatProjection({ id: "c2", title: "Second" });
    const c3 = chatProjection({ id: "c3", title: "Third" });
    const chatsSliceA = {
      byId: { c1: c1First, c2, c3 },
      allIds: ["c1", "c2", "c3"],
    };
    // A raw record slice - `chatRecords` rebuilds rows on every publication,
    // unlike the composed `chats`, so its own row objects here are freshly
    // allocated content, not the same references as chatsSliceA's.
    const rc1First = chatProjection({ id: "c1", title: "First" });
    const rc2 = chatProjection({ id: "c2", title: "Second" });
    const rc3First = chatProjection({ id: "c3", title: "Third" });
    const chatRecordsSliceA = {
      byId: { c1: rc1First, c2: rc2, c3: rc3First },
      allIds: ["c1", "c2", "c3"],
    };

    // chats/docChats are aliased (same ref), as `unionChats` hands through.
    opened.projection.apply(
      structuredClone(
        encoder.encode({
          chats: chatsSliceA,
          docChats: chatsSliceA,
          chatRecords: chatRecordsSliceA,
        }),
      ),
      1,
    );

    const afterFirst = opened.store.getState();
    expect(afterFirst.chats.allIds).toEqual(["c1", "c2", "c3"]);
    expect(afterFirst.docChats).toBe(afterFirst.chats);

    const c3BeforeSecond = afterFirst.chats.byId.c3;
    const rc3BeforeSecond = afterFirst.chatRecords.byId.c3;

    // Second publish: c1 renamed, c2 removed, c3 untouched. `chatRecords`'
    // c3 is a FRESH allocation with the SAME content, standing in for the
    // producer rebuilding every row on each publish.
    const c1Renamed = chatProjection({ id: "c1", title: "Renamed" });
    const chatsSliceB = { byId: { c1: c1Renamed, c3 }, allIds: ["c1", "c3"] };
    const rc1Renamed = chatProjection({ id: "c1", title: "Renamed" });
    const rc3SecondAllocation = chatProjection({ id: "c3", title: "Third" });
    const chatRecordsSliceB = {
      byId: { c1: rc1Renamed, c3: rc3SecondAllocation },
      allIds: ["c1", "c3"],
    };
    const patch = encoder.encode({
      chats: chatsSliceB,
      docChats: chatsSliceB,
      chatRecords: chatRecordsSliceB,
    });

    // Only changed/removed rows ride the delta; c3 never appears in it.
    const chatsDelta = patch.sliceDeltas?.find(
      (delta) => delta.key === "chats",
    );
    if (chatsDelta === undefined) {
      throw new Error("expected a chats slice delta on the second publish");
    }
    expect(chatsDelta.tables.byId.upserts).toEqual({ c1: c1Renamed });
    expect(chatsDelta.tables.byId.removed).toEqual(["c2"]);
    expect(Object.hasOwn(chatsDelta.tables.byId.upserts, "c3")).toBe(false);

    // Same contract on the raw slice: despite c3 being a fresh allocation,
    // the pre-diff splice recognizes its content is unchanged and excludes
    // it from the delta too.
    const chatRecordsDelta = patch.sliceDeltas?.find(
      (delta) => delta.key === "chatRecords",
    );
    if (chatRecordsDelta === undefined) {
      throw new Error(
        "expected a chatRecords slice delta on the second publish",
      );
    }
    expect(chatRecordsDelta.tables.byId.upserts).toEqual({ c1: rc1Renamed });
    expect(chatRecordsDelta.tables.byId.removed).toEqual(["c2"]);
    expect(Object.hasOwn(chatRecordsDelta.tables.byId.upserts, "c3")).toBe(
      false,
    );

    opened.projection.apply(structuredClone(patch), 2);

    const afterSecond = opened.store.getState();
    expect(afterSecond.chats.allIds).toEqual(["c1", "c3"]);
    expect(afterSecond.chats.byId.c1.title).toBe("Renamed");
    expect(Object.hasOwn(afterSecond.chats.byId, "c2")).toBe(false);
    // c3 never changed, so its object identity carries forward untouched.
    expect(afterSecond.chats.byId.c3).toBe(c3BeforeSecond);
    // The alias survives a delta-carried publish too.
    expect(afterSecond.docChats).toBe(afterSecond.chats);
    // The raw slice's untouched row keeps the STORE's held reference too,
    // not the fresh allocation the second publish carried.
    expect(afterSecond.chatRecords.byId.c3).toBe(rc3BeforeSecond);

    // A third publish that renames c1 again but keeps the same {c1, c3}
    // membership and order: the id list itself did not change, so it must
    // not ride the delta either.
    const rc1RenamedAgain = chatProjection({
      id: "c1",
      title: "Renamed again",
    });
    const chatRecordsSliceC = {
      byId: { c1: rc1RenamedAgain, c3: rc3SecondAllocation },
      allIds: ["c1", "c3"],
    };
    const patch3 = encoder.encode({ chatRecords: chatRecordsSliceC });
    const chatRecordsDelta3 = patch3.sliceDeltas?.find(
      (delta) => delta.key === "chatRecords",
    );
    if (chatRecordsDelta3 === undefined) {
      throw new Error(
        "expected a chatRecords slice delta on the third publish",
      );
    }
    expect(chatRecordsDelta3.tables.byId.upserts).toEqual({
      c1: rc1RenamedAgain,
    });
    expect(Object.hasOwn(chatRecordsDelta3.fields, "allIds")).toBe(false);

    // A missed delta over a non-keyed field, never applied - snapshot() repairs it.
    encoder.encode({ isDirty: true });
    opened.projection.apply(structuredClone(encoder.snapshot()), 3);

    const afterRepair = opened.store.getState();
    expect(afterRepair.isDirty).toBe(true);
    expect(afterRepair.chats.byId.c1.title).toBe("Renamed");
    expect(afterRepair.chats.byId.c3).toBe(c3BeforeSecond);
  });
});
