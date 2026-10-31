import type { CanvasAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { EpicReadArtifactObjectResponse } from "@traycer/protocol/host/epic/artifact-objects";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import type { CanvasAnnotationScope } from "./canvas-annotation-action";
import {
  attachCanvasAnnotation,
  canvasAnnotationElement,
  canvasWindowCaptureBridge,
  captureCanvasRegionWithoutChrome,
} from "./canvas-annotation-attach";
import type { CanvasSelection } from "./canvas-selection-store";

/**
 * The browser-annotation record for a selected element: the capture the chat
 * composer shows as a card and the agent reads as structured context. Throws
 * while the served source is still loading, since the source range is part of
 * the record for an element that has one.
 */
export function canvasSelectionAnnotationRecord(
  scope: CanvasAnnotationScope,
  selection: CanvasSelection,
  source: EpicReadArtifactObjectResponse | undefined,
): CanvasAnnotationRecord {
  if (!selection.element.generated && source?.kind !== "text")
    throw new Error("The artboard source is still loading. Try again.");
  return {
    kind: "browser-annotation",
    annotationId: crypto.randomUUID(),
    source: {
      kind: "canvas",
      artifactId: scope.artifactId,
      artifactTitle: scope.artifactTitle,
      boardPath: selection.boardPath,
      canvasPage: selection.page,
    },
    capturedAt: Date.now(),
    comment: "",
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [
      canvasAnnotationElement(
        selection,
        source?.kind === "text" ? source.text : null,
      ),
    ],
    imageFileName: null,
    imageHash: null,
    droppedElementCount: 0,
  };
}

/** How a send photographs its element: where, and when the picker is gone. */
export interface CanvasAnnotationCapture {
  /** Measured right before the capture, since the board can move while the picker closes. */
  readonly captureRect: () => CanvasBox | null;
  /** Resolves once the caller's picker has left the screen. */
  readonly awaitPickerClosed: () => Promise<void>;
}

/**
 * The crop of the selected region, cut from the app window as composited, or
 * `null` where there is nothing to capture (no region, or no window bridge).
 * The picture is taken only once the caller's picker has left the screen and
 * with the selection chrome hidden, so neither ends up in the card.
 */
export async function captureCanvasAnnotationCrop(
  capture: CanvasAnnotationCapture,
): Promise<ImageBytes | null> {
  const bridge = canvasWindowCaptureBridge();
  // Whether there is anything on screen to photograph is decided now; the
  // rectangle itself is measured again right before the capture.
  if (bridge === null || capture.captureRect() === null) return null;
  await capture.awaitPickerClosed();
  const crop = await captureCanvasRegionWithoutChrome(
    bridge,
    capture.captureRect,
  );
  if (crop === null)
    throw new Error("The selected region could not be captured. Try again.");
  return new Uint8Array(crop);
}

/**
 * Captures the selected region and attaches the record to a chat's composer
 * draft. The capture happens here, on the explicit send, before anything else
 * moves on screen: the selection bar and the comment draft box both route
 * through this one path so their cards match.
 */
export async function captureAndAttachCanvasAnnotation(
  input: CanvasAnnotationCapture & {
    readonly chatId: string;
    readonly record: CanvasAnnotationRecord;
  },
): Promise<CanvasAnnotationRecord> {
  return attachCanvasAnnotation({
    chatId: input.chatId,
    record: input.record,
    crop: await captureCanvasAnnotationCrop(input),
  });
}
