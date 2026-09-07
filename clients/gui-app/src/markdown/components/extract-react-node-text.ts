import { Children, isValidElement, type ReactNode } from "react";

/** Flatten React node text. Own module with no component exports so import never trips Fast Refresh. */
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
