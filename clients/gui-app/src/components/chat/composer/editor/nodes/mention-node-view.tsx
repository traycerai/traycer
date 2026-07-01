import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { memo } from "react";

import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import {
  mentionAttachmentFromAttrs,
  mentionPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";

function MentionNodeViewBase(props: NodeViewProps) {
  const mention = mentionAttachmentFromAttrs(props.node.attrs);

  if (mention === null) {
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        {mentionPlainTextFromAttrs(props.node.attrs)}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <ComposerMentionDecorator mention={mention} density="regular" />
    </NodeViewWrapper>
  );
}

export const MentionNodeView = memo(MentionNodeViewBase);
