import { afterEach, describe, expect, it } from "vitest";
import { scopedPersistKey, STORE_KEYS } from "@/lib/persist";
import {
  pendingLandingDraftDeletesForHost,
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
  retireLandingDraftForRetract,
} from "@/lib/drafts/landing-draft-retirement";

function writeOldShapeReceipt(
  draftId: string,
  receipt: {
    readonly hostId: string | null;
    readonly pendingDelete: boolean;
    readonly ownerResolved: boolean;
  },
): void {
  window.localStorage.setItem(
    scopedPersistKey(
      STORE_KEYS.landingDraftRetirement,
      encodeURIComponent(draftId),
    ),
    JSON.stringify(receipt),
  );
}

afterEach(() => {
  resetLandingDraftRetirementsForTests();
});

describe("landing draft retirement: retract field", () => {
  it("an old-shape receipt with no retract field reads back as a plain delete", () => {
    const draftId = "old-shape-receipt";
    writeOldShapeReceipt(draftId, {
      hostId: "host-a",
      pendingDelete: true,
      ownerResolved: true,
    });

    expect(pendingLandingDraftDeletesForHost("host-a")).toEqual([
      { draftId, retract: false },
    ]);
  });

  it("retireLandingDraftForRetract leaves an already-pending delete alone", () => {
    const draftId = "already-pending-delete";
    retireLandingDraft(draftId, "host-a");

    retireLandingDraftForRetract(draftId, "host-b");

    expect(pendingLandingDraftDeletesForHost("host-a")).toEqual([
      { draftId, retract: false },
    ]);
    expect(pendingLandingDraftDeletesForHost("host-b")).toEqual([]);
  });

  it("retireLandingDraftForRetract turns a completed (owner-unknown) receipt into a pending retract on the given host", () => {
    const draftId = "owner-unknown-then-retract";
    retireLandingDraft(draftId, null);
    expect(pendingLandingDraftDeletesForHost("host-c")).toEqual([]);

    retireLandingDraftForRetract(draftId, "host-c");

    expect(pendingLandingDraftDeletesForHost("host-c")).toEqual([
      { draftId, retract: true },
    ]);
  });
});
