import { TRAYCER_CHAT_TAG } from "./const";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";
import { extractTextContent, pickStringProp } from "./hast-utils";

export function rehypeTraycerChat() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== TRAYCER_CHAT_TAG) {
        return;
      }

      const epicId = pickStringProp(node.properties, "epicid", "epicId");
      const chatId = pickStringProp(node.properties, "chatid", "chatId");
      const title = pickStringProp(node.properties, "title");

      if (epicId === undefined || chatId === undefined) {
        return;
      }

      const displayText = extractTextContent(node.children).trim();
      if (!displayText) {
        return;
      }

      node.tagName = TRAYCER_CHAT_TAG;
      node.properties = {
        "data-epic-id": epicId,
        "data-chat-id": chatId,
      };

      if (title !== undefined) {
        node.properties["data-title"] = title;
      }
    });

    return tree;
  };
}
