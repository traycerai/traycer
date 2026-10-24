import type { HtmlChild, HtmlElement } from "@traycer/html-source";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasSelection } from "./canvas-selection-store";

const LAYER_NAMES = new Map([
  ["p", "Paragraph"],
  ["a", "Link"],
  ["button", "Button"],
  ["img", "Image"],
  ["picture", "Image"],
  ["ul", "List"],
  ["ol", "List"],
  ["li", "List item"],
  ["input", "Input"],
  ["textarea", "Input"],
  ["select", "Input"],
  ["section", "Section"],
  ["article", "Section"],
  ["main", "Section"],
  ["nav", "Section"],
  ["header", "Section"],
  ["footer", "Section"],
  ["aside", "Section"],
  ["div", "Container"],
  ["span", "Text"],
  ["b", "Text"],
  ["strong", "Text"],
  ["em", "Text"],
  ["i", "Text"],
  ["small", "Text"],
]);

export function canvasLayerName(tagName: string): string {
  if (/^h[1-6]$/.test(tagName)) return "Heading";
  return (
    LAYER_NAMES.get(tagName) ??
    tagName.charAt(0).toUpperCase() + tagName.slice(1)
  );
}

export interface CanvasLayerRow {
  readonly key: string;
  readonly marker: number | null;
  readonly depth: number;
  readonly tagName: string;
  readonly label: string;
  readonly preview: string;
  readonly generated: boolean;
  readonly element: HtmlElement;
}

function layerTextPreview(element: HtmlElement): string {
  const pending: HtmlChild[] = [...element.children].reverse();
  let text = "";
  while (pending.length > 0 && text.length <= 80) {
    const child = pending.pop();
    if (child?.kind === "element") {
      for (const descendant of [...child.children].reverse())
        pending.push(descendant);
    } else if (child?.kind === "text") {
      // Inline boundaries add no spaces; keep the whitespace from the text nodes.
      text = (text + child.value).replace(/\s+/g, " ").trimStart();
    }
  }
  return text.trim().slice(0, 80);
}

export function canvasLayerRows(
  document: CanvasBoardDocument,
): CanvasLayerRow[] {
  const rows: CanvasLayerRow[] = [];
  const pending: { child: HtmlChild; depth: number }[] = [
    ...document.parsed.children,
  ]
    .reverse()
    .map((child) => ({ child, depth: 0 }));
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || entry.child.kind !== "element") continue;
    const node = entry.child;
    if (
      ["head", "meta", "style", "script", "link", "title"].includes(
        node.tagName,
      )
    )
      continue;
    const marker = node.isUniqueSource ? (node.startTag?.start ?? null) : null;
    // The board already represents the document; retain only content layers.
    const container =
      node.tagName === "html" ||
      node.tagName === "body" ||
      (marker === null && node.tagName === "tbody");
    if (!container) {
      rows.push({
        key: `${marker}:${rows.length}`,
        marker,
        depth: entry.depth,
        tagName: node.tagName,
        label: canvasLayerName(node.tagName),
        preview: layerTextPreview(node),
        generated: marker === null,
        element: node,
      });
    }
    for (const child of [...node.children].reverse())
      pending.push({ child, depth: entry.depth + (container ? 0 : 1) });
  }
  return rows;
}
export async function describeCanvasLayer(
  {
    artifactId,
    boardPath: path,
    document,
    registry,
  }: {
    readonly artifactId: string;
    readonly boardPath: string;
    readonly document: CanvasBoardDocument;
    readonly registry: CanvasFrameRegistry;
  },
  marker: number,
): Promise<CanvasSelection | null> {
  const entry = registry.get(path);
  const bridge = entry.bridge;
  if (bridge === null || entry.sha256 !== document.sha256) return null;
  const element = await bridge.describeElement({ marker });
  const live = registry.get(path);
  if (
    element === null ||
    element.marker !== marker ||
    live.bridge !== bridge ||
    live.sha256 !== document.sha256
  )
    return null;
  return {
    artifactId,
    boardPath: path,
    page: live.page,
    servedSha256: document.sha256,
    element,
    textRange: null,
  };
}
