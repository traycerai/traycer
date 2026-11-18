import type { Element, Root, Text } from "hast";
import { SKIP, visit } from "unist-util-visit";
import { artifactEpicIdFromLinkPath } from "../links/artifact-link-path";
import { classifyHref } from "../links/classify-href";
import { extractTextContent } from "./hast-utils";
import { TRAYCER_ARTIFACT_PATH_TAG } from "./const";

/** Claim whole artifact paths before the UUID pass can chip their task id. */
export function rehypeTraycerArtifactReferences() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (node.type === "element") {
        if (node.tagName === "pre" || node.tagName.startsWith("traycer-")) {
          return SKIP;
        }
        if (node.tagName === "a" || node.tagName === "code") {
          const raw =
            node.tagName === "a"
              ? node.properties.href
              : extractTextContent(node.children);
          if (typeof raw === "string") {
            const reference = artifactReference(
              raw,
              extractTextContent(node.children),
            );
            if (reference !== null) {
              node.tagName = reference.tagName;
              node.properties = reference.properties;
              node.children = reference.children;
            }
          }
          return SKIP;
        }
      }
      if (node.type !== "text" || parent === undefined || index === undefined)
        return;
      const parts = splitArtifactPaths(node.value);
      if (parts === null) return;
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

function artifactReference(raw: string, label: string): Element | null {
  if (!raw.includes("artifacts")) return null;
  const link = classifyHref(raw);
  if (link.kind !== "file" || artifactEpicIdFromLinkPath(link.path) === null)
    return null;
  return {
    type: "element",
    tagName: TRAYCER_ARTIFACT_PATH_TAG,
    properties: {
      "data-artifact-path": link.path,
      "data-line": link.line,
      "data-col": link.col,
    },
    children: [{ type: "text", value: label }],
  };
}

function splitArtifactPaths(value: string): Array<Text | Element> | null {
  const parts: Array<Text | Element> = [];
  let cursor = 0;
  // Bare prose paths cannot contain whitespace; links and inline code above
  // preserve spaces. Leave sentence punctuation outside the reference.
  for (const match of value.matchAll(/[^\s<>"'`]+/gu)) {
    const token = match[0];
    const raw = token.replace(/^[([{]+/u, "").replace(/[.,;!?)\]}]+$/u, "");
    const reference = artifactReference(raw, raw);
    if (reference === null) continue;
    const start = match.index + token.indexOf(raw);
    if (start > cursor)
      parts.push({ type: "text", value: value.slice(cursor, start) });
    parts.push(reference);
    cursor = start + raw.length;
  }
  if (parts.length === 0) return null;
  if (cursor < value.length)
    parts.push({ type: "text", value: value.slice(cursor) });

  return parts;
}
