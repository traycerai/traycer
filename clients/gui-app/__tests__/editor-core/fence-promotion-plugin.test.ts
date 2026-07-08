import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

function createEditor(): Editor {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "P", email: "p@x.io" });
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

interface JsonNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: ReadonlyArray<JsonNode>;
}

function topLevelTypes(editor: Editor): string[] {
  const json = editor.getJSON() as JsonNode;
  const blocks = json.content ?? [];
  return blocks.map((n) => n.type);
}

describe("fencePromotionPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("promotes a mermaid codeBlock to mermaidBlock after the idle window", () => {
    const editor = createEditor();
    // Drain the priming scan that fires at editor boot.
    vi.advanceTimersByTime(500);

    editor.commands.insertContent({
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph TD\n  A --> B" }],
    });

    // Pre-promotion: still a codeBlock.
    expect(topLevelTypes(editor)).toContain("codeBlock");

    vi.advanceTimersByTime(450);

    const types = topLevelTypes(editor);
    expect(types).toContain("mermaidBlock");
    expect(types).not.toContain("codeBlock");
    editor.destroy();
  });

  it("promotes a wireframe codeBlock to uiPreviewBlock after the idle window", () => {
    const editor = createEditor();
    vi.advanceTimersByTime(500);

    editor.commands.insertContent({
      type: "codeBlock",
      attrs: { language: "wireframe" },
      content: [{ type: "text", text: "<div>hi</div>" }],
    });

    vi.advanceTimersByTime(450);

    expect(topLevelTypes(editor)).toContain("uiPreviewBlock");
    editor.destroy();
  });

  it("does not promote while the fence is still being mutated (streaming guard)", () => {
    const editor = createEditor();
    vi.advanceTimersByTime(500);

    editor.commands.insertContent({
      type: "codeBlock",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph" }],
    });

    // Simulate a stream: mutate every 100ms for 1 second. The 400ms idle
    // timer should be reset on each transaction, so no promotion fires.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(100);
      // Append a token at the end of the doc.
      editor.commands.insertContentAt(editor.state.doc.content.size - 2, " A");
    }

    // Streaming pause but not past the idle window yet.
    vi.advanceTimersByTime(300);
    expect(topLevelTypes(editor)).toContain("codeBlock");
    expect(topLevelTypes(editor)).not.toContain("mermaidBlock");

    // Idle long enough - promotion fires once.
    vi.advanceTimersByTime(200);
    const types = topLevelTypes(editor);
    expect(types).toContain("mermaidBlock");
    expect(types.filter((t) => t === "mermaidBlock")).toHaveLength(1);
    editor.destroy();
  });

  it("leaves non-mermaid / non-wireframe code blocks alone", () => {
    const editor = createEditor();
    vi.advanceTimersByTime(500);

    editor.commands.insertContent({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });

    vi.advanceTimersByTime(800);

    const types = topLevelTypes(editor);
    expect(types).toContain("codeBlock");
    expect(types).not.toContain("mermaidBlock");
    expect(types).not.toContain("uiPreviewBlock");
    editor.destroy();
  });
});
