import { describe, expect, it } from "vitest";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";

describe("shouldMergeEpicRoomSwap", () => {
  it("permits a merge for explicitly equal room identities", () => {
    expect(
      shouldMergeEpicRoomSwap({ roomId: "room-a" }, { roomId: "room-a" }),
    ).toBe(true);
  });

  it("selects a plain swap when explicit room identities differ", () => {
    expect(
      shouldMergeEpicRoomSwap({ roomId: "room-a" }, { roomId: "room-b" }),
    ).toBe(false);
  });

  it("selects a plain swap when either host did not publish a room identity", () => {
    expect(
      shouldMergeEpicRoomSwap({ roomId: undefined }, { roomId: "room-a" }),
    ).toBe(false);
  });
});
