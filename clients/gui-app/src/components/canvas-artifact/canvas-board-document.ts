import {
  parseHtmlSource,
  type HtmlElement,
  type HtmlSourceDocument,
} from "@traycer/html-source";
import {
  EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
  EPIC_READ_ARTIFACT_OBJECT_TEXT_MAX_BYTES,
} from "@traycer/protocol/host/epic/artifact-objects";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";

export interface CanvasBoardDocument {
  readonly sha256: string;
  readonly text: string;
  readonly parsed: HtmlSourceDocument;
}
export async function readCanvasBoardDocument(
  source: SandboxSource,
  signal: AbortSignal,
): Promise<CanvasBoardDocument> {
  if (
    source.kind !== "artifact" ||
    !Object.hasOwn(source.manifest.files, source.entryPath)
  )
    throw new Error("This artboard is unavailable.");
  const entry = source.manifest.files[source.entryPath];
  if (entry.byteLength > EPIC_READ_ARTIFACT_OBJECT_TEXT_MAX_BYTES)
    throw new Error("This artboard is too large to edit here.");
  const bytes = new Uint8Array(entry.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const result = await source.readSpan(
      entry.sha256,
      offset,
      Math.min(
        bytes.length - offset,
        EPIC_READ_ARTIFACT_OBJECT_RANGE_MAX_BYTES,
      ),
      signal,
    );
    if ("unavailable" in result)
      throw new Error("This artboard is unavailable.");
    if (
      result.totalBytes !== bytes.length ||
      result.bytes.length === 0 ||
      result.bytes.length > bytes.length - offset
    )
      throw new Error("The artboard could not be read. Try again.");
    bytes.set(result.bytes, offset);
    offset += result.bytes.length;
  }
  signal.throwIfAborted();
  // Preserve a leading BOM: markers are offsets into the original decoded file.
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  return { sha256: entry.sha256, text, parsed: parseHtmlSource(text) };
}
export function canvasSourceElement(
  document: CanvasBoardDocument,
  element: CanvasElement,
): HtmlElement | null {
  if (element.generated) return null;
  const matches = document.parsed.elements.filter((candidate) =>
    element.tid !== null
      ? candidate.effectiveTid === element.tid
      : candidate.startTag?.start === element.marker &&
        candidate.tagName === element.tagName,
  );
  return matches.length === 1 && matches[0].isUniqueSource ? matches[0] : null;
}
export interface CanvasTextDraftTarget {
  readonly text: string;
  readonly textNodeIndex: number | null;
}
export function canvasTextDraftTarget(
  element: HtmlElement,
): CanvasTextDraftTarget | null {
  if (element.isRawText || element.isVoid || element.endTag === null)
    return null;
  const textNodes = element.children.filter((child) => child.kind === "text");
  if (element.children.every((child) => child.kind === "text"))
    return {
      text: textNodes.map((child) => child.value).join(""),
      textNodeIndex: null,
    };
  // Only one direct literal text node can be edited without replacing siblings.
  if (textNodes.length === 1)
    return { text: textNodes[0].value, textNodeIndex: 0 };
  return null;
}
export function canvasSourceOuterHtml(
  document: CanvasBoardDocument,
  element: CanvasElement,
): string | null {
  const node = canvasSourceElement(document, element);
  if (node?.startTag === null || node === null) return null;
  const end = node.endTag?.end ?? (node.isVoid ? node.startTag.end : null);
  if (end === null) return null;
  const html = document.text.slice(node.startTag.start, end);
  return new TextEncoder().encode(html).length <= 65_536 ? html : null;
}
