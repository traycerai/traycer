/**
 * That the artifact attachment SCOPE actually reaches the image node view.
 *
 * This is a probe, not a formality. The whole lane-arm byte path hangs on React
 * context crossing into a Tiptap NodeView, which is rendered through a portal
 * created by `ReactNodeViewRenderer` rather than as an ordinary child of the
 * provider. If it does not cross, `useArtifactAttachmentScope()` reads `null`
 * inside the node view, the fetcher silently takes its no-scope branch, and
 * every artifact image on a lane-backed host stays unavailable - with nothing
 * failing anywhere to say so. An inert fix that looks correct in review is the
 * exact failure this file exists to exclude.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";
import {
  ArtifactAttachmentScopeContext,
  useArtifactAttachmentScope,
  type ArtifactAttachmentScopeValue,
} from "@/lib/attachments/artifact-attachment-scope-context";

/**
 * The node view's own hook chain, replaced by one that reports what the scope
 * looks like FROM INSIDE the node view. The real `useAttachmentBlobSrc` would
 * resolve bytes; the only question here is what context it can see when it
 * runs, so this stands in its place and renders the answer.
 */
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useAttachmentBlobSrc: (): {
    status: "unavailable";
    src: null;
  } => {
    const scope = useArtifactAttachmentScope();
    seenScopes.push(scope);
    return { status: "unavailable", src: null };
  },
}));

const seenScopes: Array<ArtifactAttachmentScopeValue | null> = [];

const SCOPE: ArtifactAttachmentScopeValue = {
  epicId: "epic-1",
  artifactId: "artifact-1",
  hostId: "host-1",
  hostVersion: "1.2.3",
  client: null,
};

afterEach(() => {
  cleanup();
  seenScopes.length = 0;
});

function mountImageEditor(): Editor {
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
    attrs: {
      src: "images/hash.png",
      alt: "scoped",
      attachmentHash: "hash",
      mediaType: "image/png",
    },
  });
  return editor;
}

describe("ArtifactImageNodeView - attachment scope", () => {
  it("sees the provider's scope through the node-view portal", async () => {
    const editor = mountImageEditor();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ArtifactAttachmentScopeContext.Provider value={SCOPE}>
          <EditorContext.Provider value={{ editor }}>
            <EditorContent editor={editor} />
          </EditorContext.Provider>
        </ArtifactAttachmentScopeContext.Provider>
      </QueryClientProvider>,
    );

    await screen.findByText(/image is unavailable/i);

    // Not "was called" - what it SAW. A node view rendered outside the
    // provider's tree would still run and still be recorded, holding `null`.
    expect(seenScopes.length).toBeGreaterThan(0);
    expect(seenScopes.at(-1)).toEqual(SCOPE);
    editor.destroy();
  });

  it("reads null with no provider, so the fetcher's no-scope branch is reachable", async () => {
    const editor = mountImageEditor();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EditorContext.Provider value={{ editor }}>
          <EditorContent editor={editor} />
        </EditorContext.Provider>
      </QueryClientProvider>,
    );

    await screen.findByText(/image is unavailable/i);

    // The control: this is what a BROKEN propagation would look like above, so
    // the pin can only pass by the two states genuinely differing.
    expect(seenScopes.at(-1)).toBeNull();
    editor.destroy();
  });
});
