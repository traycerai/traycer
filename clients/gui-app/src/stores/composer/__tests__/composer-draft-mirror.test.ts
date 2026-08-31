import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindComposerDraftHost,
  collectDraftMirrorDirtyWrites,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  collectComposerDirtyWrites,
  applyComposerHostDelete,
  dropComposerAbsentFromList,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

const EMPTY = {
  type: "doc" as const,
  content: [{ type: "paragraph" }],
};

const TYPED = {
  type: "doc" as const,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "keep me" }] },
  ],
};

describe("composer draft host-mirror bookkeeping", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
    resetDraftMirrorCoordinatorForTests();
  });

  afterEach(() => {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
    resetDraftMirrorCoordinatorForTests();
  });

  it("renames the store key to chatId and withholds upserts until targetEpicId is bound", () => {
    bindComposerDraftHost("chat-1", "host-a");
    useComposerDraftStore.getState().setSnapshot("chat-1", EMPTY, null);
    expect(collectDraftMirrorDirtyWrites("host-a")).toEqual([]);
    useComposerDraftStore.getState().bindTarget("chat-1", "epic-1");
    const dirty = collectDraftMirrorDirtyWrites("host-a");
    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.write.kind).toBe("chat-composer");
    expect(dirty[0]?.write.target.epicId).toBe("epic-1");
    expect(dirty[0]?.write.target.chatId).toBe("chat-1");
    expect(collectComposerDirtyWrites()[0]?.chatId).toBe("chat-1");
  });

  it("does not clear typed content when another host's list omits the draft", () => {
    useComposerDraftStore.setState({
      drafts: {
        "chat-x": {
          content: TYPED,
          selection: { from: 1, to: 8 },
          browserAnnotations: [],
          resetEpoch: 3,
          revision: 2,
          draftId: "draft-x",
          hostRevision: 4,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 1,
          ownerHostId: null,
          origin: null,
          publication: null,
        },
      },
    });
    dropComposerAbsentFromList(
      "host-b",
      new Set(),
      new Map([["chat-x", "host-a"]]),
    );
    const draft = useComposerDraftStore.getState().drafts["chat-x"];
    expect(draft?.content).toEqual(TYPED);
    expect(draft?.resetEpoch).toBe(3);
    expect(draft?.hostRevision).toBe(4);
  });

  it("clears a stale second-window editor when the host delete frame arrives", () => {
    useComposerDraftStore.getState().setSnapshot("chat-window-b", TYPED, {
      from: 1,
      to: 8,
    });
    const before = useComposerDraftStore.getState().drafts["chat-window-b"];
    if (before?.draftId === null || before?.draftId === undefined) {
      throw new Error("missing draft id");
    }

    applyComposerHostDelete(before.draftId);

    const after = useComposerDraftStore.getState().drafts["chat-window-b"];
    expect(after?.content).toEqual(EMPTY);
    expect(after?.resetEpoch).toBe(before.resetEpoch + 1);
  });
});
