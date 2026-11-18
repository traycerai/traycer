import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useAnchoredDraftStore,
  type AnchoredCommentDraft,
} from "@/stores/comments/anchored-draft-store";

function resetStore(): void {
  useAnchoredDraftStore.setState({ byEpicId: {} });
}

function makeDraft(draftId: string): AnchoredCommentDraft {
  return {
    draftId,
    tileId: "tile-1",
    artifactId: "artifact-1",
    artifactType: "html",
    anchor: { kind: "artifact" },
    quotedText: "",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    selection: null,
    retargeted: false,
  };
}

describe("useAnchoredDraftStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("keeps a separate draft per epic", () => {
    const store = useAnchoredDraftStore.getState();
    store.setDraft("epic-a", makeDraft("draft-a"));
    store.setDraft("epic-b", makeDraft("draft-b"));
    store.updateDraft("epic-a", "draft-a", { quotedText: "edited" });
    store.clearDraft("epic-b", "draft-b");

    const { byEpicId } = useAnchoredDraftStore.getState();
    expect(byEpicId["epic-a"]?.quotedText).toBe("edited");
    expect(byEpicId["epic-b"]).toBeUndefined();
  });

  it("applies an update only to the draft with that id", () => {
    const store = useAnchoredDraftStore.getState();
    store.setDraft("epic-a", makeDraft("current"));
    store.updateDraft("epic-a", "stale", { quotedText: "late write" });

    expect(
      useAnchoredDraftStore.getState().byEpicId["epic-a"]?.quotedText,
    ).toBe("");
  });

  it("clears only the draft with that id", () => {
    const store = useAnchoredDraftStore.getState();
    store.setDraft("epic-a", makeDraft("current"));
    store.clearDraft("epic-a", "stale");

    expect(useAnchoredDraftStore.getState().byEpicId["epic-a"]?.draftId).toBe(
      "current",
    );
  });
});
