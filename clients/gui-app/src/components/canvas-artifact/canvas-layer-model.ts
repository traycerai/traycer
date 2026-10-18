import type { HtmlChild, HtmlElement } from "@traycer/html-source";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasSelection } from "./canvas-selection-store";
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
    const marker = node.isUniqueSource ? (node.startTag?.start ?? null) : null;
    // Implied document containers have no source but do not represent script output.
    const implicit =
      marker === null &&
      ["html", "head", "body", "tbody"].includes(node.tagName);
    if (!implicit) {
      const id = node.attrs.find((attr) => attr.name === "id")?.value;
      const classes =
        node.attrs
          .find((attr) => attr.name === "class")
          ?.value.trim()
          .split(/\s+/)
          .filter(Boolean) ?? [];
      const label = `${node.tagName}${id ? `#${id}` : ""}${classes.length ? `.${classes.join(".")}` : ""}`;
      rows.push({
        key: `${marker}:${rows.length}`,
        marker,
        depth: entry.depth,
        tagName: node.tagName,
        label,
        preview: node.children
          .flatMap((child) => (child.kind === "text" ? [child.value] : []))
          .join("")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        generated: marker === null,
        element: node,
      });
    }
    for (const child of [...node.children].reverse())
      pending.push({ child, depth: entry.depth + (implicit ? 0 : 1) });
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
