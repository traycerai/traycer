import { v4 as uuidv4 } from "uuid";

import type { BrowserAnnotationAttachPayload } from "@traycer-clients/shared/platform/browser-annotation";
import { attachBrowserAnnotation } from "@/lib/browser-view/browser-annotation-attach";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/browser-annotation-record";

const STUB_PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const STUB_ANNOTATION_ELEMENT: BrowserAnnotationRecord["elements"][number] =
  {
    selector: "main > h1",
    tagName: "h1",
    elementId: null,
    classNames: [],
    attributes: [],
    outerHtml: "<h1>Example Domain</h1>",
    outerHtmlTruncated: false,
    textPreview: "Example Domain",
    ariaRole: "heading",
    accessibleName: "Example Domain",
    boundingBox: {
      x: 60,
      y: 90,
      width: 420,
      height: 40,
      top: 90,
      right: 480,
      bottom: 130,
      left: 60,
    },
    computedStyles: [{ property: "font-size", value: "26px" }],
  };

export const STUB_ANNOTATION_PARAGRAPH: BrowserAnnotationRecord["elements"][number] =
  {
    selector: "main > p",
    tagName: "p",
    elementId: null,
    classNames: ["body"],
    attributes: [{ name: "class", value: "body" }],
    outerHtml:
      '<p class="body">This domain is for use in documentation examples.</p>',
    outerHtmlTruncated: false,
    textPreview: "This domain is for use in documentation examples.",
    ariaRole: null,
    accessibleName: null,
    boundingBox: {
      x: 76,
      y: 200,
      width: 380,
      height: 40,
      top: 200,
      right: 456,
      bottom: 240,
      left: 76,
    },
    computedStyles: [{ property: "font-size", value: "14px" }],
  };

export function createStubBrowserAnnotationPayload(): {
  readonly payload: BrowserAnnotationAttachPayload;
  readonly png: Uint8Array<ArrayBuffer>;
} {
  const annotationId = `ann-${uuidv4().slice(0, 8)}`;
  return stubPayload({
    annotationId,
    tabId: "tab-stub",
    sessionId: "session-stub",
    comment: "Make this hero section pop more, bigger heading",
  });
}

export function createStubBrowserAnnotationPayloadFor(input: {
  readonly annotationId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly comment: string;
}): {
  readonly payload: BrowserAnnotationAttachPayload;
  readonly png: Uint8Array<ArrayBuffer>;
} {
  return stubPayload(input);
}

export async function attachStubBrowserAnnotation(chatId: string) {
  const stub = createStubBrowserAnnotationPayload();
  return attachBrowserAnnotation({
    chatId,
    payload: stub.payload,
    png: stub.png,
  });
}

function stubPayload(input: {
  readonly annotationId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly comment: string;
}): {
  readonly payload: BrowserAnnotationAttachPayload;
  readonly png: Uint8Array<ArrayBuffer>;
} {
  return {
    payload: {
      annotationId: input.annotationId,
      tabId: input.tabId,
      sessionId: input.sessionId,
      origin: "https://example.com",
      pageUrl: "https://example.com/",
      pageTitle: "Example Domain",
      capturedAt: 1_700_000_000_000,
      comment: input.comment,
      counts: { elements: 2, regions: 0, strokes: 1 },
      droppedElementCount: 0,
      elements: [STUB_ANNOTATION_ELEMENT, STUB_ANNOTATION_PARAGRAPH],
    },
    png: stubAnnotationPng(input.annotationId),
  };
}

function stubAnnotationPng(annotationId: string): Uint8Array<ArrayBuffer> {
  const suffix = new TextEncoder().encode(annotationId);
  const bytes = new Uint8Array(STUB_PNG_SIGNATURE.length + suffix.length);
  bytes.set(STUB_PNG_SIGNATURE, 0);
  bytes.set(suffix, STUB_PNG_SIGNATURE.length);
  return bytes;
}
