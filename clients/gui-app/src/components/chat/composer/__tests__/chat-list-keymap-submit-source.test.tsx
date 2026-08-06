import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";

import { buildComposerExtensions } from "../editor/editor-config";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";
import type { ChatComposerSubmitSource } from "@/lib/chats/resolve-steer-submit";
import { ROOT_MENTION_STEP } from "@/lib/composer/mentions";

/**
 * Real ChatListKeymap source wiring (decisions 12, 16).
 *
 * Exercises the Tiptap keymap path - not a direct `submitDraft("mod-enter")`
 * call - so Enter/Mod-Enter and the picker commit-then-submit chord stay pinned.
 */

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

describe("ChatListKeymap submit source", () => {
  it("dispatches plain Enter as source 'enter'", () => {
    const sources: ChatComposerSubmitSource[] = [];
    const { editor } = makeEditor({
      onSubmit: (source) => {
        sources.push(source);
      },
      pickerStore: createComposerPickerStore(),
    });
    editor.commands.insertContent("hello");

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(sources).toEqual(["enter"]);
  });

  it("dispatches Mod-Enter as source 'mod-enter'", () => {
    const sources: ChatComposerSubmitSource[] = [];
    const { editor } = makeEditor({
      onSubmit: (source) => {
        sources.push(source);
      },
      pickerStore: createComposerPickerStore(),
    });
    editor.commands.insertContent("steer me");

    expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
    expect(sources).toEqual(["mod-enter"]);
  });

  it("commits an open picker then submits as mod-enter on Mod-Enter (decision 12)", () => {
    const sources: ChatComposerSubmitSource[] = [];
    const commit = vi.fn();
    const pickerStore = createComposerPickerStore();
    // Build the editor first so the slash suggestion plugin does not race
    // and replace the session we open below.
    const { editor } = makeEditor({
      onSubmit: (source) => {
        sources.push(source);
      },
      pickerStore,
    });
    editor.commands.insertContent("steer with picker");

    pickerStore.getState().openPicker({
      sessionId: 1,
      kind: "slash",
      slashScope: "all",
      slashTrigger: "/",
      range: { from: 1, to: 2 },
      query: "te",
      commit,
      clientRect: null,
    });
    pickerStore.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "te",
      slashScope: "all",
      step: ROOT_MENTION_STEP,
      items: [slashPickerItem()],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().items).toHaveLength(1);

    expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sources).toEqual(["mod-enter"]);
  });

  it("absorbs plain Enter on an open picker without submitting", () => {
    const sources: ChatComposerSubmitSource[] = [];
    const commit = vi.fn();
    const pickerStore = createComposerPickerStore();
    pickerStore.getState().openPicker({
      sessionId: 1,
      kind: "slash",
      slashScope: "all",
      slashTrigger: "/",
      range: { from: 1, to: 2 },
      query: "te",
      commit,
      clientRect: null,
    });
    pickerStore.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "te",
      slashScope: "all",
      step: ROOT_MENTION_STEP,
      items: [slashPickerItem()],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });

    const { editor } = makeEditor({
      onSubmit: (source) => {
        sources.push(source);
      },
      pickerStore,
    });

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sources).toEqual([]);
  });

  it("absorbs Mod-Enter when the open picker's active item refuses to commit (F6)", () => {
    // Disabled/loading rows make commitActiveItem return false; Mod-Enter must
    // NOT fall through to onSubmit (mirrors Enter absorption).
    const sources: ChatComposerSubmitSource[] = [];
    const commit = vi.fn();
    const pickerStore = createComposerPickerStore();
    const { editor } = makeEditor({
      onSubmit: (source) => {
        sources.push(source);
      },
      pickerStore,
    });
    editor.commands.insertContent("half typed trigger");

    pickerStore.getState().openPicker({
      sessionId: 1,
      kind: "slash",
      slashScope: "skills",
      slashTrigger: "/",
      range: { from: 1, to: 2 },
      query: "pl",
      commit,
      clientRect: null,
    });
    pickerStore.getState().setItems({
      sessionId: 1,
      kind: "slash",
      query: "pl",
      slashScope: "skills",
      step: ROOT_MENTION_STEP,
      items: [disabledSlashPickerItem()],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });

    expect(pickerStore.getState().open).toBe(true);
    // commitActiveItem returns false for a disabled active row.
    expect(pickerStore.getState().commitActiveItem()).toBe(false);

    expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
    // The keymap called commitActiveItem (refused) and must NOT submit.
    expect(sources).toEqual([]);
  });

  describe("open picker owns Enter and Mod-Enter when it cannot commit (F4)", () => {
    // An open picker keys off state.open only (not items.length). Empty,
    // loading, and refusing active rows all absorb both chords; only a
    // successful commit lets Mod-Enter proceed to submit.
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly prepare: (pickerStore: ComposerPickerStore) => void;
    }> = [
      {
        name: "empty items",
        prepare: (pickerStore) => {
          pickerStore.getState().openPicker({
            sessionId: 1,
            kind: "slash",
            slashScope: "all",
            slashTrigger: "/",
            range: { from: 1, to: 2 },
            query: "zz",
            commit: vi.fn(),
            clientRect: null,
          });
          pickerStore.getState().setItems({
            sessionId: 1,
            kind: "slash",
            query: "zz",
            slashScope: "all",
            step: ROOT_MENTION_STEP,
            items: [],
            loading: false,
            loadFailed: false,
            retryLoad: null,
          });
        },
      },
      {
        name: "loading with empty items",
        prepare: (pickerStore) => {
          pickerStore.getState().openPicker({
            sessionId: 1,
            kind: "slash",
            slashScope: "all",
            slashTrigger: "/",
            range: { from: 1, to: 2 },
            query: "te",
            commit: vi.fn(),
            clientRect: null,
          });
          pickerStore.getState().setItems({
            sessionId: 1,
            kind: "slash",
            query: "te",
            slashScope: "all",
            step: ROOT_MENTION_STEP,
            items: [],
            loading: true,
            loadFailed: false,
            retryLoad: null,
          });
        },
      },
      {
        name: "active item disabled/refusing",
        prepare: (pickerStore) => {
          pickerStore.getState().openPicker({
            sessionId: 1,
            kind: "slash",
            slashScope: "skills",
            slashTrigger: "/",
            range: { from: 1, to: 2 },
            query: "pl",
            commit: vi.fn(),
            clientRect: null,
          });
          pickerStore.getState().setItems({
            sessionId: 1,
            kind: "slash",
            query: "pl",
            slashScope: "skills",
            step: ROOT_MENTION_STEP,
            items: [disabledSlashPickerItem()],
            loading: false,
            loadFailed: false,
            retryLoad: null,
          });
        },
      },
    ];

    for (const testCase of cases) {
      it(`absorbs Enter and Mod-Enter when open picker cannot commit (${testCase.name})`, () => {
        const sources: ChatComposerSubmitSource[] = [];
        const pickerStore = createComposerPickerStore();
        const { editor } = makeEditor({
          onSubmit: (source) => {
            sources.push(source);
          },
          pickerStore,
        });
        editor.commands.insertContent("half typed trigger");
        testCase.prepare(pickerStore);

        expect(pickerStore.getState().open).toBe(true);
        expect(pickerStore.getState().commitActiveItem()).toBe(false);

        expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
        expect(sources).toEqual([]);

        expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
        expect(sources).toEqual([]);
      });
    }

    it("commits then submits as mod-enter when the active item is enabled (F4 committable)", () => {
      const sources: ChatComposerSubmitSource[] = [];
      const commit = vi.fn();
      const pickerStore = createComposerPickerStore();
      const { editor } = makeEditor({
        onSubmit: (source) => {
          sources.push(source);
        },
        pickerStore,
      });
      editor.commands.insertContent("steer with picker");

      pickerStore.getState().openPicker({
        sessionId: 1,
        kind: "slash",
        slashScope: "all",
        slashTrigger: "/",
        range: { from: 1, to: 2 },
        query: "te",
        commit,
        clientRect: null,
      });
      pickerStore.getState().setItems({
        sessionId: 1,
        kind: "slash",
        query: "te",
        slashScope: "all",
        step: ROOT_MENTION_STEP,
        items: [slashPickerItem()],
        loading: false,
        loadFailed: false,
        retryLoad: null,
      });

      expect(pickerStore.getState().open).toBe(true);
      expect(pickerStore.getState().items).toHaveLength(1);

      expect(editor.commands.keyboardShortcut("Mod-Enter")).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(sources).toEqual(["mod-enter"]);
    });

    it("commits Enter without submitting when the active item is enabled (F4)", () => {
      const sources: ChatComposerSubmitSource[] = [];
      const commit = vi.fn();
      const pickerStore = createComposerPickerStore();
      const { editor } = makeEditor({
        onSubmit: (source) => {
          sources.push(source);
        },
        pickerStore,
      });

      pickerStore.getState().openPicker({
        sessionId: 1,
        kind: "slash",
        slashScope: "all",
        slashTrigger: "/",
        range: { from: 1, to: 2 },
        query: "te",
        commit,
        clientRect: null,
      });
      pickerStore.getState().setItems({
        sessionId: 1,
        kind: "slash",
        query: "te",
        slashScope: "all",
        step: ROOT_MENTION_STEP,
        items: [slashPickerItem()],
        loading: false,
        loadFailed: false,
        retryLoad: null,
      });

      expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(sources).toEqual([]);
    });
  });
});

