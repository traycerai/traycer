import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";
import { BOT_MENTION_TOKEN } from "@/lib/bots/bot-mentions";
import { TRAYCER_MENTION_TAG } from "./const";

/**
 * Turns each `<@userId>` of a message's text into a mention element that
 * keeps the token as its text, for a bot channel to draw as the member's
 * chip. Code and links keep the token as written.
 */
export function rehypeBotMentions() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      if (
        "tagName" in parent &&
        (parent.tagName === "code" ||
          parent.tagName === "a" ||
          parent.tagName === TRAYCER_MENTION_TAG)
      ) {
        return;
      }
      const parts = splitMentions(node.value);
      if (parts === null) return;
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
    return tree;
  };
}

function splitMentions(value: string): Array<Text | Element> | null {
  if (!value.includes("<@")) return null;
  const nodes: Array<Text | Element> = [];
  let cursor = 0;
  for (const match of value.matchAll(BOT_MENTION_TOKEN)) {
    const start = match.index;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push({
      type: "element",
      tagName: TRAYCER_MENTION_TAG,
      properties: { "data-user-id": match[1] },
      children: [{ type: "text", value: match[0] }],
    });
    cursor = start + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}
