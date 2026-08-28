import type {
  BrowserAnnotationAttachRequest,
  BrowserAnnotationCssRect,
  BrowserAnnotationMarkKind,
  BrowserAnnotationMarkSnapshot,
  BrowserAnnotationSessionEvent,
} from "../../../ipc-contracts/browser-annotation-types";
import type { BrowserViewElementCapture } from "@traycer-clients/shared/platform/browser-view";
import {
  ANNOTATION_BUNDLE_BYTE_BUDGET,
  ANNOTATION_BUNDLE_ELEMENT_CAP,
  isAnnotationMode,
  serializedCaptureBytes,
} from "./browser-annotation-overlay-logic";
import { sanitizeElementCapture } from "./browser-element-picker-script";
import {
  boundedString,
  boundedStringOrNull,
  clamp,
  finiteNumber,
  isRecord,
} from "../guards";

export const ANNOTATION_WORLD_NAME = "traycer-annotation";
export const ANNOTATION_BINDING_NAME = "__traycerAnnotation";

/**
 * One expression shape for every guest hook: resolve `globalThis[name]`, call
 * it with JSON-encoded arguments, and report whether it ran. Callers that need
 * confirmation read the `true`; best-effort callers ignore the result.
 */
export function callGuestHook(name: string, args: readonly unknown[]): string {
  const encodedArgs = args
    .map((arg) => JSON.stringify(arg).replace(/</g, "\\u003c"))
    .join(",");
  return (
    "(function(){var fn=globalThis." +
    name +
    ";if(typeof fn!=='function')return false;" +
    "try{fn(" +
    encodedArgs +
    ");return true;}catch(e){return false;}})()"
  );
}

export const ANNOTATION_VIEWPORT_SIZE_EXPRESSION =
  "(function(){return {width:window.innerWidth,height:window.innerHeight,traycerAnnotationViewport:1};})()";

export const ANNOTATION_WAIT_FOR_PAINT_EXPRESSION =
  "(function(){return new Promise(function(resolve){" +
  "requestAnimationFrame(function(){" +
  "requestAnimationFrame(function(){resolve(true);});" +
  "});});})()";

export const ANNOTATION_LIMITS = {
  chatId: 256,
  comment: 4000,
  markCount: 64,
  markId: 64,
  selector: 1000,
  elementCount: ANNOTATION_BUNDLE_ELEMENT_CAP,
  payloadBytes: ANNOTATION_BUNDLE_BYTE_BUDGET,
} as const;

const ATTACH_RECT_MAX = 1_000_000;

/**
 * Trust boundary for `__traycerAnnotation` payloads. Guest-supplied
 * `annotationId` / `screenshot` fields are dropped (ticket 03 trust model).
 */
export function sanitizeAnnotationBindingPayload(
  value: unknown,
): BrowserAnnotationSessionEvent | null {
  const record = parseBindingRecord(value);
  if (record === null) return null;
  const type = record.type;
  if (type === "cancelled") {
    return { type: "cancelled" };
  }
  if (type === "stateChanged") {
    const mode = record.mode;
    if (typeof mode !== "string" || !isAnnotationMode(mode)) return null;
    return {
      type: "stateChanged",
      mode,
      markCount: sanitizeMarkCount(record.markCount),
    };
  }
  if (type === "attachRequested") {
    const payload = sanitizeAttachRequest(record);
    if (payload === null) return null;
    return { type: "attachRequested", payload };
  }
  return null;
}

function parseBindingRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

export function sanitizeAttachRequest(
  value: unknown,
): BrowserAnnotationAttachRequest | null {
  if (!isRecord(value)) return null;
  if (containsForbiddenGuestField(value)) return null;
  const source = isRecord(value.payload) ? value.payload : value;
  const unionRect = sanitizeCssRect(source.unionRect);
  if (unionRect === null) return null;
  const targetChatId = boundedString(
    source.targetChatId,
    ANNOTATION_LIMITS.chatId,
    "",
  );
  if (targetChatId.length === 0) return null;
  const comment = boundedString(source.comment, ANNOTATION_LIMITS.comment, "");
  const marks = sanitizeMarks(source.marks);
  const elements = sanitizeElements(source.elements);
  const request: BrowserAnnotationAttachRequest = {
    targetChatId,
    marks,
    elements,
    comment,
    unionRect,
  };
  return trimToByteBudget(request);
}

function sanitizeMarks(value: unknown): BrowserAnnotationMarkSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, ANNOTATION_LIMITS.markCount)
    .flatMap((entry): BrowserAnnotationMarkSnapshot[] => {
      if (!isRecord(entry)) return [];
      const kind = sanitizeMarkKind(entry.kind);
      if (kind === null) return [];
      const bounds = sanitizeCssRect(entry.bounds);
      if (bounds === null) return [];
      const id = boundedString(entry.id, ANNOTATION_LIMITS.markId, "");
      if (id.length === 0) return [];
      return [
        {
          id,
          kind,
          bounds,
          selector:
            kind === "element"
              ? boundedStringOrNull(entry.selector, ANNOTATION_LIMITS.selector)
              : null,
        },
      ];
    });
}

function sanitizeMarkKind(value: unknown): BrowserAnnotationMarkKind | null {
  if (value === "element" || value === "region" || value === "stroke") {
    return value;
  }
  return null;
}

function sanitizeElements(value: unknown): BrowserViewElementCapture[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, ANNOTATION_LIMITS.elementCount)
    .flatMap((entry): BrowserViewElementCapture[] => {
      const captured = sanitizeElementCapture(entry);
      return captured === null ? [] : [captured];
    });
}

function trimToByteBudget(
  request: BrowserAnnotationAttachRequest,
): BrowserAnnotationAttachRequest {
  const elements = [...request.elements];
  while (elements.length > 0) {
    const candidate: BrowserAnnotationAttachRequest = {
      targetChatId: request.targetChatId,
      marks: request.marks,
      elements,
      comment: request.comment,
      unionRect: request.unionRect,
    };
    if (serializedCaptureBytes(candidate) <= ANNOTATION_LIMITS.payloadBytes) {
      return candidate;
    }
    elements.pop();
  }
  return { ...request, elements };
}

function sanitizeCssRect(value: unknown): BrowserAnnotationCssRect | null {
  if (!isRecord(value)) return null;
  return {
    x: clamp(finiteNumber(value.x), -ATTACH_RECT_MAX, ATTACH_RECT_MAX),
    y: clamp(finiteNumber(value.y), -ATTACH_RECT_MAX, ATTACH_RECT_MAX),
    width: clamp(finiteNumber(value.width), 0, ATTACH_RECT_MAX),
    height: clamp(finiteNumber(value.height), 0, ATTACH_RECT_MAX),
  };
}

function sanitizeMarkCount(value: unknown): number {
  return clamp(Math.floor(finiteNumber(value)), 0, ANNOTATION_LIMITS.markCount);
}

function containsForbiddenGuestField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenGuestField(entry));
  }
  if (!isRecord(value)) return false;
  if ("annotationId" in value || "screenshot" in value) return true;
  return Object.values(value).some((nested) =>
    containsForbiddenGuestField(nested),
  );
}
