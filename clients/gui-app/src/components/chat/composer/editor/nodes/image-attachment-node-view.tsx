import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ImageIcon } from "lucide-react";
import { memo } from "react";

import {
  COMPOSER_INLINE_CHIP_CLASSNAME,
  COMPOSER_INLINE_CHIP_ICON_CLASSNAME,
  COMPOSER_INLINE_CHIP_TEXT_CLASSNAME,
} from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { fallbackImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { imageAttachmentDisplayLabelFromDecorations } from "./image-attachment-label-decorations";

const IMAGE_ATTACHMENT_ICON_CLASSNAME = `${COMPOSER_INLINE_CHIP_ICON_CLASSNAME} text-muted-foreground`;

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
      className={COMPOSER_INLINE_CHIP_CLASSNAME}
      contentEditable={false}
      data-composer-image-atom=""
      data-composer-image-id={id ?? undefined}
      data-composer-chip="image-attachment"
      title={label.title}
    >
      <ImageIcon className={IMAGE_ATTACHMENT_ICON_CLASSNAME} aria-hidden />
      <span className={COMPOSER_INLINE_CHIP_TEXT_CLASSNAME}>
        {label.inlineLabel}
      </span>
    </NodeViewWrapper>
  );
}

function imageFileName(attrs: Record<string, unknown>): string {
  return stringValue(attrs.fileName) ?? "Image";
}

export const ImageAttachmentNodeView = memo(ImageAttachmentNodeViewBase);
