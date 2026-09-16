import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import {
  applyComposerHostDocument,
  collectComposerDirtyWrites,
  composerDraftRememberSynced,
  composerDraftRowIsForeign,
  composerSubmittedDraftDeleteIsPending,
  EMPTY_COMPOSER_DRAFT,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  setDraftLocalDeleteListener,
  setDraftLocalEditListener,
} from "@/lib/drafts/draft-local-edits";

const DOC = {
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

afterEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  setDraftLocalEditListener(null);
  setDraftLocalDeleteListener(null);
});

/** Seeds a row this host does not own: adopted elsewhere, as a replica. */
function seedReplicaRow(chatId: string): void {
  useComposerDraftStore.getState().setSnapshot(chatId, DOC, { from: 1, to: 3 });
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[chatId];
    if (current === undefined) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          hostRevision: 5,
          ownerHostId: "host-b",
          origin: "replica",
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 5,
            halted: null,
          },
        },
      },
    };
  });
}

describe("composer draft store: detachDraftIdentity (fork rule)", () => {
  it("mints a fresh draftId, keeps content, sets supersedes to the old id, bumps generation, clears owner/origin/publication, and notifies only the new id", () => {
    const chatId = "chat-detach";
    seedReplicaRow(chatId);
    const before = useComposerDraftStore.getState().drafts[chatId];
    if (before === undefined) throw new Error("expected a seeded row");
    const draftIdBefore = before.draftId;
    const generationBefore = before.generation;
    if (draftIdBefore === null) throw new Error("expected a draftId");

    const editNotifications: string[] = [];
    const deleteNotifications: string[] = [];
    setDraftLocalEditListener((draftId) => editNotifications.push(draftId));
    setDraftLocalDeleteListener((draftId) => deleteNotifications.push(draftId));

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    const after = useComposerDraftStore.getState().drafts[chatId];
    if (after === undefined) throw new Error("expected the row to remain");
    expect(after.content).toEqual(DOC);
    expect(after.draftId).not.toBeNull();
    expect(after.draftId).not.toBe(draftIdBefore);
    expect(after.supersedes).toBe(draftIdBefore);
    expect(after.hostRevision).toBe(0);
    expect(after.ownerHostId).toBeNull();
    expect(after.origin).toBeNull();
    expect(after.publication).toBeNull();
    expect(after.generation).toBe(generationBefore + 1);

    // The fork is a pure re-key: only the new id is notified, and nothing
    // about the ancestor is deleted here (no pending delete, no delete
    // notification) - the host that takes the fork's upsert owns retracting
    // the ancestor's cloud row.
    expect(editNotifications).toEqual([after.draftId]);
    expect(deleteNotifications).toEqual([]);
    expect(composerSubmittedDraftDeleteIsPending(draftIdBefore)).toBe(false);
  });

  it("is a no-op for a chat with no draftId", () => {
    const chatId = "chat-never-typed";
    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    expect(useComposerDraftStore.getState().drafts[chatId]).toBeUndefined();
  });
});

describe("composer draft store: composerDraftRememberSynced clears supersedes on ack", () => {
  it("clears supersedes once the fresh id's first write is acknowledged (hostRevision > 0)", () => {
    const chatId = "chat-remember-synced-ack";
    seedReplicaRow(chatId);
    useComposerDraftStore.getState().detachDraftIdentity(chatId);
    const forked = useComposerDraftStore.getState().drafts[chatId];
    const newId = forked?.draftId ?? null;
    if (newId === null) throw new Error("expected a forked draftId");
    expect(forked?.supersedes).not.toBeNull();

    composerDraftRememberSynced(newId, 1, forked?.generation ?? 0);

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.supersedes).toBeNull();
  });

  it("keeps supersedes while hostRevision is still 0", () => {
    const chatId = "chat-remember-synced-pending";
    seedReplicaRow(chatId);
    useComposerDraftStore.getState().detachDraftIdentity(chatId);
    const forked = useComposerDraftStore.getState().drafts[chatId];
    const newId = forked?.draftId ?? null;
    const supersedesBefore = forked?.supersedes ?? null;
    if (newId === null) throw new Error("expected a forked draftId");
    expect(supersedesBefore).not.toBeNull();

    composerDraftRememberSynced(newId, 0, forked?.generation ?? 0);

    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.supersedes).toBe(supersedesBefore);
  });
});

