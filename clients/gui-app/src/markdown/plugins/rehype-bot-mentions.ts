import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";
import { BOT_MENTION_TOKEN, mentionOfToken } from "@/lib/bots/bot-mentions";
import { TRAYCER_MENTION_TAG } from "./const";

/** The attribute each kind's mention element carries its id in. */
const ID_ATTRIBUTE = {
  person: "data-user-id",
  bot: "data-bot-id",
  task: "data-task-id",
} as const;

/**
 * Turns each `<@userId>`, `<#botId>` and `<~epicId>` of a message's text into
 * a mention element that keeps the token as its text, for a bot channel to
 * draw as the member's, the bot's or the task's chip. Code and links keep
 * the token as written.
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
  if (!/<[@#~]/.test(value)) return null;
  const nodes: Array<Text | Element> = [];
  let cursor = 0;
  for (const match of value.matchAll(BOT_MENTION_TOKEN)) {
    const start = match.index;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    const { kind, id } = mentionOfToken(match[0]);
    nodes.push({
      type: "element",
      tagName: TRAYCER_MENTION_TAG,
      properties: { [ID_ATTRIBUTE[kind]]: id },
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
