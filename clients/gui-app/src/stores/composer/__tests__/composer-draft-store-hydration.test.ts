import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyComposerDraftId } from "@/lib/drafts/draft-ids";

import {
  pendingSubmittedDraftDeletesForHost,
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type DraftState,
} from "../composer-draft-store";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";

const MENTION_DRAFT: DraftState = {
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "mention",
            attrs: {
              contextType: "file",
              id: "/abs/src/index.ts",
              path: "src/index.ts",
              pathKind: "file",
              relPath: "src/index.ts",
              absolutePath: "/abs/src/index.ts",
              workspacePath: "/abs",
              label: "index.ts",
              description: "src/index.ts",
            },
          },
          { type: "text", text: " trailing" },
        ],
      },
    ],
  },
  selection: null,
  browserAnnotations: [],
  resetEpoch: 0,
  revision: 0,
  draftId: null,
  hostRevision: 0,
  targetEpicId: null,
  lastTouchedAt: 0,
  generation: 0,
  syncedGeneration: 0,
  ownerHostId: null,
  origin: null,
  supersedes: null,
  publication: null,
  chatTitle: null,
  epicTitle: null,
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
});

const EMPTY_DOC: DraftState["content"] = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
const EMPTY_SELECTION: DraftState["selection"] = { from: 1, to: 1 };

