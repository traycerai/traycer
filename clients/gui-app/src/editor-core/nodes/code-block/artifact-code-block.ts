import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ArtifactCodeBlockNodeView } from "./artifact-code-block-node-view";

export const ArtifactCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ArtifactCodeBlockNodeView);
  },
});