function slashCommand(name: string): {
  readonly harnessId: "claude";
  readonly name: string;
  readonly description: string;
  readonly argumentHint: null;
  readonly kind: "slash-command";
  readonly metadata: Record<string, never>;
  readonly source: "provider";
  readonly preview: {
    readonly kind: "text";
    readonly primary: string;
    readonly secondary: null;
    readonly mono: false;
  };
} {
  return {
    harnessId: "claude",
    name,
    description: `${name} command`,
    argumentHint: null,
    kind: "slash-command",
    metadata: {},
    source: "provider",
    preview: {
      kind: "text",
      primary: `${name} command`,
      secondary: null,
      mono: false,
    },
  };
}

function slashPickerItem(): {
  readonly id: string;
  readonly kind: "slash";
  readonly command: {
    readonly harnessId: "claude";
    readonly name: string;
    readonly description: string;
    readonly argumentHint: null;
    readonly kind: "slash-command";
    readonly metadata: Record<string, never>;
    readonly source: "provider";
    readonly preview: {
      readonly kind: "text";
      readonly primary: string;
      readonly secondary: null;
      readonly mono: false;
    };
  };
  readonly disabledReason: null;
} {
  return {
    id: "slash-test",
    kind: "slash",
    command: slashCommand("test"),
    disabledReason: null,
  };
}

function disabledSlashPickerItem(): {
  readonly id: string;
  readonly kind: "slash";
  readonly command: {
    readonly harnessId: "claude";
    readonly name: string;
    readonly description: string;
    readonly argumentHint: null;
    readonly kind: "slash-command";
    readonly metadata: Record<string, never>;
    readonly source: "provider";
    readonly preview: {
      readonly kind: "text";
      readonly primary: string;
      readonly secondary: null;
      readonly mono: false;
    };
  };
  readonly disabledReason: string;
} {
  return {
    id: "slash-disabled",
    kind: "slash",
    command: slashCommand("plan"),
    disabledReason: "This command is only allowed at the start of the message",
  };
}

function makeEditor(input: {
  readonly onSubmit: (source: ChatComposerSubmitSource) => void;
  readonly pickerStore: ComposerPickerStore;
}): { readonly editor: Editor } {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: input.pickerStore,
      getPlaceholder: () => "test",
      onSubmit: {
        current: input.onSubmit,
      },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return { editor };
}
