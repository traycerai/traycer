import "../../../../../__tests__/test-browser-apis";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import type { FileMentionAttachment } from "@/lib/composer/types";

import { buildComposerExtensions } from "../editor/editor-config";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

const FAKE_ICON: ReactElement = { type: "span", props: {}, key: null };

const editors: Editor[] = [];

function makeFixture(): {
  editor: Editor;
  pickerStore: ComposerPickerStore;
  submitCalls: { count: number };
} {
  const pickerStore = createComposerPickerStore();
  const submitCalls = { count: 0 };
  const submitHolder = {
    current: () => {
      submitCalls.count += 1;
    },
  };
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore,
      placeholder: "test",
      onSubmit: submitHolder,
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return { editor, pickerStore, submitCalls };
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

function fileMention(path: string): FileMentionAttachment {
  return {
    kind: "mention",
    contextType: "file",
    path,
    pathKind: "file",
    relPath: path,
    absolutePath: `/abs/${path}`,
    workspacePath: "/abs",
    label: path,
    description: "",
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("composer mention flow", () => {
  it("opens picker when user types @ and tracks query updates", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().kind).toBe("mention");
    expect(pickerStore.getState().query).toBe("");
    editor.commands.insertContent("src");
    await flush();
    expect(pickerStore.getState().query).toBe("src");
    // Plain text in document - chip not yet inserted.
    const docText = editor.state.doc.textContent;
    expect(docText).toBe("@src");
    let mentionNodeCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionNodeCount += 1;
    });
    expect(mentionNodeCount).toBe(0);
  });

  it("commits a mention atom + trailing space and continues typing outside the chip", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@sr");
    await flush();
    const range = pickerStore.getState().range;
    expect(range).not.toBeNull();
    if (range === null) return;

    const commit = pickerStore.getState().commit;
    expect(commit).not.toBeNull();
    if (commit === null) return;

    commit({
      id: "mention-1",
      kind: "mention",
      entry: {
        id: "mention-1",
        label: "src/foo.ts",
        detail: "",
        description: "",
        icon: FAKE_ICON,
        action: { kind: "complete", mention: fileMention("src/foo.ts") },
        preview: null,
      },
    });

    let mentionPath: unknown = null;
    let mentionFound = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "mention") return true;
      mentionFound = true;
      mentionPath = node.attrs.path;
      return false;
    });
    expect(mentionFound).toBe(true);
    expect(mentionPath).toBe("src/foo.ts");

    editor.commands.insertContent(" tail");
    const finalText = editor.state.doc.textContent;
    expect(finalText).toMatch(/\stail$/);

    const lastNode = editor.state.doc.lastChild?.lastChild;
    expect(lastNode?.type.name).toBe("text");
  });

  it("registers mention node as an atomic, inline schema entry", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@s");
    await flush();
    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");
    commit({
      id: "mention-1",
      kind: "mention",
      entry: {
        id: "mention-1",
        label: "src/foo.ts",
        detail: "",
        description: "",
        icon: FAKE_ICON,
        action: { kind: "complete", mention: fileMention("src/foo.ts") },
        preview: null,
      },
    });

    const mentionType = editor.schema.nodes.mention;
    expect(mentionType.isAtom).toBe(true);
    expect(mentionType.isInline).toBe(true);
    expect(mentionType.spec.selectable).toBe(true);
  });

  it("commit after typing query replaces the entire @query span (no leftover text)", async () => {
    // Regression: the suggestion plugin builds a fresh `props` per
    // view.update with `command` bound to the *current* state.range.
    // Capturing onStart's props leaves the typed query in the doc
    // because the bound range covers only the trigger char.
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@pla");
    await flush();
    expect(pickerStore.getState().query).toBe("pla");

    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");
    commit({
      id: "mention-1",
      kind: "mention",
      entry: {
        id: "mention-1",
        label: "platform.ts",
        detail: "",
        description: "",
        icon: FAKE_ICON,
        action: { kind: "complete", mention: fileMention("platform.ts") },
        preview: null,
      },
    });

    const text = editor.state.doc.textContent;
    expect(text).not.toContain("pla");
    expect(text.trim()).toBe("");
    let mentionPath: unknown = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionPath = node.attrs.path;
    });
    expect(mentionPath).toBe("platform.ts");
  });

  it("close() resets picker state and items", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@xy");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    // The suggestion plugin owns this session, so publish under its id the way
    // the item hook does rather than inventing one the store would reject.
    const { sessionId } = pickerStore.getState();
    if (sessionId === null) throw new Error("expected an open picker session");
    pickerStore.getState().setItems({
      sessionId,
      kind: "mention",
      query: "xy",
      slashScope: null,
      step: pickerStore.getState().step,
      items: [],
      loading: false,
      loadFailed: false,
      retryLoad: null,
    });
    pickerStore.getState().close();
    expect(pickerStore.getState().open).toBe(false);
    expect(pickerStore.getState().items).toEqual([]);
    expect(pickerStore.getState().query).toBe("");
  });
});
