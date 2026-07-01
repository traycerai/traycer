import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ImageIcon } from "lucide-react";
import { memo } from "react";

import { composerInlineChipClassNames } from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { fallbackImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { imageAttachmentDisplayLabelFromDecorations } from "./image-attachment-label-decorations";

const IMAGE_ATTACHMENT_CLASS_NAMES = composerInlineChipClassNames("regular");

function ImageAttachmentNodeViewBase(props: NodeViewProps) {
  const fileName = imageFileName(props.node.attrs);
  const id = stringValue(props.node.attrs.id);
  const label =
    imageAttachmentDisplayLabelFromDecorations(props.decorations) ??
    fallbackImageAttachmentDisplayLabel({
      id: id ?? "",
      fileName,
    });

  return (
    <NodeViewWrapper
      as="span"
      aria-label={`Attached ${label.ariaLabel}`}
      className={IMAGE_ATTACHMENT_CLASS_NAMES.root}
      contentEditable={false}
      data-composer-image-atom=""
      data-composer-image-id={id ?? undefined}
      data-composer-chip="image-attachment"
      title={label.title}
    >
      <ImageIcon
        className={IMAGE_ATTACHMENT_CLASS_NAMES.mutedIcon}
        aria-hidden
      />
      <span className={IMAGE_ATTACHMENT_CLASS_NAMES.text}>
        {label.inlineLabel}
      </span>
    </NodeViewWrapper>
  );
}

function imageFileName(attrs: Record<string, unknown>): string {
  return stringValue(attrs.fileName) ?? "Image";
}

export const ImageAttachmentNodeView = memo(ImageAttachmentNodeViewBase);
