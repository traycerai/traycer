import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import type { FileMentionAttachment } from "@/lib/composer/types";

import { buildComposerExtensions } from "../editor/editor-config";
import {
  createComposerPickerStore,
  type ComposerPickerItem,
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
      getPlaceholder: () => "test",
      onSubmit: submitHolder,
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
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

function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function mentionItem(path: string): ComposerPickerItem {
  return {
    id: `mention:${path}`,
    kind: "mention",
    entry: {
      id: `mention:${path}`,
      label: path,
      detail: "",
      description: "",
      icon: FAKE_ICON,
      action: { kind: "complete", mention: fileMention(path) },
      preview: null,
    },
  };
}

/** Publishes one committable row under the live suggestion session. */
function publishItems(pickerStore: ComposerPickerStore, path: string): void {
  const { sessionId, query, step } = pickerStore.getState();
  if (sessionId === null) throw new Error("expected an open picker session");
  pickerStore.getState().setItems({
    sessionId,
    kind: "mention",
    query,
    slashScope: null,
    step,
    items: [mentionItem(path)],
    loading: false,
    loadFailed: false,
    retryLoad: null,
  });
}

function mentionNodeCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "mention") count += 1;
  });
  return count;
}

describe("mention menu dismissal", () => {
  it("never opens for a mid-word @ (emails)", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("mail user@host");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });

  it("still opens at the start of a block and after a space", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    pressKey(editor, "Escape");
    await flush();
    editor.commands.insertContent("hi @");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
  });

  it("closes when the query starts with a space and stays closed", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    editor.commands.insertContent(" and");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
    editor.commands.insertContent(" more");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });

  it("closes on a comma in the query and stays closed", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@auth");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    editor.commands.insertContent(", then");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
    editor.commands.insertContent(" more typing");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });

  it("closes on a semicolon in the query", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@auth");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    editor.commands.insertContent(";");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });

  it("opens a fresh menu for a second @ after punctuation dismissal", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@auth");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    editor.commands.insertContent(", ");
    await flush();
    expect(pickerStore.getState().open).toBe(false);

    editor.commands.insertContent("@lib");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().kind).toBe("mention");
    expect(pickerStore.getState().query).toBe("lib");
  });

  it("opens a fresh menu for a second @ after a zero-match dismissal via the session handle", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@zzz");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    // The mention item hook calls this handle when the root search settles on
    // zero real matches; it must end the plugin session, not just the store.
    const dismiss = pickerStore.getState().dismiss;
    expect(dismiss).not.toBeNull();
    if (dismiss === null) return;
    dismiss();
    await flush();
    expect(pickerStore.getState().open).toBe(false);

    editor.commands.insertContent(" @lib");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("lib");
  });

  it("keeps a synchronously-typed second @ open past the deferred plugin exit", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@auth");
    await flush();
    expect(pickerStore.getState().open).toBe(true);

    // No flush between these: the comma queues the plugin exit on a
    // microtask, and the second insert lands before it drains. The stale
    // exit must not dismiss the @lib occurrence that superseded it.
    editor.commands.insertContent(", ");
    editor.commands.insertContent("@lib");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("lib");
  });

  it("does not let a stale queued exit close a mention activated by a selection restore", async () => {
    const { editor, pickerStore } = makeFixture();
    // Production shape (applyContent): one transaction applies content whose
    // trailing text is prose (queues the dismissal exit), the next restores
    // a saved selection that activates a legitimate earlier @ - before the
    // queued exit's microtask drains.
    editor.commands.insertContent("@lib then @auth,");
    editor.commands.setTextSelection(5);
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("lib");
  });

  it("reopens the SAME @ when a selection restore makes its query valid again", async () => {
    const { editor, pickerStore } = makeFixture();
    // Literal applyContent shape: setContent leaves the caret at the end, so
    // tiptap sees the dismissed prose query "lib, trailing" on the @ at
    // from=1 and the dismissal exit is queued; the synchronous selection
    // restore then truncates the SAME occurrence's query to a valid "lib"
    // before the microtask drains.
    editor.commands.setContent("@lib, trailing");
    editor.commands.setTextSelection(5);
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("lib");
  });

  it("reopens after a same-origin content replacement makes the query valid", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@auth");
    await flush();
    expect(pickerStore.getState().open).toBe(true);

    // No flush between: the comma queues the exit, and the replacement's @
    // sits at the same document position as the dismissed one.
    editor.commands.insertContent(",");
    editor.commands.setContent("@x");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("x");
  });

  it("closes on a double space but keeps single-space queries open", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("@release notes");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().query).toBe("release notes");
    editor.commands.insertContent("  x");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });
});

describe("mention engaged selection", () => {
  it("lets an un-engaged Enter fall through to submit instead of inserting", async () => {
    const { editor, pickerStore, submitCalls } = makeFixture();
    editor.commands.insertContent("@src");
    await flush();
    publishItems(pickerStore, "src/foo.ts");
    expect(pickerStore.getState().engaged).toBe(false);

    pressKey(editor, "Enter");
    await flush();

    expect(mentionNodeCount(editor)).toBe(0);
    expect(submitCalls.count).toBe(1);
    expect(editor.state.doc.textContent).toBe("@src");
  });

  it("inserts on Enter after arrow-key engagement", async () => {
    const { editor, pickerStore, submitCalls } = makeFixture();
    editor.commands.insertContent("@src");
    await flush();
    publishItems(pickerStore, "src/foo.ts");

    pressKey(editor, "ArrowDown");
    expect(pickerStore.getState().engaged).toBe(true);
    pressKey(editor, "Enter");
    await flush();

    expect(mentionNodeCount(editor)).toBe(1);
    expect(submitCalls.count).toBe(0);
  });

  it("accepts the highlighted item on Tab without prior engagement", async () => {
    const { editor, pickerStore, submitCalls } = makeFixture();
    editor.commands.insertContent("@src");
    await flush();
    publishItems(pickerStore, "src/foo.ts");

    pressKey(editor, "Tab");
    await flush();

    expect(mentionNodeCount(editor)).toBe(1);
    expect(submitCalls.count).toBe(0);
  });

  it("resets engagement when the menu reopens for a new @ occurrence", async () => {
    const { editor, pickerStore, submitCalls } = makeFixture();
    editor.commands.insertContent("@src");
    await flush();
    publishItems(pickerStore, "src/foo.ts");
    pressKey(editor, "ArrowDown");
    expect(pickerStore.getState().engaged).toBe(true);
    pressKey(editor, "Escape");
    await flush();
    expect(pickerStore.getState().open).toBe(false);

    editor.commands.insertContent(" @lib");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().engaged).toBe(false);
    publishItems(pickerStore, "lib/bar.ts");

    pressKey(editor, "Enter");
    await flush();
    expect(mentionNodeCount(editor)).toBe(0);
    expect(submitCalls.count).toBe(1);
  });
});
