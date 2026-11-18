import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { memo } from "react";

import { slashCommandLabelFromAttrs } from "@/lib/composer/tiptap-json-content";
import { SlashCommandChip } from "../../nodes/slash-command-chip";

function SlashCommandNodeViewBase(props: NodeViewProps) {
  // Label, not plain text: a `$`-picked skill reads back as `$name` even though
  // it still serializes to `/name`.
  const label = slashCommandLabelFromAttrs(props.node.attrs);

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <SlashCommandChip name={label} density="regular" />
    </NodeViewWrapper>
  );
}

export const SlashCommandNodeView = memo(SlashCommandNodeViewBase);