describe("composer draft store hydration", () => {
  it("bumps resetEpoch on every persisted draft after hydration so editors push the JSON into Tiptap", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { drafts: { task1: MENTION_DRAFT } },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const draft = useComposerDraftStore.getState().drafts.task1;
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.resetEpoch).toBe(1);
    const mention = draft.content.content?.[0]?.content?.[0];
    expect(mention?.type).toBe("mention");
    expect(mention?.attrs?.path).toBe("src/index.ts");
  });

  it("leaves drafts map empty on first-ever load", async () => {
    await useComposerDraftStore.persist.rehydrate();
    expect(useComposerDraftStore.getState().drafts).toEqual({});
  });

  it("returns a stable empty draft snapshot without creating store state", () => {
    const notify = vi.fn();
    const unsubscribe = useComposerDraftStore.subscribe(notify);

    const first = readComposerDraftSnapshot("missing-task");
    const second = readComposerDraftSnapshot("missing-task");

    unsubscribe();
    expect(first).toBe(second);
    expect(first.browserAnnotations).toBe(second.browserAnnotations);
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps an explicit draftId null through hydration", async () => {
    // `detachSubmittedDraft` writes null so the NEXT edit mints a fresh host
    // row; resurrecting the derived legacy id here would publish new content
    // under the row being tombstoned.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            detached: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: null,
            },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();
    expect(useComposerDraftStore.getState().drafts.detached?.draftId).toBe(
      null,
    );
  });

  it("gives a legacy draft the same id in every window that hydrates it", async () => {
    // `merge` output is never persisted back, so a second window hydrates
    // the same id-less legacy draft again. A minted id would differ per
    // window and both would publish; the derived id converges.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            legacy: { content: MENTION_DRAFT.content, selection: null },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();
    const first = useComposerDraftStore.getState().drafts.legacy?.draftId;
    await useComposerDraftStore.persist.rehydrate();
    const second = useComposerDraftStore.getState().drafts.legacy?.draftId;

    expect(first).toBe(legacyComposerDraftId("legacy"));
    expect(second).toBe(first);
  });

  it("drops malformed entries and safely hydrates a legacy draft missing resetEpoch", async () => {
    const legacyDraft = {
      content: MENTION_DRAFT.content,
      selection: null,
      revision: 3,
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            nullEntry: null,
            malformedEntry: { content: null, selection: null },
            legacy: legacyDraft,
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const hydrated = useComposerDraftStore.getState().drafts.legacy;
    expect(hydrated).toBeDefined();
    if (hydrated === undefined) return;
    if (hydrated.draftId === null) {
      throw new Error("legacy hydration must mint a draftId");
    }
    expect(hydrated.draftId.length).toBeGreaterThan(0);
    expect(hydrated).toEqual({
      content: MENTION_DRAFT.content,
      selection: null,
      browserAnnotations: [],
      revision: 3,
      resetEpoch: 1,
      draftId: hydrated.draftId,
      hostRevision: 0,
      targetEpicId: null,
      lastTouchedAt: 0,
      generation: 1,
      syncedGeneration: 0,
      ownerHostId: null,
      origin: null,
      supersedes: null,
      publication: null,
      chatTitle: null,
      epicTitle: null,
    });
  });

  it("rehydrates a submitted-draft deletion fence after renderer restart", async () => {
    useComposerDraftStore
      .getState()
      .setSnapshot("chat-fenced", MENTION_DRAFT.content, null);
    const draftId =
      useComposerDraftStore.getState().drafts["chat-fenced"]?.draftId;
    if (draftId === null || draftId === undefined) {
      throw new Error("draft id was not minted");
    }
    useComposerDraftStore
      .getState()
      .fenceAndDetachSubmittedDraft("chat-fenced", draftId, "host-a");
    const persisted = window.localStorage.getItem(STORAGE_KEY);
    expect(persisted).not.toBeNull();

    useComposerDraftStore.setState({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
    });
    if (persisted !== null) window.localStorage.setItem(STORAGE_KEY, persisted);
    await useComposerDraftStore.persist.rehydrate();

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId],
    ).toEqual({ hostId: "host-a", retract: false });
  });

  // The store persists whatever id a row carries on its next write, so a
  // legacy draft that was edited or acknowledged before the derivation
  // changed has the retired `legacy-composer-<key>` form on disk. The host
  // re-keyed its row to the uuid v5; a persisted row that kept the old id
  // would reject that document as foreign and re-send the long id.
  it("maps a persisted legacy-composer-prefixed id, its supersedes pointer and its delete fence to the uuid v5 form", async () => {
    const legacy = "legacy-composer-7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90";
    const derived = "de1163cc-8dfa-5d11-9ad0-a350cc095612";
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            edited: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: legacy,
              hostRevision: 2,
            },
            forkedFromLegacy: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: "d-fork",
              supersedes: legacy,
            },
            detached: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: null,
            },
            minted: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: "d-minted",
            },
          },
          pendingSubmittedDraftDeletes: {
            [legacy]: { hostId: "host-a", retract: false },
            "d-other": { hostId: "host-b", retract: true },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const state = useComposerDraftStore.getState();
    expect(state.drafts.edited?.draftId).toBe(derived);
    expect(state.drafts.edited?.draftId).toBe(
      legacyComposerDraftId("7f1c1d2a-9b4e-4d8e-8f2a-3c5b6d7e8f90"),
    );
    expect(state.drafts.edited?.hostRevision).toBe(2);
    expect(state.drafts.forkedFromLegacy?.supersedes).toBe(derived);
    expect(state.drafts.detached?.draftId).toBeNull();
    expect(state.drafts.minted?.draftId).toBe("d-minted");
    expect(state.pendingSubmittedDraftDeletes).toEqual({
      [derived]: { hostId: "host-a", retract: false },
      "d-other": { hostId: "host-b", retract: true },
    });
  });

  it("hydrates a persisted supersedes value, and treats an absent one as null", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            forked: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: "d-new",
              supersedes: "d-old",
            },
            plain: {
              content: MENTION_DRAFT.content,
              selection: null,
              draftId: "d-plain",
            },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const drafts = useComposerDraftStore.getState().drafts;
    expect(drafts.forked?.supersedes).toBe("d-old");
    expect(drafts.plain?.supersedes).toBeNull();
  });
});

