import Image from "@tiptap/extension-image";

/** Artifact image schema: portable src/alt plus a collaboration-only hash. */
export const ArtifactImageNode = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      attachmentHash: { default: null, rendered: false },
    };
  },
});
