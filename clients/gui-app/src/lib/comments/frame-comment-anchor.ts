import type { CanvasSelection } from "@/components/canvas-artifact/canvas-selection-store";
import {
  commentAnchorStatus,
  insertTid,
  parseHtmlSource,
} from "@traycer/html-source";
import { sourceLocator } from "@/components/canvas-artifact/canvas-structure-identity";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasBox, CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { AnchoredDraftAnchor } from "@/stores/comments/anchored-draft-store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Offset hints follow the same whitespace-normalized text as comment staleness. */
export function normalizeCommentTextRange(
  fullText: string | null,
  range: {
    readonly start: number;
    readonly end: number;
    readonly quote: string;
  },
) {
  const quotedText = normalize(range.quote);
  if (fullText === null)
    return {
      startOffset: range.start,
      endOffset: range.start + quotedText.length,
      quotedText,
    };
  const normalized = normalize(fullText);
  const selectedRaw = fullText.slice(range.start, range.end);
  const leading = selectedRaw.length - selectedRaw.trimStart().length;
  const prefix = fullText
    .slice(0, range.start + leading)
    .replace(/\s+/g, " ")
    .trimStart();
  const hint = prefix.length;
  const match =
    normalized.slice(hint, hint + quotedText.length) === quotedText
      ? hint
      : normalized.indexOf(quotedText);
  const startOffset = Math.max(0, match);
  return {
    startOffset,
    endOffset: startOffset + quotedText.length,
    quotedText,
  };
}

export function frameElementLabel(element: CanvasElement): string {
  const text = normalize(element.accessibleName ?? element.textPreview).slice(
    0,
    80,
  );
  return text.length === 0 ? element.tagName : `${element.tagName} "${text}"`;
}

/** Generated nodes have no source anchor; retain the nearest literal container. */
export async function literalCommentSelection(
  selection: CanvasSelection,
  bridge: SandboxBridgeHost,
): Promise<{
  readonly selection: CanvasSelection;
  readonly retargeted: boolean;
} | null> {
  const element = selection.element;
  if (!element.generated) return { selection, retargeted: false };
  const ancestor = await bridge.literalAncestor(
    element.tid !== null
      ? { tid: element.tid }
      : { selector: element.selector },
  );
  return ancestor === null
    ? null
    : {
        selection: { ...selection, element: ancestor, textRange: null },
        retargeted: true,
      };
}

function sourceContainsQuote(
  source: string,
  element: CanvasElement,
  quotedText: string,
): boolean {
  let elementId = element.tid;
  if (elementId === null) {
    const locator = sourceLocator(element);
    if (locator === null) return false;
    const ids = new Set(
      parseHtmlSource(source).elements.map((node) => node.effectiveTid),
    );
    elementId = "traycer-comment-preview";
    while (ids.has(elementId)) elementId += "x";
    // A temporary copy lets the shared rule inspect an unstamped element too.
    const stamped = insertTid(source, locator, elementId);
    if (!stamped.ok) return false;
    source = stamped.text;
  }
  return (
    commentAnchorStatus(source, { kind: "text", elementId, quotedText }) ===
    "present"
  );
}

export function commentAnchorForSelection(
  selection: CanvasSelection,
  fullText: string | null,
  servedSource: string | null,
): {
  readonly anchor: AnchoredDraftAnchor;
  readonly quotedText: string;
  readonly generatedText: boolean;
} {
  const common = {
    artboard: selection.boardPath,
    elementId: selection.element.tid,
  };
  if (selection.textRange !== null) {
    const { startOffset, endOffset, quotedText } = normalizeCommentTextRange(
      fullText,
      selection.textRange,
    );
    if (
      servedSource === null ||
      !sourceContainsQuote(servedSource, selection.element, quotedText)
    ) {
      const description = `${selection.element.tagName} "${quotedText}"`;
      return {
        anchor: { ...common, kind: "element", label: description.slice(0, 80) },
        quotedText: description,
        generatedText: true,
      };
    }
    return {
      anchor: {
        ...common,
        kind: "text",
        startOffset,
        endOffset,
        label: quotedText.slice(0, 80),
      },
      quotedText,
      generatedText: false,
    };
  }
  const label = frameElementLabel(selection.element);
  return {
    anchor: { ...common, kind: "element", label },
    quotedText: label,
    generatedText: false,
  };
}

export function frameCommentScreenRect(
  frame: HTMLIFrameElement,
  box: CanvasBox,
): CanvasBox {
  const rect = frame.getBoundingClientRect();
  const scaleX = frame.clientWidth === 0 ? 1 : rect.width / frame.clientWidth;
  const scaleY =
    frame.clientHeight === 0 ? 1 : rect.height / frame.clientHeight;
  return {
    x: rect.left + box.x * scaleX,
    y: rect.top + box.y * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY,
  };
}

/** The wire anchor is relative to the artifact's own folder, not its manifest. */
export function htmlCommentRootArtboard(
  artifact: Pick<ArtifactProjection, "layout" | "relativePath" | "folderName">,
): string {
  if (artifact.layout !== "file") return "index.html";
  return (artifact.relativePath ?? artifact.folderName).split("/").at(-1) ?? "";
}

/** Root anchors survive loose-file ↔ folder promotion without rewriting threads. */
export function resolveHtmlCommentArtboard(
  artifact: Pick<ArtifactProjection, "layout" | "relativePath" | "folderName">,
  artboard: string,
): string {
  const rootArtboard = htmlCommentRootArtboard(artifact);
  const leaf =
    artifact.layout === "file"
      ? rootArtboard.replace(/\.html?$/i, "")
      : artifact.folderName;
  const root =
    artifact.layout === "file"
      ? (artifact.relativePath ?? artifact.folderName)
      : "index.html";
  return artboard === "index.html" ||
    artboard === `${leaf}.html` ||
    artboard === rootArtboard ||
    artboard === root
    ? root
    : artboard;
}
