import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import type { SlashCommand } from "@/lib/composer/types";
import { insertImageAttachmentsCommand } from "@/hooks/composer/use-composer-paste";

import { buildComposerExtensions } from "../editor/editor-config";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

function makeFixture(): {
  editor: Editor;
  pickerStore: ComposerPickerStore;
} {
  const pickerStore = createComposerPickerStore();
  const submitHolder = { current: () => undefined };
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore,
      placeholder: "test",
      onSubmit: submitHolder,
      slashProviderId: "claude",
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return { editor, pickerStore };
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function planCommand(): SlashCommand {
  return {
    harnessId: "claude",
    name: "plan",
    description: "Plan something",
    argumentHint: null,
    kind: "slash-command",
    metadata: {},
    source: "provider",
    preview: {
      kind: "text",
      primary: "Plan something",
      secondary: null,
      mono: false,
    },
  };
}

describe("composer slash flow", () => {
  it("opens picker when user types / at start of empty doc and tracks query", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("/");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().kind).toBe("slash");
    editor.commands.insertContent("plan");
    await flush();
    expect(pickerStore.getState().query).toBe("plan");
    // Plain text in document - chip not yet inserted.
    expect(editor.state.doc.textContent).toBe("/plan");
  });

  it("opens picker when user types / after a leading image", async () => {
    const { editor, pickerStore } = makeFixture();
    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    editor.commands.insertContent("/");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().kind).toBe("slash");
  });

  it("does not open slash picker on a later block after an image-only block", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "imageAttachment", attrs: imageAttrs("img-1") }],
        },
        { type: "paragraph" },
      ],
    });
    const firstBlock = editor.state.doc.firstChild;
    if (firstBlock === null) throw new Error("expected first block");
    editor.commands.setTextSelection(firstBlock.nodeSize + 1);

    editor.commands.insertContent("/");
    await flush();

    expect(pickerStore.getState().open).toBe(false);
    expect(editor.state.doc.textContent).toBe("/");
  });

  it("does not open slash picker when / typed mid-paragraph", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("hello /");
    await flush();
    expect(pickerStore.getState().open).toBe(false);
  });

  it("commits an atomic slash chip + trailing space", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("/pl");
    await flush();
    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");
    commit({ id: "plan", kind: "slash", command: planCommand() });

    let slashCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "slashCommand") slashCount += 1;
    });
    expect(slashCount).toBe(1);

    editor.commands.insertContent("more");
    const tail = editor.state.doc.lastChild?.lastChild;
    expect(tail?.type.name).toBe("text");
  });

  it("registers slash command schema as atomic + inline", () => {
    const { editor } = makeFixture();
    const slashType = editor.schema.nodes.slashCommand;
    expect(slashType.isAtom).toBe(true);
    expect(slashType.isInline).toBe(true);
  });

  it("strips a non-leading slash chip via the leading-only schema guard", async () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("hello ");
    editor.commands.insertContent({
      type: "slashCommand",
      attrs: { commandName: "plan" },
    });
    await flush();
    let slashCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "slashCommand") slashCount += 1;
    });
    expect(slashCount).toBe(0);
  });

  it("keeps a slash chip when only images precede it", async () => {
    const { editor } = makeFixture();
    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);
    editor.commands.insertContent({
      type: "slashCommand",
      attrs: { commandName: "plan" },
    });
    await flush();

    expect(slashCount(editor)).toBe(1);
  });

  it("strips a slash chip when real text appears before leading images", async () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("hello ");
    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);
    editor.commands.insertContent({
      type: "slashCommand",
      attrs: { commandName: "plan" },
    });
    await flush();

    expect(slashCount(editor)).toBe(0);
  });
});

function imageAttrs(id: string) {
  return {
    id,
    fileName: `${id}.png`,
    b64content: id,
    mimeType: "image/png",
    size: id.length,
  };
}

function slashCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "slashCommand") count += 1;
  });
  return count;
}
