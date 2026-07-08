import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { seedArtifactTitleHeading } from "../artifact-editor-seed";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({ extensions: [StarterKit], content });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("seedArtifactTitleHeading", () => {
  it("seeds an empty leading H1 followed by an empty paragraph into an empty doc", () => {
    const editor = makeEditor("");
    expect(seedArtifactTitleHeading(editor)).toBe(true);
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe("heading");
    expect(doc.child(0).attrs.level).toBe(1);
    expect(doc.child(0).textContent).toBe("");
    expect(doc.child(1).type.name).toBe("paragraph");
    // Tiptap's `isEmpty` is a text-content heuristic, so a doc of empty-text
    // nodes still reads empty - which is what keeps the whole-empty-editor
    // placeholder rule rendering the title hint on the seeded empty heading.
    expect(editor.isEmpty).toBe(true);
  });

  it("leaves a non-empty doc untouched", () => {
    const editor = makeEditor("<p>existing content</p>");
    const before = editor.getHTML();
    expect(seedArtifactTitleHeading(editor)).toBe(false);
    expect(editor.getHTML()).toBe(before);
  });

  it("does not prepend a second heading when the doc already opens on one", () => {
    const editor = makeEditor("<h1>Existing title</h1><p>body</p>");
    expect(seedArtifactTitleHeading(editor)).toBe(false);
    expect(editor.state.doc.child(0).textContent).toBe("Existing title");
    expect(editor.state.doc.childCount).toBe(2);
  });
});
