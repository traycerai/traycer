import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { memo } from "react";

import { BotBoxMentionChip } from "@/components/bots/bot-mention-chip";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import {
  BOT_TOKEN_CONTEXT_TYPE,
  mentionAttachmentFromAttrs,
  mentionChipText,
  mentionPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";

function MentionNodeViewBase(props: NodeViewProps) {
  if (props.node.attrs.contextType === BOT_TOKEN_CONTEXT_TYPE) {
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <BotBoxMentionChip token={String(props.node.attrs.id)}>
          {mentionChipText(props.node.attrs)}
        </BotBoxMentionChip>
      </NodeViewWrapper>
    );
  }
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
