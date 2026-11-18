/**
 * The mermaid node view primes the mermaid chunk at mount, before its
 * debounced render. When the renderer cannot load that chunk, the prime's
 * rejection must stay handled: the render reports the failure in the block.
 */
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { appLogger } from "@/lib/logger";

vi.mock("mermaid", () => {
  throw new TypeError(
    "Failed to fetch dynamically imported module: app://renderer/assets/mermaid.js",
  );
});

function mountMermaidEditor(code: string): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const user = deriveCollabUser({ userName: "I", email: "i@x.io" });
  const editor = new Editor({
    editable: true,
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
  editor.commands.insertContent({ type: "mermaidBlock", attrs: { code } });
  return editor;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MermaidNodeView prime", () => {
  it("leaves no unhandled rejection when the mermaid chunk fails to load", async () => {
    const warn = vi.spyOn(appLogger, "warn");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const editor = mountMermaidEditor("graph TD\n  A --> B");
    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <EditorContext.Provider value={{ editor }}>
            <EditorContent editor={editor} />
          </EditorContext.Provider>
        </QueryClientProvider>,
      );
      // The prime rejects at mount, well inside the render's 500 ms debounce,
      // so nothing else holds the promise yet. Node reports an unhandled
      // rejection once a macrotask passes.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toEqual([]);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        "[mermaid] preload failed",
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      editor.destroy();
    }
  });
});
