import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { extractTextContent, isElement } from "./hast-utils";
import { TRAYCER_MERMAID_TAG } from "./const";

function hasMermaidLanguageClass(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === "string" && entry === "language-mermaid",
    );
  }
  if (typeof value === "string") {
    return value.split(/\s+/).includes("language-mermaid");
  }
  return false;
}

function findMermaidCodeChild(node: Element): Element | null {
  for (const child of node.children) {
    if (
      isElement(child) &&
      child.tagName === "code" &&
      hasMermaidLanguageClass(child.properties.className)
    ) {
      return child;
    }
  }
  return null;
}

export function rehypeCustomMermaid() {
  return (tree: Root) => {
    visit(tree, "element", (node, index, parent) => {
      if (
        node.tagName !== "pre" ||
        parent === undefined ||
        index === undefined
      ) {
        return;
      }
      const codeChild = findMermaidCodeChild(node);
      if (codeChild === null) return;
      const code = extractTextContent(codeChild.children);
      const replacement: Element = {
        type: "element",
        tagName: TRAYCER_MERMAID_TAG,
        properties: { "data-code": encodeURIComponent(code) },
        children: [],
      };
      parent.children[index] = replacement;
    });

    return tree;
  };
}
