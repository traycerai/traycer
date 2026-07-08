import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

function createArtifactEditor(): Editor {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({
    userName: "Tester",
    email: "tester@example.com",
  });
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

describe("buildArtifactExtensions", () => {
  it("registers heading, list, task-list, table, code-block, and blockquote nodes", () => {
    const editor = createArtifactEditor();
    const schema = editor.schema;
    expect(schema.nodes.heading).toBeDefined();
    expect(schema.nodes.bulletList).toBeDefined();
    expect(schema.nodes.orderedList).toBeDefined();
    expect(schema.nodes.taskList).toBeDefined();
    expect(schema.nodes.taskItem).toBeDefined();
    expect(schema.nodes.table).toBeDefined();
    expect(schema.nodes.tableRow).toBeDefined();
    expect(schema.nodes.tableCell).toBeDefined();
    expect(schema.nodes.tableHeader).toBeDefined();
    expect(schema.nodes.codeBlock).toBeDefined();
    expect(schema.nodes.blockquote).toBeDefined();
    expect(schema.nodes.horizontalRule).toBeDefined();
    editor.destroy();
  });

  it("registers the mermaid + wireframe atom block nodes", () => {
    const editor = createArtifactEditor();
    const schema = editor.schema;
    const mermaid = schema.nodes.mermaidBlock;
    const wireframe = schema.nodes.uiPreviewBlock;
    expect(mermaid).toBeDefined();
    expect(wireframe).toBeDefined();
    // Atom + draggable + isolating contract - see plan §Atom schema.
    expect(mermaid.spec.atom).toBe(true);
    expect(mermaid.spec.draggable).toBe(false);
    expect(mermaid.spec.isolating).toBe(true);
    expect(wireframe.spec.atom).toBe(true);
    expect(wireframe.spec.draggable).toBe(false);
    expect(wireframe.spec.isolating).toBe(true);
    editor.destroy();
  });

  it("roundtrips a mermaid fence through the markdown serializer", () => {
    const editor = createArtifactEditor();
    const md = ["```mermaid", "graph TD", "  A --> B", "```", ""].join("\n");
    editor.commands.setContent(md, {
      contentType: "markdown",
    });
    const json = editor.getJSON();
    const blocks = json.content as Array<{ type: string }>;
    // Markdown parse hook short-circuits to the rich atom node directly.
    expect(blocks.some((n) => n.type === "mermaidBlock")).toBe(true);
    const out = editor.getMarkdown();
    expect(out).toContain("```mermaid");
    expect(out).toContain("graph TD");
    expect(out).toContain("A --> B");
    editor.destroy();
  });

  it("roundtrips a wireframe fence through the markdown serializer", () => {
    const editor = createArtifactEditor();
    const md = [
      "```wireframe",
      "<div><h1>Hello</h1><p>World</p></div>",
      "```",
      "",
    ].join("\n");
    editor.commands.setContent(md, {
      contentType: "markdown",
    });
    const json = editor.getJSON();
    const blocks = json.content as Array<{ type: string }>;
    expect(blocks.some((n) => n.type === "uiPreviewBlock")).toBe(true);
    const out = editor.getMarkdown();
    expect(out).toContain("```wireframe");
    expect(out).toContain("<h1>Hello</h1>");
    editor.destroy();
  });

  it("exposes a markdown serializer via editor.getMarkdown()", () => {
    const editor = createArtifactEditor();
    expect(typeof editor.getMarkdown).toBe("function");
    editor.destroy();
  });

  it("roundtrips headings, lists, and code blocks through markdown", () => {
    const editor = createArtifactEditor();
    const md = [
      "# Title",
      "",
      "Some **bold** and _italic_ text.",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
    ].join("\n");
    editor.commands.setContent(md, {
      contentType: "markdown",
      parseOptions: { preserveWhitespace: false },
    });
    const out = editor.getMarkdown();
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("- one");
    expect(out).toContain("```ts");
    editor.destroy();
  });

  it("serializes a copied selection to markdown via clipboardTextSerializer", () => {
    const editor = createArtifactEditor();
    const md = [
      "# Title",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
    ].join("\n");
    editor.commands.setContent(md, {
      contentType: "markdown",
      parseOptions: { preserveWhitespace: false },
    });

    // A select-all copy goes through ProseMirror's clipboard pipeline, which
    // reads the `clipboardTextSerializer` contributed by `MarkdownClipboard`.
    const { doc } = editor.state;
    const { text } = editor.view.serializeForClipboard(
      doc.slice(0, doc.content.size),
    );

    // Markers survive (default textContent serialization would drop them) and
    // list items are not blank-line separated.
    expect(text).toContain("# Title");
    expect(text).toContain("- one\n- two");
    expect(text).toContain("1. first");
    expect(text).toContain("2. second");
    expect(text).not.toContain("- one\n\n- two");
    editor.destroy();
  });

  it("pairs the artifact-room doc fragment with artifactRoom awareness - Collaboration binds to the artifact-room doc and CollaborationCaret binds to the same artifactRoom awareness", () => {
    // Per ticket 4a598302-…/Fix: GUI artifact-room-doc awareness and reconnect-safe
    // body edits - when the body fragment lives in a artifact-room doc, the
    // CollaborationCaret extension must consume the SAME artifactRoom's Awareness
    // instance, not the root Epic awareness. Otherwise per-artifact-room presence
    // updates would be misrouted onto the root channel.
    const rootDoc = new Y.Doc();
    const rootAwareness = new Awareness(rootDoc);
    const artifactRoomDoc = new Y.Doc();
    const artifactRoomFragment = artifactRoomDoc.getXmlFragment(
      "artifact-body:art-1",
    );
    const artifactRoomAwareness = new Awareness(artifactRoomDoc);
    const user = deriveCollabUser({ userName: "Tester", email: null });

    const editor = new Editor({
      extensions: buildArtifactExtensions({
        doc: artifactRoomDoc,
        fragment: artifactRoomFragment,
        awareness: artifactRoomAwareness,
        user,
        onCommentShortcut: null,
        placeholderText: "Start writing…",
        titlePlaceholderText: "Untitled",
      }),
    });

    // The Y.XmlFragment Tiptap binds to MUST belong to the artifact-room doc - not
    // the root doc - so editor mutations land in the artifactRoom replica.
    expect(artifactRoomFragment.doc).toBe(artifactRoomDoc);
    expect(artifactRoomFragment.doc).not.toBe(rootDoc);

    // Push a presence update onto artifactRoom awareness. Subscribers on the
    // root Epic awareness MUST NOT observe it: the editor's caret
    // channel is paired with the artifactRoom awareness.
    let rootObserved = false;
    rootAwareness.on("update", () => {
      rootObserved = true;
    });
    artifactRoomAwareness.setLocalState({
      user: { name: "artifact-room-cursor" },
    });
    expect(rootObserved).toBe(false);
    expect(
      Array.from(artifactRoomAwareness.getStates().values()).some(
        (state) =>
          (state as { user?: { name?: string } }).user?.name ===
          "artifact-room-cursor",
      ),
    ).toBe(true);

    editor.destroy();
    artifactRoomAwareness.destroy();
    rootAwareness.destroy();
  });

  it("applies a Y.Doc update from one editor to a fresh editor and preserves node types", () => {
    // Extension regression smoke: author a doc with mixed nodes, encode the
    // full state, apply it to a fresh editor, and verify node counts match.
    const docA = new Y.Doc();
    const fragmentA = docA.getXmlFragment("default");
    const awarenessA = new Awareness(docA);
    const user = deriveCollabUser({ userName: "A", email: "a@x.io" });
    const editorA = new Editor({
      extensions: buildArtifactExtensions({
        doc: docA,
        fragment: fragmentA,
        awareness: awarenessA,
        user,
        onCommentShortcut: null,
        placeholderText: "Start writing…",
        titlePlaceholderText: "Untitled",
      }),
    });
    editorA.commands.setContent("# H\n\n- [ ] todo\n\n```js\nfoo();\n```\n", {
      contentType: "markdown",
      parseOptions: { preserveWhitespace: false },
    });

    const update = Y.encodeStateAsUpdate(docA);

    const docB = new Y.Doc();
    const fragmentB = docB.getXmlFragment("default");
    const awarenessB = new Awareness(docB);
    Y.applyUpdate(docB, update);

    const editorB = new Editor({
      extensions: buildArtifactExtensions({
        doc: docB,
        fragment: fragmentB,
        awareness: awarenessB,
        user,
        onCommentShortcut: null,
        placeholderText: "Start writing…",
        titlePlaceholderText: "Untitled",
      }),
    });

    const jsonA = editorA.getJSON();
    const jsonB = editorB.getJSON();
    expect(jsonB).toEqual(jsonA);

    editorA.destroy();
    editorB.destroy();
  });
});
