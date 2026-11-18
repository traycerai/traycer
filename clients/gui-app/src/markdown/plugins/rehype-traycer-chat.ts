import { TRAYCER_CHAT_TAG } from "./const";
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";
import { pickStringProp } from "./hast-utils";

/**
 * Turns a `<traycer-chat epicId chatId>` tag into the reference component's
 * data attributes. The tag needs no text inside it: the component draws the
 * agent's title from the ids.
 */
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
