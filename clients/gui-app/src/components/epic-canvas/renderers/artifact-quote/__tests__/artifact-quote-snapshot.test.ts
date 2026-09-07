import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

import { snapshotArtifactQuote } from "../artifact-quote-snapshot";

function buildEditor(): Editor {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "T", email: "t@x.io" });
  return new Editor({
    extensions: buildArtifactExtensions({
      doc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
}

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("snapshotArtifactQuote", () => {
  it("returns null for a collapsed selection", () => {
    editor = buildEditor();
    editor.commands.setContent("hello world");
    editor.commands.setTextSelection(1);

    expect(snapshotArtifactQuote(editor.state)).toBeNull();
  });

  it("turns prose across two paragraphs into two paragraph blocks", () => {
    editor = buildEditor();
    editor.commands.setContent([
      { type: "paragraph", content: [{ type: "text", text: "First line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
    ]);
    editor.commands.selectAll();

    const snapshot = snapshotArtifactQuote(editor.state);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "First line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
    ]);
  });

  it("turns a hard break inside a paragraph into separate lines", () => {
    editor = buildEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "First line" },
            { type: "hardBreak" },
            { type: "text", text: "Second line" },
          ],
        },
      ],
    });
    editor.commands.selectAll();

    const snapshot = snapshotArtifactQuote(editor.state);
    expect(snapshot?.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "First line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
    ]);
  });

  it("turns a selection wholly inside a labelled code block into one codeBlock", () => {
    editor = buildEditor();
    const text = "const x = 1;";
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text }],
        },
      ],
    });
    // `selectAll` produces an `AllSelection` spanning the whole doc (its
    // `$from` resolves at depth 0, parent "doc"), which is not what a real
    // in-block drag selection looks like. Select just the code block's own
    // content instead, the same shape a user's selection takes.
    editor.commands.setTextSelection({ from: 1, to: 1 + text.length });

    const snapshot = snapshotArtifactQuote(editor.state);
    expect(snapshot?.blocks).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const x = 1;" }],
      },
    ]);
  });

  it("uses an empty language for an unlabelled code block", () => {
    editor = buildEditor();
    const text = "plain code";
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text }],
        },
      ],
    });
    editor.commands.setTextSelection({ from: 1, to: 1 + text.length });

    const snapshot = snapshotArtifactQuote(editor.state);
    expect(snapshot?.blocks).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "" },
        content: [{ type: "text", text: "plain code" }],
      },
    ]);
  });

  it("puts table cell texts on separate lines for a selection spanning cells", () => {
    editor = buildEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Alpha" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Beta" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    // Select from the start of "Alpha" to the end of "Beta" via an ordinary
    // TextSelection, bypassing the table selection plugin's own mouse-drag
    // handling - this is the shape a keyboard/shift-click selection across
    // cells actually produces in the document.
    const doc = editor.state.doc;
    let alphaStart = -1;
    let betaEnd = -1;
    doc.descendants((node, pos) => {
      if (node.type.name !== "text") return;
      if (node.text === "Alpha") alphaStart = pos;
      if (node.text === "Beta") betaEnd = pos + node.nodeSize;
    });
    expect(alphaStart).toBeGreaterThanOrEqual(0);
    expect(betaEnd).toBeGreaterThan(alphaStart);

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(doc, alphaStart, betaEnd),
      ),
    );

    const snapshot = snapshotArtifactQuote(editor.state);
    expect(snapshot?.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Alpha" }] },
      { type: "paragraph", content: [{ type: "text", text: "Beta" }] },
    ]);
  });

  it("returns null for a table CellSelection", () => {
    editor = buildEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Alpha" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Beta" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const doc = editor.state.doc;
    const cellPositions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cellPositions.push(pos);
    });
    expect(cellPositions).toHaveLength(2);

    const cellSelection = new CellSelection(
      doc.resolve(cellPositions[0]),
      doc.resolve(cellPositions[1]),
    );
    editor.view.dispatch(editor.state.tr.setSelection(cellSelection));
    expect(editor.state.selection).toBeInstanceOf(CellSelection);

    expect(snapshotArtifactQuote(editor.state)).toBeNull();
  });
});