describe("composer draft store: fenceAndDetachSubmittedDraft clears supersedes so the next identity does not inherit it", () => {
  it("clears supersedes on fence, and a later minted identity starts with none", () => {
    const chatId = "chat-fence-clears-supersedes";
    seedReplicaRow(chatId);
    useComposerDraftStore.getState().detachDraftIdentity(chatId);
    const forked = useComposerDraftStore.getState().drafts[chatId];
    const freshId = forked?.draftId ?? null;
    if (freshId === null) throw new Error("expected a forked draftId");
    expect(forked?.supersedes).not.toBeNull();

    useComposerDraftStore
      .getState()
      .fenceAndDetachSubmittedDraft(chatId, freshId, "host-a");

    const fenced = useComposerDraftStore.getState().drafts[chatId];
    expect(fenced?.supersedes).toBeNull();
    expect(fenced?.draftId).toBeNull();

    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 1 });

    const next = useComposerDraftStore.getState().drafts[chatId];
    expect(next?.supersedes).toBeNull();
    expect(next?.draftId).not.toBe(freshId);
  });
});

function chatComposerDocument(input: {
  readonly chatId: string;
  readonly draftId: string;
  readonly origin: "own" | "replica";
  readonly ownerHostId: string;
  readonly supersedes: string | null;
}): DraftDocument {
  const { chatId, draftId, origin, ownerHostId, supersedes } = input;
  return {
    draftId,
    kind: "chat-composer",
    target: { epicId: "epic-1", chatId, blockId: null },
    revision: 1,
    lastTouchedAt: Date.now(),
    workspace: null,
    ownerHostId,
    origin,
    adoption: { state: "adopted", hostId: ownerHostId },
    supersedes,
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

describe("composer draft store: applyComposerHostDocument re-mint echo", () => {
  it("admits an echo whose document.supersedes names the row's current draftId, re-keying the row to the document's id", () => {
    const chatId = "chat-remint-echo";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    useComposerDraftStore.setState((state) => {
      const current = state.drafts[chatId];
      if (current === undefined) return state;
      return {
        drafts: {
          ...state.drafts,
          [chatId]: { ...current, draftId: "d-old" },
        },
      };
    });

    const applied = applyComposerHostDocument(
      chatComposerDocument({
        chatId,
        draftId: "d-new",
        origin: "own",
        ownerHostId: "host-a",
        supersedes: "d-old",
      }),
    );

    expect(applied).toBe(true);
    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe("d-new");
  });

  it("rejects an unrelated id mismatch that does not name the row's current id as its supersedes", () => {
    const chatId = "chat-unrelated-mismatch";
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, DOC, { from: 1, to: 3 });
    useComposerDraftStore.setState((state) => {
      const current = state.drafts[chatId];
      if (current === undefined) return state;
      return {
        drafts: {
          ...state.drafts,
          [chatId]: { ...current, draftId: "d-current" },
        },
      };
    });

    const applied = applyComposerHostDocument(
      chatComposerDocument({
        chatId,
        draftId: "d-stranger",
        origin: "own",
        ownerHostId: "host-b",
        supersedes: null,
      }),
    );

    expect(applied).toBe(false);
    const after = useComposerDraftStore.getState().drafts[chatId];
    expect(after?.draftId).toBe("d-current");
  });
});

describe("composer draft store: setSelection on a replica row", () => {
  it("updates selection without bumping generation or notifying, and stays out of dirty writes until forked", () => {
    const chatId = "chat-replica-selection";
    seedReplicaRow(chatId);

    const before = useComposerDraftStore.getState().drafts[chatId];
    expect(before?.origin).toBe("replica");
    const generationBefore = before?.generation ?? 0;
    expect(generationBefore).toBeGreaterThan(before?.syncedGeneration ?? 0);

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => notified.push(draftId));

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 2, to: 4 }, "host-a");

    const afterSelection = useComposerDraftStore.getState().drafts[chatId];
    expect(afterSelection?.selection).toEqual({ from: 2, to: 4 });
    expect(afterSelection?.generation).toBe(generationBefore);
    expect(notified).toEqual([]);

    const dirtyBeforeFork = collectComposerDirtyWrites().map(
      (entry) => entry.chatId,
    );
    expect(dirtyBeforeFork).not.toContain(chatId);

    useComposerDraftStore.getState().detachDraftIdentity(chatId);

    const dirtyAfterFork = collectComposerDirtyWrites().map(
      (entry) => entry.chatId,
    );
    expect(dirtyAfterFork).toContain(chatId);
  });
});

