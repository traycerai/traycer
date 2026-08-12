/**
 * Artifact image node view: loading / unavailable / ready states, SVG
 * thumbnails via <img>, and shared lightbox path. mediaType is stored on the
 * node (from prepare) and forwarded to the blob resolver + lightbox.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import { ArtifactToolbar } from "@/editor-core/toolbar/artifact-toolbar";

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

const useAttachmentBlobSrcMock = vi.hoisted(() =>
  vi.fn(
    (
      _hash: string | null,
      _mediaType: string,
      _dataUrl: string | null,
    ): AttachmentBlobState => blobSrcState.value,
  ),
);

vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useAttachmentBlobSrc: (
    hash: string | null,
    mediaType: string,
    dataUrl: string | null,
  ) => useAttachmentBlobSrcMock(hash, mediaType, dataUrl),
}));

vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({ isPending: false, mutate: vi.fn() }),
}));

function mountImageEditor(attrs: {
  readonly src: string;
  readonly alt: string;
  readonly attachmentHash: string;
  readonly mediaType: string | null;
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

function renderWithQueryClient(children: ReactNode): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  blobSrcState.value = { status: "loading", src: null };
  useAttachmentBlobSrcMock.mockClear();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  blobSrcState.value = { status: "loading", src: null };
  useAttachmentBlobSrcMock.mockClear();
});

describe("ArtifactImageNodeView", () => {
  it("renders the loading chip while attachment bytes are syncing", async () => {
    blobSrcState.value = { status: "loading", src: null };
    const editor = mountImageEditor({
      src: "images/hash.png",
      alt: "pending",
      attachmentHash: "hash",
      mediaType: "image/png",
    });
    renderWithQueryClient(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    const loading = await screen.findByText(/waiting for image sync/i);
    expect(loading).toBeTruthy();
    expect(loading.style.maxWidth).toBe("");
    expect(screen.queryByRole("img")).toBeNull();
    expect(useAttachmentBlobSrcMock).toHaveBeenCalledWith(
      "hash",
      "image/png",
      null,
    );
    editor.destroy();
  });

  it("renders the unavailable chip when the attachment cannot be resolved", async () => {
    blobSrcState.value = { status: "unavailable", src: null };
    const editor = mountImageEditor({
      src: "images/missing.png",
      alt: "gone",
      attachmentHash: "missing",
      mediaType: "image/png",
    });
    renderWithQueryClient(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );
    expect(await screen.findByText(/image is unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(useAttachmentBlobSrcMock).toHaveBeenCalledWith(
      "missing",
      "image/png",
      null,
    );
    editor.destroy();
  });

  it("renders a ready PNG through the shared lightbox path with stored mediaType", async () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/ready-png",
    };
    const editor = mountImageEditor({
      src: "images/ready.png",
      alt: "ready shot",
      attachmentHash: "ready",
      mediaType: "image/png",
    });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <EditorContext.Provider value={{ editor }}>
          <EditorContent editor={editor} />
        </EditorContext.Provider>
      </QueryClientProvider>,
    );
    const img = await waitFor((): HTMLImageElement => {
      const found = container.querySelector("img");
      if (found === null) throw new Error("img not mounted");
      return found;
    });
    expect(img.getAttribute("src")).toBe("blob:http://localhost/ready-png");
    expect(img.getAttribute("alt")).toBe("ready shot");
    const nodeView = container.querySelector<HTMLElement>(
      "[data-node-view-wrapper]",
    );
    expect(nodeView?.classList.contains("not-prose")).toBe(true);
    expect(nodeView?.classList.contains("w-fit")).toBe(false);
    const imageCard = nodeView?.firstElementChild;
    expect(imageCard).toBeInstanceOf(HTMLElement);
    if (!(imageCard instanceof HTMLElement)) {
      throw new Error("image card not mounted");
    }
    expect(imageCard.classList.contains("w-full")).toBe(true);
    expect(imageCard.style.maxWidth).toBe("");
    expect(img.classList.contains("w-full")).toBe(true);
    expect(img.style.maxHeight).toBe("");
    expect(
      screen
        .getByRole("button", { name: /open ready shot/i })
        .parentElement?.classList.contains("@container"),
    ).toBe(false);
    expect(useAttachmentBlobSrcMock).toHaveBeenCalledWith(
      "ready",
      "image/png",
      null,
    );
    // Lightbox trigger wraps the thumbnail.
    expect(
      screen.getByRole("button", { name: /open ready shot/i }),
    ).toBeTruthy();
    fireEvent.load(img);
    editor.destroy();
  });

  it("does not show the text formatting toolbar for an image selection", async () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/selected-png",
    };
    const editor = mountImageEditor({
      src: "images/selected.png",
      alt: "selected shot",
      attachmentHash: "selected",
      mediaType: "image/png",
    });
    renderWithQueryClient(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          scrollTarget={null}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );

    editor.commands.setNodeSelection(0);

    await waitFor(() => {
      expect(
        screen.queryByRole("toolbar", {
          name: "Editor formatting",
          hidden: true,
        }),
      ).toBeNull();
    });
    editor.destroy();
  });

  it("renders SVG thumbnails with <img> and opens the shared sanitizer lightbox", async () => {
    blobSrcState.value = {
      status: "ready",
      src: "blob:http://localhost/ready-svg",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("<svg xmlns='http://www.w3.org/2000/svg'></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
        ),
      ),
    );
    const editor = mountImageEditor({
      src: "images/icon.svg",
      alt: "icon",
      attachmentHash: "icon-hash",
      mediaType: "image/svg+xml",
    });
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <EditorContext.Provider value={{ editor }}>
          <EditorContent editor={editor} />
        </EditorContext.Provider>
      </QueryClientProvider>,
    );
    const img = await waitFor((): HTMLImageElement => {
      const found = container.querySelector("img");
      if (found === null) throw new Error("img not mounted");
      return found;
    });
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    // Thumbnail is an <img> (chat SVG policy). Lucide action icons may still
    // appear as decorative SVGs in the shared lightbox chrome.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(useAttachmentBlobSrcMock).toHaveBeenCalledWith(
      "icon-hash",
      "image/svg+xml",
      null,
    );

    fireEvent.click(screen.getByRole("button", { name: /open icon/i }));
    // Shared SVG lightbox loads through the sanitizer path (not a raw <img>).
    expect(await screen.findByLabelText(/loading svg/i)).toBeTruthy();
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const [url, init] = calls[0] as [
        RequestInfo | URL,
        RequestInit | undefined,
      ];
      expect(url).toBe("blob:http://localhost/ready-svg");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
    editor.destroy();
  });
});
