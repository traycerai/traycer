import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { extractTextContent, isElement } from "./hast-utils";

function hasLanguageClass(value: unknown, languageClass: string): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === "string" && entry === languageClass,
    );
  }
  if (typeof value === "string") {
    return value.split(/\s+/).includes(languageClass);
  }
  return false;
}

function findCodeChild(node: Element, languageClass: string): Element | null {
  for (const child of node.children) {
    if (
      isElement(child) &&
      child.tagName === "code" &&
      hasLanguageClass(child.properties.className, languageClass)
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Replaces every fenced code block of one language with a custom element the
 * markdown component map renders as a rich block. The fence body travels on
 * `data-code`, URI-encoded so the sanitizer's attribute pass cannot mangle it.
 * Mermaid diagrams and wireframes are the two languages promoted this way in
 * chat; the artifact editor promotes the same pair into its own node types.
 */
export function rehypePromoteFence(language: string, tagName: string) {
  const languageClass = `language-${language}`;
  return (tree: Root) => {
    visit(tree, "element", (node, index, parent) => {
      if (
        node.tagName !== "pre" ||
        parent === undefined ||
        index === undefined
      ) {
        return;
      }
      const codeChild = findCodeChild(node, languageClass);
      if (codeChild === null) return;
      const code = extractTextContent(codeChild.children);
      const replacement: Element = {
        type: "element",
        tagName,
        properties: { "data-code": encodeURIComponent(code) },
        children: [],
      };
      parent.children[index] = replacement;
    });

    return tree;
  };
}
