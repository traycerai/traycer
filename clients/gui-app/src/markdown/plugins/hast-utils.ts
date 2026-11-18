import type { Element, Text } from "hast";

export function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    (node as { type: string }).type === "element"
  );
}
function isText(node: unknown): node is Text {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    (node as { type: string }).type === "text"
  );
}

export function extractTextContent(children: Element["children"]): string {
  return children
    .map((child) => {
      if (isText(child)) {
        return child.value;
      }
      if (isElement(child)) {
        return extractTextContent(child.children);
      }
      return "";
    })
    .join("");
}

export function pickStringProp(
  props: Element["properties"],
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}
