/**
 * The landing owner store forgets a draft's pick once its create is sent.
 *
 * `clearChoice` must remove the draft's key, leave every other draft's pick
 * alone, and tolerate an absent key; `migrateChoice` carries the pre-draft
 * pick (the `""` key) onto the draft's new id.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useLandingOwnerStore } from "@/stores/home/landing-owner-store";

describe("useLandingOwnerStore", () => {
  beforeEach(() => {
    useLandingOwnerStore.setState({ byDraftId: {} });
  });

  it("clearChoice removes the draft's key", () => {
    useLandingOwnerStore
      .getState()
      .setChoice("d1", { kind: "team", teamId: "t1" });
    expect(Object.hasOwn(useLandingOwnerStore.getState().byDraftId, "d1")).toBe(
      true,
    );

    useLandingOwnerStore.getState().clearChoice("d1");

    expect(Object.hasOwn(useLandingOwnerStore.getState().byDraftId, "d1")).toBe(
      false,
    );
    expect(useLandingOwnerStore.getState().byDraftId).toEqual({});
  });

  it("clearChoice of an absent key leaves the other drafts' picks intact", () => {
    useLandingOwnerStore
      .getState()
      .setChoice("d1", { kind: "team", teamId: "t1" });
    useLandingOwnerStore.getState().setChoice("d2", { kind: "personal" });

    useLandingOwnerStore.getState().clearChoice("missing");

    expect(useLandingOwnerStore.getState().byDraftId).toEqual({
      d1: { kind: "team", teamId: "t1" },
      d2: { kind: "personal" },
    });
  });

  it("clearChoice of one draft leaves the others' picks intact", () => {
    useLandingOwnerStore
      .getState()
      .setChoice("d1", { kind: "team", teamId: "t1" });
    useLandingOwnerStore.getState().setChoice("d2", { kind: "personal" });

    useLandingOwnerStore.getState().clearChoice("d1");

    expect(useLandingOwnerStore.getState().byDraftId).toEqual({
      d2: { kind: "personal" },
    });
  });

  it("migrateChoice moves the pre-draft pick onto the new draft id and removes the empty key", () => {
    useLandingOwnerStore
      .getState()
      .setChoice("", { kind: "team", teamId: "t1" });

    useLandingOwnerStore.getState().migrateChoice("", "d2");

    const { byDraftId } = useLandingOwnerStore.getState();
    expect(byDraftId.d2).toEqual({ kind: "team", teamId: "t1" });
    expect(Object.hasOwn(byDraftId, "")).toBe(false);
  });
});
