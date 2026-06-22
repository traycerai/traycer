import { NodeViewWrapper } from "@tiptap/react";
import { memo } from "react";

function ImageAttachmentNodeViewBase() {
  return (
    <NodeViewWrapper
      as="span"
      data-composer-image-atom=""
      contentEditable={false}
      style={{
        position: "absolute",
        visibility: "hidden",
        width: 0,
        height: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    />
  );
}

export const ImageAttachmentNodeView = memo(ImageAttachmentNodeViewBase);