/** Seeds an OWN row (not a replica) adopted by another host, and clean. */
function seedOwnRowAdoptedElsewhere(chatId: string): void {
  useComposerDraftStore.getState().setSnapshot(chatId, DOC, { from: 1, to: 3 });
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[chatId];
    if (current === undefined) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          ownerHostId: "host-b",
          origin: null,
          syncedGeneration: current.generation,
          hostRevision: 5,
          publication: {
            status: "current",
            lastPublishedAt: 1,
            publishedRevision: 5,
            halted: null,
          },
        },
      },
    };
  });
}

describe("composer draft store: setSelection on an own row adopted by another host", () => {
  it("keeps the caret write local when the tab's host does not own the row", () => {
    const chatId = "chat-own-adopted-elsewhere";
    seedOwnRowAdoptedElsewhere(chatId);

    const before = useComposerDraftStore.getState().drafts[chatId];
    if (before === undefined) throw new Error("expected a seeded row");
    expect(before.generation).toBe(before.syncedGeneration);
    const draftIdBefore = before.draftId;

    const notified: string[] = [];
    setDraftLocalEditListener((draftId) => notified.push(draftId));

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 2, to: 4 }, "host-a");

    const after = useComposerDraftStore.getState().drafts[chatId];
    if (after === undefined) throw new Error("expected the row to remain");
    expect(after.selection).toEqual({ from: 2, to: 4 });
    expect(after.generation).toBe(before.generation);
    expect(notified).toEqual([]);
    expect(
      collectComposerDirtyWrites().map((entry) => entry.chatId),
    ).not.toContain(chatId);
    expect(after.draftId).toBe(draftIdBefore);
  });

  it("goes through the normal local-edit path when the tab's host is the row's own host", () => {
    const chatId = "chat-own-adopted-elsewhere-own-host";
    seedOwnRowAdoptedElsewhere(chatId);

    const before = useComposerDraftStore.getState().drafts[chatId];
    if (before === undefined) throw new Error("expected a seeded row");

    useComposerDraftStore
      .getState()
      .setSelection(chatId, { from: 2, to: 4 }, "host-b");

    const after = useComposerDraftStore.getState().drafts[chatId];
    if (after === undefined) throw new Error("expected the row to remain");
    expect(after.selection).toEqual({ from: 2, to: 4 });
    expect(after.generation).toBe(before.generation + 1);
    expect(collectComposerDirtyWrites().map((entry) => entry.chatId)).toContain(
      chatId,
    );
  });
});

describe("composerDraftRowIsForeign", () => {
  it("is true for a replica row regardless of ownerHostId", () => {
    expect(
      composerDraftRowIsForeign(
        { ...EMPTY_COMPOSER_DRAFT, origin: "replica", ownerHostId: "host-a" },
        "host-a",
      ),
    ).toBe(true);
  });

  it("is true for an own row owned by a different host", () => {
    expect(
      composerDraftRowIsForeign(
        { ...EMPTY_COMPOSER_DRAFT, origin: null, ownerHostId: "host-b" },
        "host-a",
      ),
    ).toBe(true);
  });

  it("is false for an own row owned by the tab's own host", () => {
    expect(
      composerDraftRowIsForeign(
        { ...EMPTY_COMPOSER_DRAFT, origin: null, ownerHostId: "host-a" },
        "host-a",
      ),
    ).toBe(false);
  });

  it("is false when ownerHostId is null", () => {
    expect(
      composerDraftRowIsForeign(
        { ...EMPTY_COMPOSER_DRAFT, origin: null, ownerHostId: null },
        "host-a",
      ),
    ).toBe(false);
  });
});
