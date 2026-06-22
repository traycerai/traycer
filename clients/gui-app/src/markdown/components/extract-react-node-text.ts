import { Children, isValidElement, type ReactNode } from "react";

/**
 * Recursively flattens a React node tree to its visible text. Recurses into
 * element children (so a wrapped `<span>foo</span>` yields `"foo"`) and drops
 * boolean / null / undefined nodes. Shared by the markdown code-block renderer
 * and the agent-reference markdown plugin so both resolve node text the same
 * way. Lives in its own module (no component exports) so importing it never
 * trips React Fast Refresh.
 */
export function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  return Children.toArray(children).map(extractNodeText).join("");
}

function extractNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  return "";
}
