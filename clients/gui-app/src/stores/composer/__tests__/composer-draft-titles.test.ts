import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const CHAT_ID = "chat-titles";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function readRow() {
  const row = useComposerDraftStore.getState().drafts[CHAT_ID];
  if (row === undefined) throw new Error("missing composer draft");
  return row;
}

function resetStore(): void {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
}

describe("setComposerDraftTitles", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("writes only the two title fields - no generation, revision, lastTouchedAt or draftId movement", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("unsent"), { from: 1, to: 7 });
    const before = readRow();

    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, "Fix the parser", "Compiler work");

    const after = readRow();
    expect(after.chatTitle).toBe("Fix the parser");
    expect(after.epicTitle).toBe("Compiler work");
    expect(after.generation).toBe(before.generation);
    expect(after.revision).toBe(before.revision);
    expect(after.resetEpoch).toBe(before.resetEpoch);
    expect(after.lastTouchedAt).toBe(before.lastTouchedAt);
    expect(after.draftId).toBe(before.draftId);
    expect(after.content).toEqual(before.content);
  });

  it("is a no-op when both values already match - the row object is not even replaced", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("unsent"), { from: 1, to: 7 });
    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, "Same chat", "Same epic");
    const before = readRow();

    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, "Same chat", "Same epic");

    // Same reference: a re-render of every mounted composer for this chat on
    // each tile mount is exactly what the compare-first rule exists to avoid.
    expect(readRow()).toBe(before);
  });

  it("does not create a row for a chat that has none - an untyped composer stays unpublishable", () => {
    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, "Fix the parser", "Compiler work");

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]).toBeUndefined();
  });

  it("clears a title back to null when the projector no longer has one", () => {
    useComposerDraftStore
      .getState()
      .setSnapshot(CHAT_ID, typed("unsent"), { from: 1, to: 7 });
    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, "Fix the parser", "Compiler work");

    useComposerDraftStore
      .getState()
      .setComposerDraftTitles(CHAT_ID, null, null);

    expect(readRow().chatTitle).toBeNull();
    expect(readRow().epicTitle).toBeNull();
  });
});
