import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import { TRAYCER_SPEC_TAG } from "./const";
import { extractTextContent, pickStringProp } from "./hast-utils";

export function rehypeTraycerSpec() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== TRAYCER_SPEC_TAG) {
        return;
      }

      const epicId = pickStringProp(node.properties, "epicid", "epicId");
      const specId = pickStringProp(node.properties, "specid", "specId");
      const title = pickStringProp(node.properties, "title");

      if (epicId === undefined || specId === undefined) {
        return;
      }

      const displayText = extractTextContent(node.children).trim();
      if (!displayText) {
        return;
      }

      node.tagName = TRAYCER_SPEC_TAG;
      node.properties = {
        "data-epic-id": epicId,
        "data-spec-id": specId,
      };

      if (title !== undefined) {
        node.properties["data-title"] = title;
      }
    });

    return tree;
  };
}
