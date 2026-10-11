import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { JsonContent } from "@traycer/protocol/common/registry";

export function changedComposerImages(
  doc: Node,
  transactions: readonly Transaction[],
): JsonContent | null {
  const mapping = new Mapping();
  for (const transaction of transactions) {
    mapping.appendMapping(transaction.mapping);
  }
  const images = new Set<Node>();
  mapping.maps.forEach((stepMap, index) => {
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (newFrom === newTo) return;
      // A later step (including an appended transaction) can move or remove
      // the inserted range. Inspect its final positions, not its old offsets.
      const remaining = mapping.slice(index + 1);
      const from = remaining.map(newFrom, -1);
      const to = remaining.map(newTo);
      if (from >= to) return;
      doc.nodesBetween(from, to, (node) => {
        if (node.type.name === "imageAttachment") images.add(node);
      });
    });
  });
  if (images.size === 0) return null;
  return {
    type: "doc",
    content: Array.from(images, (node) => ({
      type: "imageAttachment",
      attrs: node.attrs,
    })),
  };
}