describe("composer draft store: pending submitted draft retract entries", () => {
  it("hydrates a persisted pendingSubmittedDraftDeletes entry missing retract to retract: false", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {},
          pendingSubmittedDraftDeletes: {
            "legacy-pending-delete": { hostId: "host-a" },
          },
        },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[
        "legacy-pending-delete"
      ],
    ).toEqual({ hostId: "host-a", retract: false });
  });

  it("recordPendingSubmittedDraftRetract leaves an existing entry as is", () => {
    useComposerDraftStore.setState({
      pendingSubmittedDraftDeletes: {
        "already-pending": { hostId: "host-a", retract: false },
      },
    });

    useComposerDraftStore
      .getState()
      .recordPendingSubmittedDraftRetract("already-pending", "host-b");

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[
        "already-pending"
      ],
    ).toEqual({ hostId: "host-a", retract: false });
  });

  it("recordPendingSubmittedDraftRetract on a fresh id writes a pending retract", () => {
    useComposerDraftStore
      .getState()
      .recordPendingSubmittedDraftRetract("fresh-retract", "host-a");

    expect(
      useComposerDraftStore.getState().pendingSubmittedDraftDeletes[
        "fresh-retract"
      ],
    ).toEqual({ hostId: "host-a", retract: true });
  });

  it("pendingSubmittedDraftDeletesForHost lists both a delete and a retract entry with their kinds", () => {
    useComposerDraftStore.setState({
      pendingSubmittedDraftDeletes: {
        "delete-entry": { hostId: "host-a", retract: false },
        "retract-entry": { hostId: "host-a", retract: true },
        "other-host-entry": { hostId: "host-b", retract: true },
      },
    });

    expect(pendingSubmittedDraftDeletesForHost("host-a")).toEqual([
      { draftId: "delete-entry", retract: false },
      { draftId: "retract-entry", retract: true },
    ]);
  });
});

/**
 * clearDraft must broadcast via replaceDraft (empty content + bumped
 * resetEpoch) rather than deleting the map entry. A delete leaves every
 * other mounted composer for the same taskId with a stale Tiptap document
 * because `drafts[taskId]?.resetEpoch ?? 0` is observationally identical
 * before and after a delete of an epoch-0 entry.
 */
describe("composer draft store clearDraft", () => {
  it("resets the entry in place with empty content and a bumped resetEpoch (does not delete)", () => {
    const taskId = "task-clear-1";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, MENTION_DRAFT.content, {
        from: 1,
        to: 1,
      });
    const before = useComposerDraftStore.getState().drafts[taskId];
    expect(before).toBeDefined();
    if (before === undefined) return;
    expect(before.resetEpoch).toBe(0);

    useComposerDraftStore.getState().clearDraft(taskId);

    const after = useComposerDraftStore.getState().drafts[taskId];
    expect(after).toBeDefined();
    if (after === undefined) return;
    // Entry must remain so every mounted useChatComposerDraft can observe
    // the epoch change (old clearDraft deleted the key instead).
    expect(taskId in useComposerDraftStore.getState().drafts).toBe(true);
    expect(after.content).toEqual(EMPTY_DOC);
    expect(after.selection).toEqual(EMPTY_SELECTION);
    expect(after.resetEpoch).toBe(before.resetEpoch + 1);
  });

  it("bumps resetEpoch on every successive clear of the same taskId", () => {
    const taskId = "task-clear-2";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, MENTION_DRAFT.content, null);

    useComposerDraftStore.getState().clearDraft(taskId);
    const first = useComposerDraftStore.getState().drafts[taskId];
    expect(first?.resetEpoch).toBe(1);

    // Clear again while already empty: a sibling that applied epoch 1 must
    // still observe the second broadcast.
    useComposerDraftStore.getState().clearDraft(taskId);
    const second = useComposerDraftStore.getState().drafts[taskId];
    expect(second?.resetEpoch).toBe(2);
    expect(second?.content).toEqual(EMPTY_DOC);
  });
});

/**
 * Compare-and-swap token: `revision` must bump on real content changes and
 * external replacements, but NOT on caret-only selection updates or on the
 * hydration-time resetEpoch bump.
 */
