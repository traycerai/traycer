import { describe, expect, it, vi } from "vitest";
import {
  createMainProjectionAccount,
  MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
} from "../main-projection-account";
import { retainedValueSize } from "../retained-value-size";

describe("main projection memory account", () => {
  it("tracks changed top-level patches and counts aliased values once", () => {
    const account = createMainProjectionAccount();
    const shared = { title: "retained title", rows: ["row-a", "row-b"] };
    const initial = account.recordPatch({ chats: shared, aliases: shared });
    expect(initial).toEqual({
      rawBytes: retainedValueSize(shared).rawBytes,
      estimatedHeapBytes:
        retainedValueSize(shared).estimatedHeapBytes +
        MAIN_PROJECTION_BOOKKEEPING_HEAP_BYTES,
    });

    const next = { title: "replacement title", rows: ["row-c"] };
    const updated = account.recordPatch({ chats: next });
    const expectedChat = retainedValueSize(next);
    const expectedAlias = retainedValueSize(shared);
    expect(updated).toEqual({
      rawBytes: expectedChat.rawBytes + expectedAlias.rawBytes,
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
});
