import { describe, expect, it, vi } from "vitest";
import {
  createMainProjectionAccount,
  MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
} from "../main-projection-account";
import { retainedValueSize } from "../retained-value-size";

function rawJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function rawRootBytes(...roots: readonly unknown[]): number {
  return roots.reduce<number>((total, root) => total + rawJsonBytes(root), 0);
}

describe("main projection memory account", () => {
  it("tracks changed top-level patches and counts aliased values once", () => {
    const account = createMainProjectionAccount();
    const shared = { title: "retained title", rows: ["row-a", "row-b"] };
    const initial = account.recordPatch({ chats: shared, aliases: shared });
    expect(initial).toEqual({
      rawBytes: rawRootBytes(shared, shared),
      estimatedHeapBytes:
        retainedValueSize(shared).estimatedHeapBytes +
        MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
    });

    const next = { title: "replacement title", rows: ["row-c"] };
    const updated = account.recordPatch({ chats: next });
    const expectedChat = retainedValueSize(next);
    const expectedAlias = retainedValueSize(shared);
    expect(updated).toEqual({
      rawBytes: rawRootBytes(next, shared),
      estimatedHeapBytes:
        expectedChat.estimatedHeapBytes +
        expectedAlias.estimatedHeapBytes +
        MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
    });

    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(account.recordPatch({ chats: next })).toBeNull();
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("does not re-encode an unchanged large row when one byId row changes", () => {
    const account = createMainProjectionAccount();
    const largeBody = "sibling-body/".repeat(80_000);
    const sibling = { id: "sibling", body: largeBody };
    const oldRow = { id: "changed", body: "before" };
    account.recordPatch({
      chats: { byId: { sibling, changed: oldRow } },
    });

    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      account.recordPatch({
        chats: {
          byId: { sibling, changed: { id: "changed", body: "after" } },
        },
      });
      const siblingEncodes = encode.mock.calls.filter(
        ([value]) => typeof value === "string" && value.includes(largeBody),
      );
      expect(siblingEncodes).toHaveLength(0);
    } finally {
      encode.mockRestore();
    }
  });

  it("charges shared rows once across chats and chatRecords roots", () => {
    const account = createMainProjectionAccount();
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat title ${index}`,
      summary: `Retained summary for chat row ${index}`,
    }));
    const allIds = rows.map((row) => row.id);
    const chatsById = Object.fromEntries(
      rows.map((row) => [row.id, row] as const),
    );
    const recordsById = { ...chatsById };
    const chats = { byId: chatsById, allIds };
    const chatRecords = { byId: recordsById, allIds: [...allIds] };
    const rootSizes = [
      retainedValueSize(chats),
      retainedValueSize(chatRecords),
    ];
    const expected = {
      rawBytes: rawRootBytes(chats, chatRecords),
      estimatedHeapBytes:
        rootSizes[0].estimatedHeapBytes +
        rootSizes[1].estimatedHeapBytes -
        rows.reduce(
          (total, row) => total + retainedValueSize(row).estimatedHeapBytes,
          0,
        ) +
        MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
    };
    expect(account.recordPatch({ chats, chatRecords })).toEqual(expected);

    const replacement = {
      id: rows[0].id,
      title: "Updated title",
      summary: "Updated summary",
    };
    const nextChats = {
      byId: { ...chatsById, [replacement.id]: replacement },
      allIds,
    };
    const nextRootSizes = [
      retainedValueSize(nextChats),
      retainedValueSize(chatRecords),
    ];
    expect(account.recordPatch({ chats: nextChats })).toEqual({
      rawBytes: rawRootBytes(nextChats, chatRecords),
      estimatedHeapBytes:
        nextRootSizes[0].estimatedHeapBytes +
        nextRootSizes[1].estimatedHeapBytes -
        rows
          .slice(1)
          .reduce(
            (total, row) => total + retainedValueSize(row).estimatedHeapBytes,
            0,
          ) +
        MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
    });
  });
});
