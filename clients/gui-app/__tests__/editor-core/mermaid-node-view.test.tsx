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

// Mocks must be declared before the editor imports the service.
vi.mock("@/editor-core/nodes/mermaid/mermaid-service", () => {
  return {
    ensureMermaidReady: vi.fn().mockResolvedValue(undefined),
    parseMermaid: vi.fn().mockImplementation((code: string) => {
      if (code.includes("!!!")) {
        return Promise.reject(new Error("Parse error: bad token !!!"));
      }
      return Promise.resolve();
    }),
    renderMermaidSvg: vi.fn().mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    }),
    svgToPngBlob: vi
      .fn()
      .mockResolvedValue(new Blob(["mock-png"], { type: "image/png" })),
    saveBlobToDisk: vi.fn().mockResolvedValue("mermaid-diagram.png"),
    subscribeMermaidTheme: vi.fn().mockReturnValue(() => undefined),
    getMermaidThemeVersion: vi.fn().mockReturnValue(0),
    deriveMermaidAriaLabel: (code: string): string => {
      const firstLine = code
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return firstLine && firstLine.length > 0 ? firstLine : "Mermaid diagram";
    },
    deriveMermaidErrorMessage: (err: unknown): string => {
      if (err instanceof Error) return err.message;
      if (typeof err === "string") return err;
      return "Failed to render diagram";
    },
  };
});

// CodeMirror is heavy and not under test; replace with a lightweight textarea.
vi.mock("@/editor-core/nodes/mermaid/mermaid-code-editor", () => {
  return {
    MermaidCodeEditor: (props: {
      value: string;
      onChange: (v: string) => void;
    }) => (
      <textarea
        aria-label="mermaid source"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    ),
  };
});

function mountMermaidEditor(opts: {
  readonly code: string;
  readonly editable: boolean;
}): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const user = deriveCollabUser({ userName: "M", email: "m@x.io" });
  const editor = new Editor({
    editable: opts.editable,
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
    }),
  });
  // Insert a mermaidBlock directly so we don't go through markdown parse.
  editor.commands.insertContent({
    type: "mermaidBlock",
    attrs: { code: opts.code },
  });
  return editor;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // jsdom does not implement clipboard.writeText; install a stub.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("MermaidNodeView", () => {
  it("renders the SVG returned by mermaid-service", async () => {
    const editor = mountMermaidEditor({
      code: "graph TD\n  A --> B",
      editable: true,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const region = await screen.findByRole("img", { name: /graph TD/ });
    await waitFor(() => {
      expect(region.querySelector("svg")).not.toBeNull();
    });
    editor.destroy();
  });

  it("exposes copy + download buttons in the floating toolbar", async () => {
    const editor = mountMermaidEditor({
      code: "graph TD\n  A --> B",
      editable: true,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(
      await screen.findByRole("button", { name: /copy code/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /download png/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /edit source/i }),
    ).toBeTruthy();
    editor.destroy();
  });

  it("hides Edit source for read-only viewers but keeps Copy / Download", async () => {
    const editor = mountMermaidEditor({
      code: "graph TD\n  A --> B",
      editable: false,
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(
      await screen.findByRole("button", { name: /copy code/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /download png/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /edit source/i })).toBeNull();
    editor.destroy();
  });

  it("copies the source via navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    const code = "graph TD\n  A --> B";
    const editor = mountMermaidEditor({ code, editable: true });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const copy = await screen.findByRole("button", { name: /copy code/i });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(code);
    editor.destroy();
  });

  it("renders an error panel when mermaid parse fails", async () => {
    const editor = mountMermaidEditor({ code: "!!!", editable: true });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const alert = await screen.findByRole("alert", undefined, {
      timeout: 2000,
    });
    expect(alert.textContent).toMatch(/mermaid parse error/i);
    expect(alert.textContent).toMatch(/bad token/i);
    editor.destroy();
  });
});
