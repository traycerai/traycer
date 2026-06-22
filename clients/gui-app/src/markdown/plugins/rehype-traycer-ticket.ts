import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import { TRAYCER_TICKET_TAG } from "./const";
import { extractTextContent, pickStringProp } from "./hast-utils";

export function rehypeTraycerTicket() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== TRAYCER_TICKET_TAG) {
        return;
      }

      const epicId = pickStringProp(node.properties, "epicid", "epicId");
      const ticketId = pickStringProp(node.properties, "ticketid", "ticketId");
      const title = pickStringProp(node.properties, "title");

      if (epicId === undefined || ticketId === undefined) {
        return;
      }

      const displayText = extractTextContent(node.children).trim();
      if (!displayText) {
        return;
      }

      node.tagName = TRAYCER_TICKET_TAG;
      node.properties = {
        "data-epic-id": epicId,
        "data-ticket-id": ticketId,
      };

      if (title !== undefined) {
        node.properties["data-title"] = title;
      }
    });

    return tree;
  };
}
