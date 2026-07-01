import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { memo } from "react";

import { slashCommandPlainTextFromAttrs } from "@/lib/composer/tiptap-json-content";
import { SlashCommandChip } from "../../nodes/slash-command-chip";

function SlashCommandNodeViewBase(props: NodeViewProps) {
  const label = slashCommandPlainTextFromAttrs(props.node.attrs);

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <SlashCommandChip name={label} density="regular" />
    </NodeViewWrapper>
  );
}

export const SlashCommandNodeView = memo(SlashCommandNodeViewBase);
