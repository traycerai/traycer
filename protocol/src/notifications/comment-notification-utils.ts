import type { JsonContent } from "../common/registry";

/**
 * Extracts unique user IDs from mention nodes in Tiptap JSONContent.
 * Uses a targeted walk because the main tiptap-editor-parser does not
 * handle ContextType.User mentions.
 */
export function extractUserMentionIds(content: JsonContent): string[] {
  const userIds = new Set<string>();

  function walk(node: JsonContent): void {
    if (
      node.type === "mention" &&
      node.attrs?.contextType === "user"
    ) {
      const id = node.attrs.id;
      if (typeof id === "string" && id) {
        userIds.add(id);
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child);
      }
    }
  }

  walk(content);
  return [...userIds];
}
