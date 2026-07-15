import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

const HTML = "<div><h1>Hello</h1><p>World</p></div>";

function mountWireframeEditor(opts: {
  readonly htmlContent: string;
  readonly title: string;
  readonly editable: boolean;
}): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const user = deriveCollabUser({ userName: "W", email: "w@x.io" });
  const editor = new Editor({
    editable: opts.editable,
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
  editor.commands.insertContent({
    type: "uiPreviewBlock",
    attrs: { htmlContent: opts.htmlContent, title: opts.title },
  });
  return editor;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("WireframeNodeView", () => {
  it("renders an interactive, opaque-origin iframe with the height reporter appended", async () => {
    const editor = mountWireframeEditor({
      htmlContent: HTML,
      title: "Demo",
      editable: true,
    });
    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const el = await waitFor((): HTMLIFrameElement => {
      const found = container.querySelector("iframe");
      if (found === null) throw new Error("iframe not mounted yet");
      return found;
    });
    expect(el.getAttribute("sandbox")).toBe("allow-scripts");
    expect(el.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(el.getAttribute("srcdoc")?.endsWith(HTML)).toBe(true);
    expect(el.getAttribute("srcdoc")).toContain("traycer:wireframe:height:v1");
    expect(el.getAttribute("title")).toBe("Demo");
    editor.destroy();
  });

  it("exposes Fullscreen + Copy HTML actions for editable users", async () => {
    const editor = mountWireframeEditor({
      htmlContent: HTML,
      title: "Demo",
      editable: true,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(
      await screen.findByRole("button", { name: /fullscreen/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /copy html/i }),
    ).toBeTruthy();
    editor.destroy();
  });

  it("retains both actions for read-only viewers", async () => {
    const editor = mountWireframeEditor({
      htmlContent: HTML,
      title: "Demo",
      editable: false,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(
      await screen.findByRole("button", { name: /fullscreen/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /copy html/i }),
    ).toBeTruthy();
    editor.destroy();
  });

  it("copies the HTML body via navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    const editor = mountWireframeEditor({
      htmlContent: HTML,
      title: "Demo",
      editable: true,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const copy = await screen.findByRole("button", { name: /copy html/i });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(HTML);
    editor.destroy();
  });

  it("opens the fullscreen dialog when Fullscreen is clicked", async () => {
    const editor = mountWireframeEditor({
      htmlContent: HTML,
      title: "Demo",
      editable: true,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const open = await screen.findByRole("button", { name: /fullscreen/i });
    fireEvent.click(open);
    // Dialog renders an accessible name from DialogTitle.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Demo");
    editor.destroy();
  });
});
