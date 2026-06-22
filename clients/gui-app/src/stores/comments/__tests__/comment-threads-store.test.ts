import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

function resetStore(): void {
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
}

describe("useCommentThreadsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("activates a thread per epic without leaking across epics", () => {
    useCommentThreadsStore.getState().setActiveThread("epic-a", "t1");
    expect(useCommentThreadsStore.getState().activeByEpicId["epic-a"]).toBe(
      "t1",
    );
    expect(
      useCommentThreadsStore.getState().activeByEpicId["epic-b"],
    ).toBeUndefined();
  });

  it("clears the active thread with null", () => {
    useCommentThreadsStore.getState().setActiveThread("epic-a", "t1");
    useCommentThreadsStore.getState().setActiveThread("epic-a", null);
    expect(
      useCommentThreadsStore.getState().activeByEpicId["epic-a"],
    ).toBeNull();
  });

  it("tracks hover thread independent of active thread", () => {
    useCommentThreadsStore.getState().setActiveThread("epic-a", "t1");
    useCommentThreadsStore.getState().setHoverThread("epic-a", "t2");
    expect(useCommentThreadsStore.getState().activeByEpicId["epic-a"]).toBe(
      "t1",
    );
    expect(useCommentThreadsStore.getState().hoverByEpicId["epic-a"]).toBe(
      "t2",
    );
  });

  it("tracks flash thread with a nonce so stale clears cannot remove a newer flash", () => {
    useCommentThreadsStore.getState().setFlashThread("epic-a", "t1");
    const firstFlash =
      useCommentThreadsStore.getState().flashByEpicId["epic-a"];
    expect(firstFlash?.threadId).toBe("t1");

    useCommentThreadsStore.getState().setFlashThread("epic-a", "t2");
    const secondFlash =
      useCommentThreadsStore.getState().flashByEpicId["epic-a"];
    expect(secondFlash?.threadId).toBe("t2");
    expect(secondFlash?.nonce).not.toBe(firstFlash?.nonce);

    useCommentThreadsStore
      .getState()
      .clearFlashThread("epic-a", firstFlash?.nonce ?? -1);
    expect(useCommentThreadsStore.getState().flashByEpicId["epic-a"]).toEqual(
      secondFlash,
    );

    useCommentThreadsStore
      .getState()
      .clearFlashThread("epic-a", secondFlash?.nonce ?? -1);
    expect(
      useCommentThreadsStore.getState().flashByEpicId["epic-a"],
    ).toBeNull();
  });

  it("setDraft + clearDraft round-trip per epic", () => {
    const draft = {
      tileId: "tile-a",
      artifactId: "spec-a",
      from: 4,
      to: 12,
      quotedText: "hello world",
    };
    useCommentThreadsStore.getState().setDraft("epic-a", draft);
    expect(useCommentThreadsStore.getState().draftByEpicId["epic-a"]).toEqual(
      draft,
    );

    useCommentThreadsStore.getState().clearDraft("epic-a");
    expect(
      useCommentThreadsStore.getState().draftByEpicId["epic-a"],
    ).toBeNull();
  });

  it("setActiveThread is a no-op when the value is unchanged", () => {
    useCommentThreadsStore.getState().setActiveThread("epic-a", "t1");
    const beforeSlice = useCommentThreadsStore.getState().activeByEpicId;
    useCommentThreadsStore.getState().setActiveThread("epic-a", "t1");
    expect(useCommentThreadsStore.getState().activeByEpicId).toBe(beforeSlice);
  });

  it("setCurrentArtifact tracks the comments-scoped artifact per epic", () => {
    useCommentThreadsStore.getState().setCurrentArtifact("epic-a", "spec-x");
    expect(useCommentThreadsStore.getState().artifactByEpicId["epic-a"]).toBe(
      "spec-x",
    );

    useCommentThreadsStore.getState().setCurrentArtifact("epic-a", null);
    expect(
      useCommentThreadsStore.getState().artifactByEpicId["epic-a"],
    ).toBeNull();
  });
});