describe("composer draft store revision (CAS token)", () => {
  it("bumps revision on setSnapshot; selection-only uses setSelection", () => {
    const taskId = "task-revision-1";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, MENTION_DRAFT.content, { from: 1, to: 1 });
    const afterContent = useComposerDraftStore.getState().drafts[taskId];
    expect(afterContent?.revision).toBe(1);

    // Caret-only: goes through setSelection under the event-driven contract.
    // setSnapshot is reserved for real document mutations and always bumps.
    useComposerDraftStore
      .getState()
      .setSelection(taskId, { from: 3, to: 3 }, "host-a");
    const afterSelection = useComposerDraftStore.getState().drafts[taskId];
    expect(afterSelection?.revision).toBe(1);
    expect(afterSelection?.selection).toEqual({ from: 3, to: 3 });
  });

  it("always bumps revision on replaceDraft / clearDraft", () => {
    const taskId = "task-revision-2";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, MENTION_DRAFT.content, null);
    const afterSet = useComposerDraftStore.getState().drafts[taskId];
    expect(afterSet?.revision).toBe(1);

    useComposerDraftStore
      .getState()
      .replaceDraft(taskId, EMPTY_DOC, EMPTY_SELECTION);
    const afterReplace = useComposerDraftStore.getState().drafts[taskId];
    expect(afterReplace?.revision).toBe(2);
    expect(afterReplace?.resetEpoch).toBe(1);

    useComposerDraftStore.getState().clearDraft(taskId);
    const afterClear = useComposerDraftStore.getState().drafts[taskId];
    expect(afterClear?.revision).toBe(3);
    expect(afterClear?.resetEpoch).toBe(2);
  });

  it("does not bump a finite revision on hydration finish (only resetEpoch)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { drafts: { task1: { ...MENTION_DRAFT, revision: 7 } } },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const draft = useComposerDraftStore.getState().drafts.task1;
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.resetEpoch).toBe(1);
    // A finite pre-existing revision is preserved (not bumped); only
    // missing/NaN values are normalized to 0.
    expect(draft.revision).toBe(7);
  });

  it("normalizes a legacy draft missing revision so CAS is not permanently NaN-poisoned", async () => {
    // Pre-migration localStorage: DraftState had no `revision` field.
    // Build JSON by hand so the key is truly absent (not `"revision": null`).
    const legacyDraft = {
      content: MENTION_DRAFT.content,
      selection: null,
      resetEpoch: 0,
    };
    expect("revision" in legacyDraft).toBe(false);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { drafts: { "legacy-task": legacyDraft } },
      }),
    );

    await useComposerDraftStore.persist.rehydrate();

    const draft = useComposerDraftStore.getState().drafts["legacy-task"];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    // (a) normalized to 0 — not undefined, not NaN.
    expect(draft.revision).toBe(0);
    expect(Number.isNaN(draft.revision)).toBe(false);
    expect(draft.resetEpoch).toBe(1);

    // (b) a real content change bumps 0 → 1 (not NaN).
    useComposerDraftStore
      .getState()
      .setSnapshot("legacy-task", EMPTY_DOC, EMPTY_SELECTION);
    const afterEdit = useComposerDraftStore.getState().drafts["legacy-task"];
    expect(afterEdit?.revision).toBe(1);
    expect(Number.isNaN(afterEdit?.revision)).toBe(false);

    // (c) full CAS round-trip can succeed: capture, no mutation, token still matches.
    const captured = readComposerDraftSnapshot("legacy-task");
    expect(captured.revision).toBe(1);
    expect(captured.revision).toBe(
      readComposerDraftSnapshot("legacy-task").revision,
    );
    // clearDraft via replaceDraft would clear; here we only prove equality
    // still works (NaN !== NaN would make this permanently fail).
    expect(
      captured.revision === readComposerDraftSnapshot("legacy-task").revision,
    ).toBe(true);
  });
});
