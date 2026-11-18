import type { HtmlChild } from "@traycer/html-source";
import type { CanvasSelection } from "./canvas-selection-store";
import {
  canvasSourceElement,
  type CanvasBoardDocument,
} from "./canvas-board-document";
export function canvasRangeTags(
  document: CanvasBoardDocument,
  selection: CanvasSelection,
): Set<string> {
  const node = canvasSourceElement(document, selection.element);
  const range = selection.textRange;
  if (node === null || range === null) return new Set();
  let offset = 0;
  let common: Set<string> | null = null;
  const queue: { node: HtmlChild; tags: readonly string[] }[] = [
    { node, tags: [] },
  ];
  while (queue.length) {
    const entry = queue.pop();
    if (!entry) break;
    if (entry.node.kind === "element") {
      const tags = [...entry.tags, entry.node.tagName];
      for (const child of [...entry.node.children].reverse())
        queue.push({ node: child, tags });
    } else if (entry.node.kind === "text") {
      const end = offset + entry.node.value.length;
      if (end > range.start && offset < range.end) {
        const tags = new Set<string>(entry.tags);
        common =
          common === null
            ? tags
            : new Set<string>(
                [...common].filter((tag: string) => tags.has(tag)),
              );
      }
      offset = end;
    }
  }
  return common ?? new Set();
}

export function canvasHttpLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
