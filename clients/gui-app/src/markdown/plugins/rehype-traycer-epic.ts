import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import { TRAYCER_EPIC_TAG } from "./const";
import { extractTextContent, pickStringProp } from "./hast-utils";

export function rehypeTraycerEpic() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== TRAYCER_EPIC_TAG) {
        return;
      }

      const epicId = pickStringProp(node.properties, "epicid", "epicId");
      const title = pickStringProp(node.properties, "title");

      if (epicId === undefined) {
        return;
      }

      const displayText = extractTextContent(node.children).trim();
      if (!displayText) {
        return;
      }

      node.tagName = TRAYCER_EPIC_TAG;
      node.properties = {
        "data-epic-id": epicId,
      };

      if (title !== undefined) {
        node.properties["data-title"] = title;
      }
    });

    return tree;
  };
}
