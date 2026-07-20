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
  submitCount: () => number;
} {
  const pickerStore = createComposerPickerStore();
  let submits = 0;
  const submitHolder = {
    current: () => {
      submits += 1;
    },
  };
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
      getHasPastedImageBytes: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return { editor, pickerStore, submitCount: () => submits };
}

function pressKey(editor: Editor, key: string): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function openDisabledOnlyPicker(pickerStore: ComposerPickerStore): void {
  pickerStore.getState().setItems({
    kind: "slash",
    query: "",
    slashScope: "skills",
    step: { kind: "root" },
    items: [
      {
        id: "plan",
        kind: "slash",
        command: planCommand(),
        disabledReason:
          "This command is only allowed at the start of the message",
      },
    ],
    loading: false,
  });
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

function skillCommand(name: string): SlashCommand {
  return {
    harnessId: "claude",
    name,
    description: `Use ${name}`,
    argumentHint: null,
    kind: "skill",
    metadata: {
      path: `/repo/.agents/skills/${name}/SKILL.md`,
    },
    source: "provider",
    preview: {
      kind: "text",
      primary: `Use ${name}`,
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

  it("opens a skills-only picker on a block after text", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph" },
      ],
    });
    const firstBlock = editor.state.doc.firstChild;
    if (firstBlock === null) throw new Error("expected first block");
    editor.commands.setTextSelection(firstBlock.nodeSize + 1);

    editor.commands.insertContent("/");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().slashScope).toBe("skills");
    expect(editor.state.doc.textContent).toBe("hello/");
  });

  // An attachment-only block serializes to the empty string and is dropped by
  // `plainTextFromNodes`, so the prompt the provider parses still begins with
  // the command. Restricting the picker here would refuse a command that would
  // in fact have run - and would contradict the same image sitting inline
  // beside the caret, which has always been ignored.
  it("keeps the picker unrestricted on a block after an attachment-only block", async () => {
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

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().slashScope).toBe("all");
    expect(editor.state.doc.textContent).toBe("/");
  });

  // Regression: `ChatListKeymap` owns Enter and falls through to submit when
  // `commitActiveItem()` returns false. Once a highlighted row could legally
  // refuse to commit, that fall-through started firing submit with the picker
  // still open - sending a half-typed message. Exercised through a real DOM
  // keydown because the store-level tests cannot see which plugin wins.
  it("does not submit the message when Enter lands on a disabled row", async () => {
    const { editor, pickerStore, submitCount } = makeFixture();
    editor.commands.insertContent("hello /");
    await flush();
    openDisabledOnlyPicker(pickerStore);
    expect(pickerStore.getState().items.length).toBe(1);

    pressKey(editor, "Enter");
    await flush();

    expect(submitCount()).toBe(0);
    expect(pickerStore.getState().open).toBe(true);
    expect(slashCount(editor)).toBe(0);
    expect(editor.state.doc.textContent).toBe("hello /");
  });

  it("does not submit the message when Tab lands on a disabled row", async () => {
    const { editor, pickerStore, submitCount } = makeFixture();
    editor.commands.insertContent("hello /");
    await flush();
    openDisabledOnlyPicker(pickerStore);

    pressKey(editor, "Tab");
    await flush();

    expect(submitCount()).toBe(0);
    expect(slashCount(editor)).toBe(0);
  });

  it("still submits on Enter when no picker is open", async () => {
    const { editor, submitCount } = makeFixture();
    editor.commands.insertContent("hello");
    await flush();

    pressKey(editor, "Enter");
    await flush();

    expect(submitCount()).toBe(1);
  });

  // Claude's parser bails unless `prompt.trim().startsWith("/")`, and the
  // host's own `parseProviderSlashPrompt` trims too - so whitespace before the
  // command must not demote it to an inline (skills-only) position.
  it("treats a command after leading spaces as leading", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("   /");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().slashScope).toBe("all");
  });

  it("keeps a native command chip inserted after leading spaces", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("   /pl");
    await flush();
    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");

    commit({
      id: "plan",
      kind: "slash",
      command: planCommand(),
      disabledReason: null,
    });
    await flush();

    // The leading guard plugin must not strip it back out.
    expect(slashCount(editor)).toBe(1);
    const names: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "slashCommand") {
        names.push(String(node.attrs.commandName));
      }
    });
    expect(names).toEqual(["plan"]);
  });

  it("treats a command as leading when only blank blocks precede it", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph" }, { type: "paragraph" }],
    });
    const firstBlock = editor.state.doc.firstChild;
    if (firstBlock === null) throw new Error("expected first block");
    editor.commands.setTextSelection(firstBlock.nodeSize + 1);

    editor.commands.insertContent("/");
    await flush();

    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().slashScope).toBe("all");
  });

  it("still treats a command after real text as inline", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("   hello /");
    await flush();

    expect(pickerStore.getState().slashScope).toBe("skills");
  });

  it("opens a skills-only picker when / is typed mid-paragraph", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("hello /");
    await flush();
    expect(pickerStore.getState().open).toBe(true);
    expect(pickerStore.getState().slashScope).toBe("skills");
  });

  it("commits multiple skill chips anywhere in the prompt", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("Review this with /front");
    await flush();

    const firstCommit = pickerStore.getState().commit;
    if (firstCommit === null) throw new Error("first commit missing");
    firstCommit({
      id: "frontend-design",
      kind: "slash",
      command: skillCommand("frontend-design"),
      disabledReason: null,
    });
    editor.commands.insertContent("and /react");
    await flush();

    const secondCommit = pickerStore.getState().commit;
    if (secondCommit === null) throw new Error("second commit missing");
    secondCommit({
      id: "react-best-practices",
      kind: "slash",
      command: skillCommand("react-best-practices"),
      disabledReason: null,
    });
    await flush();

    expect(slashCount(editor)).toBe(2);
    const skillNames: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "slashCommand") return;
      expect(node.attrs.kind).toBe("skill");
      skillNames.push(String(node.attrs.commandName));
    });
    expect(skillNames).toEqual(["frontend-design", "react-best-practices"]);
  });

  it("does not commit a native slash command outside the leading position", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("hello /pl");
    await flush();
    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");

    commit({
      id: "plan",
      kind: "slash",
      command: planCommand(),
      disabledReason: null,
    });
    await flush();

    expect(slashCount(editor)).toBe(0);
    expect(editor.state.doc.textContent).toBe("hello /pl");
  });

  it("commits an atomic slash chip + trailing space", async () => {
    const { editor, pickerStore } = makeFixture();
    editor.commands.insertContent("/pl");
    await flush();
    const commit = pickerStore.getState().commit;
    if (commit === null) throw new Error("commit missing");
    commit({
      id: "plan",
      kind: "slash",
      command: planCommand(),
      disabledReason: null,
    });

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

  it("keeps non-leading skill chips via the skill-aware schema guard", async () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("hello ");
    editor.commands.insertContent({
      type: "slashCommand",
      attrs: { commandName: "frontend-design", kind: "skill" },
    });
    editor.commands.insertContent(" and ");
    editor.commands.insertContent({
      type: "slashCommand",
      attrs: { commandName: "react-best-practices", kind: "skill" },
    });
    await flush();

    expect(slashCount(editor)).toBe(2);
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
