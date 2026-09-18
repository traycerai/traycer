import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ROOT_MENTION_STEP,
  type MentionFlowStep,
  type MentionMenuAction,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import type { FileMentionAttachment } from "@/lib/composer/types";
import {
  createComposerPickerStore,
  type ComposerPickerCommit,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "../composer-picker-store";

const NOOP_COMMIT: ComposerPickerCommit = () => undefined;

const PROVIDER_STEP: MentionFlowStep = {
  kind: "provider",
  providerId: "files",
  stepId: "root",
  workspacePath: null,
};

const FILE_MENTION: FileMentionAttachment = {
  kind: "mention",
  contextType: "file",
  path: "src/lib/auth.ts",
  pathKind: "file",
  relPath: "src/lib/auth.ts",
  absolutePath: "/repo/src/lib/auth.ts",
  workspacePath: "/repo",
  label: "auth.ts",
  description: "src/lib",
};

function entry(id: string, action: MentionMenuAction): MentionMenuEntry {
  return {
    id,
    labelPrefix: null,
    label: id,
    detail: "",
    description: "",
    searchText: null,
    disabledReason: null,
    icon: createElement("span"),
    action,
    updatedAt: null,
    archived: false,
    dormant: false,
    preview: null,
  };
}

function mentionItem(
  id: string,
  action: MentionMenuAction,
): ComposerPickerItem {
  return { id, kind: "mention", entry: entry(id, action) };
}

function openMention(
  store: ComposerPickerStore,
  sessionId: number,
  query: string,
): void {
  store.getState().openPicker({
    sessionId,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 0, to: 0 },
    query,
    commit: NOOP_COMMIT,
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
}

interface MentionItemsInput {
  readonly sessionId: number;
  readonly query: string;
  readonly step: MentionFlowStep;
  readonly items: ReadonlyArray<ComposerPickerItem>;
}

function setMentionItems(
  store: ComposerPickerStore,
  input: MentionItemsInput,
): void {
  store.getState().setItems({
    sessionId: input.sessionId,
    kind: "mention",
    query: input.query,
    slashScope: null,
    step: input.step,
    items: input.items,
    loading: false,
    loadFailed: false,
    retryLoad: null,
  });
}

describe("composer picker store - navigated highlight carry", () => {
  it("follows the highlighted row by id through a reorder once navigated, even back at index 0", () => {
    const store = createComposerPickerStore();
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("a", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("c", { kind: "back" }),
      ],
    });
    expect(store.getState().activeIndex).toBe(0);

    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(1);
    store.getState().moveActive(-1);
    expect(store.getState().activeIndex).toBe(0);
    expect(store.getState().navigated).toBe(true);

    // Reordered publish under the same query/step: "a" is now at index 2.
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("c", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("a", { kind: "back" }),
      ],
    });

    expect(store.getState().activeIndex).toBe(2);
  });

  it("keeps the un-navigated highlight on index 0 (best match) through a reorder", () => {
    const store = createComposerPickerStore();
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("a", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("c", { kind: "back" }),
      ],
    });
    expect(store.getState().activeIndex).toBe(0);
    expect(store.getState().navigated).toBe(false);

    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("c", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("a", { kind: "back" }),
      ],
    });

    expect(store.getState().activeIndex).toBe(0);
  });

  it("resets navigated on a query change via updateRange, so a later reorder no longer follows the old row", () => {
    const store = createComposerPickerStore();
    openMention(store, 1, "au");
    setMentionItems(store, {
      sessionId: 1,
      query: "au",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("a", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("c", { kind: "back" }),
      ],
    });
    store.getState().moveActive(1);
    expect(store.getState().activeIndex).toBe(1);
    expect(store.getState().navigated).toBe(true);

    store.getState().updateRange({
      sessionId: 1,
      range: { from: 0, to: 2 },
      query: "auth",
      slashScope: null,
      clientRect: null,
    });
    expect(store.getState().navigated).toBe(false);

    setMentionItems(store, {
      sessionId: 1,
      query: "auth",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("c", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
        mentionItem("a", { kind: "back" }),
      ],
    });

    // Un-navigated again: the best match (index 0 of the new list) keeps the
    // highlight, rather than following "b" - the row under the old highlight.
    expect(store.getState().activeIndex).toBe(0);
  });

  it("resets navigated when setStep moves to a provider step", () => {
    const store = createComposerPickerStore();
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("a", { kind: "back" }),
        mentionItem("b", { kind: "back" }),
      ],
    });
    store.getState().moveActive(1);
    expect(store.getState().navigated).toBe(true);

    store.getState().setStep(PROVIDER_STEP);

    expect(store.getState().navigated).toBe(false);
  });
});

describe("composer picker store - onMentionPick observer", () => {
  it("notifies the observer for a completing mention item", () => {
    const store = createComposerPickerStore();
    const observed: MentionMenuEntry[] = [];
    store.getState().setMentionPickObserver((observedEntry) => {
      observed.push(observedEntry);
    });
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("file-a", { kind: "complete", mention: FILE_MENTION }),
      ],
    });

    const committed = store.getState().commitActiveItem();

    expect(committed).toBe(true);
    expect(observed.map((observedEntry) => observedEntry.id)).toEqual([
      "file-a",
    ]);
  });

  it("does not notify the observer for a navigate item", () => {
    const store = createComposerPickerStore();
    const observed: MentionMenuEntry[] = [];
    store.getState().setMentionPickObserver((observedEntry) => {
      observed.push(observedEntry);
    });
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("provider-files", {
          kind: "navigate",
          step: PROVIDER_STEP,
        }),
      ],
    });

    const committed = store.getState().commitActiveItem();

    expect(committed).toBe(true);
    expect(observed).toHaveLength(0);
  });

  it("does not notify the observer for a back item", () => {
    const store = createComposerPickerStore();
    const observed: MentionMenuEntry[] = [];
    store.getState().setMentionPickObserver((observedEntry) => {
      observed.push(observedEntry);
    });
    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [mentionItem("mention-back", { kind: "back" })],
    });

    const committed = store.getState().commitActiveItem();

    expect(committed).toBe(true);
    expect(observed).toHaveLength(0);
  });

  it("keeps the observer registered across close()", () => {
    const store = createComposerPickerStore();
    const observed: MentionMenuEntry[] = [];
    store.getState().setMentionPickObserver((observedEntry) => {
      observed.push(observedEntry);
    });

    store.getState().close();
    expect(store.getState().onMentionPick).not.toBeNull();

    openMention(store, 1, "");
    setMentionItems(store, {
      sessionId: 1,
      query: "",
      step: ROOT_MENTION_STEP,
      items: [
        mentionItem("file-a", { kind: "complete", mention: FILE_MENTION }),
      ],
    });
    store.getState().commitActiveItem();

    expect(observed.map((observedEntry) => observedEntry.id)).toEqual([
      "file-a",
    ]);
  });
});
