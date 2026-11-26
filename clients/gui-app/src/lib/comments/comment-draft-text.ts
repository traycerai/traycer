import type { JsonContent } from "@traycer/protocol/common/registry";

export function commentDraftText(doc: JsonContent): string {
  return (doc.content ?? []).flatMap(flattenToLines).join("\n").trim();
}

function flattenToLines(node: JsonContent): ReadonlyArray<string> {
  if (node.type === "paragraph" || node.type === "heading")
    return [inlineText(node)];
  if (node.type === "text") return [node.text ?? ""];
  return (node.content ?? []).flatMap(flattenToLines);
}

function inlineText(node: JsonContent): string {
  return (node.content ?? [])
    .map((child) => {
      if (child.type === "text") return child.text ?? "";
      if (child.type === "mention") return `@${mentionLabel(child)}`;
      if (child.type === "hardBreak") return "\n";
      return inlineText(child);
    })
    .join("");
}

function mentionLabel(node: JsonContent): string {
  const attrs: Record<string, unknown> = { ...node.attrs };
  const label = attrs.label;
  if (typeof label === "string" && label.length > 0) return label;
  const id = attrs.id;
  return typeof id === "string" ? id : "";
}
