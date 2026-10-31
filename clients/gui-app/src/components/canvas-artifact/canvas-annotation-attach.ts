import { locateElement } from "@traycer/html-source";
import type {
  CanvasAnnotationRecord,
  CanvasElementCapture,
} from "@traycer/protocol/persistence/epic/messages";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  createComposerImagePreparationSession,
  prepareComposerImageBytesOrRefuse,
} from "@/lib/composer/composer-image-preparation";
import { putImage } from "@/lib/composer/landing-image-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { CanvasSelection } from "./canvas-selection-store";

export function canvasAnnotationElement(
  selection: CanvasSelection,
  source: string | null,
): CanvasElementCapture {
  const element = selection.element;
  const box = element.box;
  const sourceRange = canvasSourceRange(selection, source);
  return {
    selector: element.selector,
    tagName: element.tagName,
    elementId: element.elementId,
    classNames: [...element.classNames],
    textPreview: element.textPreview,
    ariaRole: element.ariaRole,
    accessibleName: element.accessibleName,
    boundingBox: {
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
    },
    computedStyles: [...element.computedStyles],
    sourceRange,
    tid: element.generated ? null : element.tid,
    textRange:
      selection.textRange === null
        ? null
        : {
            start: selection.textRange.start,
            end: selection.textRange.end,
            quote: selection.textRange.quote,
          },
  };
}

function canvasSourceRange(
  selection: CanvasSelection,
  source: string | null,
): CanvasElementCapture["sourceRange"] {
  const element = selection.element;
  if (source === null || element.marker === null || element.generated)
    return null;
  const located = locateElement(source, {
    kind: "position",
    startTagOffset: element.marker,
    tagName: element.tagName,
  });
  if (!located.ok || located.element.startTag === null) return null;
  const start = located.element.startTag.start;
  return {
    start,
    end: located.element.endTag?.end ?? located.element.startTag.end,
    line: source.slice(0, start).split(/\r\n|\r|\n/).length,
  };
}

interface WindowCaptureBridge {
  captureRegion(rect: CanvasBox): Promise<ArrayBuffer | null>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isCaptureBridge(value: unknown): value is WindowCaptureBridge {
  return isRecord(value) && typeof value.captureRegion === "function";
}
export function canvasWindowCaptureBridge(): WindowCaptureBridge | null {
  const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
  if (!isRecord(runnerHost) || !isRecord(runnerHost.platform)) return null;
  return isCaptureBridge(runnerHost.platform.window)
    ? runnerHost.platform.window
    : null;
}

/**
 * Canvas cards remain in memory and in a separate window-scoped sidecar bucket
 * until sent. The shared composer-drafts localStorage bucket excludes them.
 * The mirrored composer draft contains content only; draft-head@1.0's legacy
 * stash annotation leaf remains browser-only. Sending carries the complete
 * sidecar through chat.subscribe@1.32 and chat-sync@1.10.
 */
export async function attachCanvasAnnotation(input: {
  readonly chatId: string;
  readonly record: CanvasAnnotationRecord;
  readonly crop: ImageBytes | null;
}): Promise<CanvasAnnotationRecord> {
  const record = await prepareCanvasAnnotationCrop(input.record, input.crop);
  useComposerDraftStore.getState().addBrowserAnnotation(input.chatId, record);
  return record;
}

/**
 * Puts the crop into this window's image store and points the record at it.
 * The record is then ready for any composer: an existing chat's sidecar, or
 * the new-conversation modal's.
 */
export async function prepareCanvasAnnotationCrop(
  record: CanvasAnnotationRecord,
  crop: ImageBytes | null,
): Promise<CanvasAnnotationRecord> {
  if (crop === null) return record;
  const prepared = await prepareComposerImageBytesOrRefuse(
    createComposerImagePreparationSession(),
    crop,
    `canvas-selection-${record.annotationId}.png`,
    "image/png",
  );
  if (prepared.kind === "refused")
    throw new Error("The selected region could not be attached.");
  const imageHash = await putImage(prepared.image.bytes);
  return { ...record, imageHash, imageFileName: prepared.image.fileName };
}
