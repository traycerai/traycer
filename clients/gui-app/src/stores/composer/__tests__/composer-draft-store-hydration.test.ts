import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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
  resetEpoch: 0,
  revision: 0,
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {} });
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

    expect(useComposerDraftStore.getState().drafts).toEqual({
      legacy: {
        ...legacyDraft,
        resetEpoch: 1,
      },
    });
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
 * Prompt-stash CAS token: `revision` must bump on real content changes and
 * external replacements, but NOT on caret-only selection updates or on the
 * hydration-time resetEpoch bump.
 */
describe("composer draft store revision (prompt-stash CAS)", () => {
  it("bumps revision on setSnapshot; selection-only uses setSelection", () => {
    const taskId = "task-revision-1";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, MENTION_DRAFT.content, { from: 1, to: 1 });
    const afterContent = useComposerDraftStore.getState().drafts[taskId];
    expect(afterContent?.revision).toBe(1);

    // Caret-only: goes through setSelection under the event-driven contract.
    // setSnapshot is reserved for real document mutations and always bumps.
    useComposerDraftStore.getState().setSelection(taskId, { from: 3, to: 3 });
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
