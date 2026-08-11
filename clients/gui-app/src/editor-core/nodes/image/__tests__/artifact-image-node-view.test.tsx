/**
 * Artifact image node view: loading / unavailable / ready states, SVG
 * thumbnails via <img>, and shared lightbox path.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

interface AttachmentBlobState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly src: string | null;
}

const blobSrcState = vi.hoisted((): { value: AttachmentBlobState } => ({
  value: {
    status: "loading",
    src: null,
  },
}));

vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useAttachmentBlobSrc: () => blobSrcState.value,
}));

function mountImageEditor(attrs: {
  readonly src: string;
  readonly alt: string;
  readonly attachmentHash: string;
}): Editor {
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
  editor.commands.insertContent({
    type: "image",
    attrs,
  });
  return editor;
}

afterEach(() => {
  cleanup();
  blobSrcState.value = { status: "loading", src: null };
});

beforeEach(() => {
  blobSrcState.value = { status: "loading", src: null };
});

describe("ArtifactImageNodeView", () => {
  it("renders the loading chip while attachment bytes are syncing", async () => {
    blobSrcState.value = { status: "loading", src: null };
    const editor = mountImageEditor({
      src: "images/hash.png",
      alt: "pending",
      attachmentHash: "hash",
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(await screen.findByText(/waiting for image sync/i)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    editor.destroy();
  });

  it("renders the unavailable chip when the attachment cannot be resolved", async () => {
    blobSrcState.value = { status: "unavailable", src: null };
    const editor = mountImageEditor({
      src: "images/missing.png",
      alt: "gone",
      attachmentHash: "missing",
    });
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(await screen.findByText(/image is unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    editor.destroy();
  });

  it("renders a ready PNG through the shared lightbox path", async () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/ready-png",
    };
    const editor = mountImageEditor({
      src: "images/ready.png",
      alt: "ready shot",
      attachmentHash: "ready",
    });
    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const img = await waitFor((): HTMLImageElement => {
      const found = container.querySelector("img");
      if (found === null) throw new Error("img not mounted");
      return found;
    });
    expect(img.getAttribute("src")).toBe("blob:http://localhost/ready-png");
    expect(img.getAttribute("alt")).toBe("ready shot");
    // Lightbox trigger wraps the thumbnail.
    expect(
      screen.getByRole("button", { name: /open ready shot/i }),
    ).toBeTruthy();
    fireEvent.load(img);
    editor.destroy();
  });

  it("renders SVG thumbnails with <img>, not inline SVG markup", async () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/ready-svg",
    };
    const editor = mountImageEditor({
      src: "images/icon.svg",
      alt: "icon",
      attachmentHash: "icon-hash",
    });
    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const img = await waitFor((): HTMLImageElement => {
      const found = container.querySelector("img");
      if (found === null) throw new Error("img not mounted");
      return found;
    });
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("blob:http://localhost/ready-svg");
    // Thumbnail is an <img> (chat SVG policy). Lucide action icons may still
    // appear as decorative SVGs in the shared lightbox chrome.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /open icon/i })).toBeTruthy();
    editor.destroy();
  });
});
