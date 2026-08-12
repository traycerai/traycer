import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ArtifactImageNodeView } from "./artifact-image-node-view";

/** Artifact image schema: portable src/alt plus collaboration-only render data. */
export const ArtifactImageNode = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      attachmentHash: { default: null, rendered: false },
      mediaType: { default: null, rendered: false },
    };
  },
  // Images are admitted through the prepare/commit flow below the editor.
  // Parsing arbitrary HTML `<img>` nodes would create a durable node without
  // the attachment hash that its renderer requires.
  parseHTML() {
    return [];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ArtifactImageNodeView);
  },
});
