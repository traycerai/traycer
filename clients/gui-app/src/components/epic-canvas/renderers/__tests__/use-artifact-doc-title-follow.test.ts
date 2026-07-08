import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { leadingDocTitle } from "../use-artifact-doc-title-follow";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("leadingDocTitle", () => {
  it("reads a leading level-1 heading as the doc title, trimmed", () => {
    const editor = makeEditor("<h1>  Roadmap 2026 </h1><p>body</p>");
    expect(leadingDocTitle(editor)).toBe("Roadmap 2026");
  });

  it("flattens inline marks to plain heading text", () => {
    const editor = makeEditor("<h1>Road<strong>map</strong></h1>");
    expect(leadingDocTitle(editor)).toBe("Roadmap");
  });

  it("ignores a heading that is not the first block", () => {
    const editor = makeEditor("<p>intro</p><h1>Roadmap</h1>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("ignores a leading heading deeper than level 1", () => {
    const editor = makeEditor("<h2>Roadmap</h2>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("treats an empty or whitespace-only leading heading as no title", () => {
    const editor = makeEditor("<h1>   </h1><p>body</p>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("returns null for an empty document", () => {
    const editor = makeEditor("");
    expect(leadingDocTitle(editor)).toBeNull();
  });
});
