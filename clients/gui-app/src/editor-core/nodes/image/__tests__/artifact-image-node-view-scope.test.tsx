/** NodeView is portalled by ReactNodeViewRenderer; attachment scope must still reach the image fetcher or lane-backed images fail silently. */
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

/** Stand-in for useAttachmentBlobSrc that reports the scope seen inside the node view; the real hook would resolve bytes. */
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
