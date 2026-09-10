import { describe, expect, it } from "vitest";
import { clientDraftSubscribeFrameApplies } from "@/lib/drafts/draft-subscribe-apply";

const FRAME = { revision: 4, storeSeq: 21 };

describe("clientDraftSubscribeFrameApplies", () => {
  it("never treats omitted list state as apply-any: equal storeSeq is dropped", () => {
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "absent" },
        frame: FRAME,
        snapshotSeq: 21,
        localDirty: false,
      }),
    ).toBe(false);
  });

  it("admits an absent id only when storeSeq is strictly newer than snapshotSeq", () => {
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "absent" },
        frame: FRAME,
        snapshotSeq: 20,
        localDirty: false,
      }),
    ).toBe(true);
  });

  it("applies a present row only when frame.revision is strictly greater", () => {
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "row", revision: 3 },
        frame: FRAME,
        snapshotSeq: 0,
        localDirty: false,
      }),
    ).toBe(true);
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "row", revision: 4 },
        frame: FRAME,
        snapshotSeq: 0,
        localDirty: false,
      }),
    ).toBe(false);
  });

  it("applies a tombstone by revision, not by omitted-list identity", () => {
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "tombstone", revision: 3, storeSeq: 10 },
        frame: FRAME,
        snapshotSeq: 100,
        localDirty: false,
      }),
    ).toBe(true);
  });

  it("skips even a newer frame while the local copy is dirty", () => {
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "row", revision: 3 },
        frame: FRAME,
        snapshotSeq: 0,
        localDirty: true,
      }),
    ).toBe(false);
    expect(
      clientDraftSubscribeFrameApplies({
        held: { kind: "absent" },
        frame: FRAME,
        snapshotSeq: 0,
        localDirty: true,
      }),
    ).toBe(false);
  });
});
