import "../../../../../__tests__/test-browser-apis";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildComposerClipboardHtml,
  composerClipboardPlainText,
} from "@/lib/composer/composer-clipboard";
import { insertImageAttachmentsCommand } from "@/hooks/composer/use-composer-paste";

import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];

const STRUCTURED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "slashCommand", attrs: { commandName: "implement" } },
        { type: "text", text: " preserve " },
        {
          type: "mention",
          attrs: {
            contextType: "file",
            path: "src/app.tsx",
            relPath: "src/app.tsx",
            pathKind: "file",
          },
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet one" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "bullet two" }],
            },
          ],
        },
      ],
    },
  ],
};

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("composer rich clipboard paste", () => {
  it("pastes Traycer composer clipboard HTML as structured editor content", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    const html = buildComposerClipboardHtml(
      STRUCTURED_CONTENT,
      composerClipboardPlainText(STRUCTURED_CONTENT),
    );

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) => (type === "text/html" ? html : ""),
      },
    });

    const bulletItems: string[] = [];
    const seen = {
      slashCommandName: "",
      mentionPath: "",
    };
    editor.state.doc.descendants((node) => {
      if (node.type.name === "slashCommand") {
        seen.slashCommandName =
          typeof node.attrs.commandName === "string"
            ? node.attrs.commandName
            : "";
      }
      if (node.type.name === "mention") {
        seen.mentionPath =
          typeof node.attrs.path === "string" ? node.attrs.path : "";
      }
      if (node.type.name === "listItem") {
        bulletItems.push(node.textContent);
      }
    });

    expect(seen).toEqual({
      slashCommandName: "implement",
      mentionPath: "src/app.tsx",
    });
    expect(bulletItems).toEqual(["bullet one", "bullet two"]);
  });

  it("normalizes legacy attachment groups from structured clipboard content", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    const legacyContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                b64content: "abc",
                hash: null,
                mimeType: "image/png",
                size: 3,
              },
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "describe it" }],
        },
      ],
    };
    const html = buildComposerClipboardHtml(
      legacyContent,
      composerClipboardPlainText(legacyContent),
    );

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/html"],
        getData: (type: string) => (type === "text/html" ? html : ""),
      },
    });

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                b64content: "abc",
                hash: null,
                mimeType: "image/png",
                size: 3,
              },
            },
            { type: "text", text: "describe it" },
          ],
        },
      ],
    });
  });

  it("pastes plain text Markdown as structured editor content", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    const markdown = [
      "# Title",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "Some **bold** and _italic_ text.",
    ].join("\n");

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? markdown : ""),
      },
    });

    const topLevelTypes: string[] = [];
    editor.state.doc.forEach((node) => {
      topLevelTypes.push(node.type.name);
    });
    const firstParagraph = editor.state.doc.firstChild;
    const firstText = firstParagraph?.firstChild;
    const bulletItems: string[] = [];
    const codeBlocks: string[] = [];
    const paragraphTexts: string[] = [];

    editor.state.doc.descendants((node) => {
      if (node.type.name === "listItem") {
        bulletItems.push(node.textContent);
        return false;
      }
      if (node.type.name === "codeBlock") {
        codeBlocks.push(node.textContent);
        return false;
      }
      if (node.type.name === "paragraph") {
        paragraphTexts.push(node.textContent);
      }
      return true;
    });

    expect(topLevelTypes).toEqual([
      "paragraph",
      "bulletList",
      "codeBlock",
      "paragraph",
    ]);
    expect(firstParagraph?.type.name).toBe("paragraph");
    expect(firstText?.text).toBe("Title");
    expect(firstText?.marks.some((mark) => mark.type.name === "bold")).toBe(
      true,
    );
    expect(bulletItems).toEqual(["first", "second"]);
    expect(codeBlocks).toEqual(["const x = 1;"]);
    expect(paragraphTexts).not.toContain("# Title");
    expect(paragraphTexts).not.toContain("- first");
  });

  it("keeps ordinary plain text paste as plain paragraph content", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "plain text only" : "",
      },
    });

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "plain text only" }],
        },
      ],
    });
  });

  it("pastes ordinary plain text inline inside an existing paragraph", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "prefix " }],
        },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "plain text only" : "",
      },
    });

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "prefix plain text only" }],
        },
      ],
    });
  });

  it("converts a leading slash command paste into a chip with literal args", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "/plan review the diff");

    const slash = collectSlashCommands(editor);
    expect(slash).toEqual(["plan"]);
    expect(remainderText(editor)).toBe(" review the diff");
  });

  it("keeps an existing leading slash chip when another slash command is pasted before it", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: " existing" },
          ],
        },
      ],
    });
    const slash = firstNodePosition(editor, "slashCommand");
    if (slash === null) throw new Error("expected slash command");
    editor.commands.setTextSelection(slash.pos);

    pastePlainText(editor, "/implement new work");

    expect(collectSlashCommands(editor)).toEqual(["plan"]);
    expect(remainderText(editor)).toBe(" /implement new work existing");
  });

  it("converts a slash command paste when images appear before it", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    pastePlainText(editor, "/plan review the diff");

    expect(collectImageIds(editor)).toEqual(["img-1"]);
    expect(collectSlashCommands(editor)).toEqual(["plan"]);
    expect(remainderText(editor)).toBe(" review the diff");
  });

  it("converts a bare leading slash command paste into a chip with a trailing space", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "/plan");

    expect(collectSlashCommands(editor)).toEqual(["plan"]);
    // A trailing space keeps the chip a separate token if the user types args
    // after it (otherwise the prompt would serialize as `/planargs`).
    expect(remainderText(editor)).toBe(" ");
  });

  it("matches case-insensitively but uses the catalog's canonical casing", () => {
    const editor = makeEditor(["Plan"]);

    pastePlainText(editor, "/plan review the diff");

    expect(collectSlashCommands(editor)).toEqual(["Plan"]);
    expect(remainderText(editor)).toBe(" review the diff");
  });

  it("normalizes CRLF in slash command arguments without leaking carriage returns", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "/plan line one\r\nline two");

    expect(collectSlashCommands(editor)).toEqual(["plan"]);
    const remainder = remainderText(editor);
    expect(remainder.includes("\r")).toBe(false);
    expect(remainder).toBe(" line oneline two");
  });

  it("keeps slash command arguments literal instead of parsing markdown", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "/plan look at **bold** and _italic_");

    expect(collectSlashCommands(editor)).toEqual(["plan"]);
    expect(remainderText(editor)).toBe(" look at **bold** and _italic_");
    const marks = new Set<string>();
    editor.state.doc.descendants((node) => {
      node.marks.forEach((mark) => marks.add(mark.type.name));
    });
    expect(marks.size).toBe(0);
  });

  it("does not convert a leading slash when pasted into a non-leading position", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hi " }] },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    pastePlainText(editor, "/plan");

    expect(collectSlashCommands(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("hi /plan");
  });

  it("does not convert text that does not lead with a slash command", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "run /plan now");

    expect(collectSlashCommands(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("run /plan now");
  });

  it("does not convert a slash command that is not in the catalog", () => {
    const editor = makeEditor(KNOWN_SLASH_NAMES);

    pastePlainText(editor, "/notacommand do the thing");

    expect(collectSlashCommands(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("/notacommand do the thing");
  });

  it("does not convert when the slash command catalog has not loaded", () => {
    const editor = makeEditor(null);

    pastePlainText(editor, "/plan review the diff");

    expect(collectSlashCommands(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("/plan review the diff");
  });
});

function pastePlainText(editor: Editor, text: string): void {
  fireEvent.paste(editor.view.dom, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

function collectSlashCommands(editor: Editor): string[] {
  const names: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "slashCommand") {
      names.push(
        typeof node.attrs.commandName === "string"
          ? node.attrs.commandName
          : "",
      );
    }
  });
  return names;
}

function collectImageIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "imageAttachment") return true;
    if (typeof node.attrs.id === "string") ids.push(node.attrs.id);
    return false;
  });
  return ids;
}

function firstNodePosition(
  editor: Editor,
  typeName: string,
): { readonly pos: number } | null {
  let found: { readonly pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== typeName) return true;
    found = { pos };
    return false;
  });
  return found;
}

function remainderText(editor: Editor): string {
  let text = "";
  editor.state.doc.descendants((node) => {
    if (node.type.name === "text") text += node.text ?? "";
  });
  return text;
}

const KNOWN_SLASH_NAMES = ["plan", "code-review", "implement"];

function imageAttrs(id: string) {
  return {
    id,
    fileName: `${id}.png`,
    b64content: id,
    mimeType: "image/png",
    size: id.length,
  };
}

function makeEditor(slashNames: ReadonlyArray<string> | null): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const pickerStore = createComposerPickerStore();
  if (slashNames !== null) {
    pickerStore
      .getState()
      .setKnownSlashCommands(
        new Map(slashNames.map((name) => [name.toLowerCase(), name])),
      );
  }
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore,
      placeholder: "test",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}
