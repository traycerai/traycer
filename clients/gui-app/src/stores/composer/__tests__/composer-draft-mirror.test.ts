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
    // Typed, not `EMPTY`: an empty draft with no host row is withheld by its
    // own rule (`isUnbackedEmptyComposerDraft`), which would make the
    // `targetEpicId` gate below pass for the wrong reason.
    useComposerDraftStore.getState().setSnapshot("chat-1", TYPED, null);
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

/**
 * `collectComposerDirtyWrites` withholds a dirty draft that is EMPTY and has
 * never been typed into (`revision === 0`): a caret move alone mints a
 * `draftId` and bumps `generation`, so publishing it would mint a cloud row
 * for an idle composer - the "Untitled draft" junk rows the fix removes.
 *
 * The gate is keyed on `revision`, not on "has no host row yet": a draft whose
 * first upsert committed with its reply lost still reads `hostRevision === 0`,
 * and keying on that would withhold its erasure forever while the cloud went
 * on serving the deleted content.
 */
describe("collectComposerDirtyWrites: never-typed empty draft gate", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
  });

  afterEach(() => {
    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
  });

  it("does not collect a dirty draft that is empty and has never been typed into", () => {
    useComposerDraftStore.setState({
      drafts: {
        "chat-empty": {
          content: EMPTY,
          selection: null,
          browserAnnotations: [],
          resetEpoch: 0,
          // A caret move alone: `generation` bumped, `revision` did not.
          revision: 0,
          draftId: "draft-empty",
          hostRevision: 0,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 0,
          ownerHostId: null,
          origin: null,
          publication: null,
        },
      },
    });

    expect(collectComposerDirtyWrites()).toEqual([]);
  });

  it("collects the same draft once it has typed content", () => {
    useComposerDraftStore.setState({
      drafts: {
        "chat-empty": {
          content: TYPED,
          selection: null,
          browserAnnotations: [],
          resetEpoch: 0,
          revision: 1,
          draftId: "draft-empty",
          hostRevision: 0,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 0,
          ownerHostId: null,
          origin: null,
          publication: null,
        },
      },
    });

    const dirty = collectComposerDirtyWrites();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.chatId).toBe("chat-empty");
    expect(dirty[0]?.draft.content).toEqual(TYPED);
  });

  // The lost-ACK case: typed once (so `revision` moved), that first upsert
  // committed on the host but its reply never arrived (so `hostRevision` is
  // still 0), then erased. A gate keyed on `hostRevision` would withhold this
  // forever and leave the deleted content published.
  it("still collects an erased draft whose first upsert never acked", () => {
    useComposerDraftStore.setState({
      drafts: {
        "chat-synced": {
          content: EMPTY,
          selection: null,
          browserAnnotations: [],
          resetEpoch: 1,
          revision: 2,
          draftId: "draft-synced",
          hostRevision: 0,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 2,
          syncedGeneration: 1,
          ownerHostId: "host-a",
          origin: "own",
          publication: null,
        },
      },
    });

    const dirty = collectComposerDirtyWrites();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.chatId).toBe("chat-synced");
    expect(dirty[0]?.draft.content).toEqual(EMPTY);
  });
});
