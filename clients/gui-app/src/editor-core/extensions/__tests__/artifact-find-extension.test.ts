import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  applyArtifactFindSearch,
  ArtifactFindExtension,
  calculateArtifactFindMatches,
  getArtifactFindState,
  setArtifactFindCurrent,
} from "../artifact-find-extension";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ArtifactFindExtension],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("ArtifactFindExtension", () => {
  it("calculates matches from ProseMirror document positions", () => {
    const editor = makeEditor(
      "<p>Hello <strong>hel</strong>lo</p><p>hello</p>",
    );

    const matches = calculateArtifactFindMatches(
      editor.state.doc,
      "hello",
      false,
    );

    expect(matches).toHaveLength(3);
    expect(
      matches.map((match) =>
        editor.state.doc.textBetween(match.from, match.to, "", ""),
      ),
    ).toEqual(["Hello", "hello", "hello"]);
    expect(
      calculateArtifactFindMatches(
        makeEditor("<p>foo</p><p>bar</p>").state.doc,
        "foobar",
        false,
      ),
    ).toHaveLength(0);
  });

  it("moves the current decoration without changing the match set or selection", () => {
    const editor = makeEditor("<p>alpha beta alpha</p>");

    applyArtifactFindSearch(
      editor,
      { requestId: 1, query: "alpha", matchCase: false },
      null,
    );
    expect(getArtifactFindState(editor).currentIndex).toBe(0);
    expect(editor.commands.setTextSelection(7)).toBe(true);
    const selectionBefore = JSON.stringify(editor.state.selection.toJSON());

    setArtifactFindCurrent(editor, 1);

    const state = getArtifactFindState(editor);
    const highlighted = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(
        "[data-artifact-find-match='true']",
      ),
    );
    const current = editor.view.dom.querySelector<HTMLElement>(
      "[data-artifact-find-current='true']",
    );
    expect(state.matches).toHaveLength(2);
    expect(state.currentIndex).toBe(1);
    expect(JSON.stringify(editor.state.selection.toJSON())).toEqual(
      selectionBefore,
    );
    expect(highlighted).toHaveLength(2);
    expect(current?.textContent).toBe("alpha");
  });

  it("honors matchCase", () => {
    const editor = makeEditor("<p>Hello hello HELLO</p>");

    applyArtifactFindSearch(
      editor,
      { requestId: 1, query: "hello", matchCase: true },
      null,
    );
    expect(getArtifactFindState(editor).matches).toHaveLength(1);

    applyArtifactFindSearch(
      editor,
      { requestId: 2, query: "hello", matchCase: false },
      null,
    );
    expect(getArtifactFindState(editor).matches).toHaveLength(3);
  });

  it("clears decorations for an empty query", () => {
    const editor = makeEditor("<p>find me</p>");

    applyArtifactFindSearch(
      editor,
      { requestId: 1, query: "find", matchCase: false },
      null,
    );
    expect(
      editor.view.dom.querySelectorAll("[data-artifact-find-match='true']"),
    ).toHaveLength(1);

    applyArtifactFindSearch(
      editor,
      { requestId: 2, query: "", matchCase: false },
      null,
    );

    const state = getArtifactFindState(editor);
    expect(state.query).toBe("");
    expect(state.matches).toHaveLength(0);
    expect(
      editor.view.dom.querySelectorAll("[data-artifact-find-match='true']"),
    ).toHaveLength(0);
  });
});
