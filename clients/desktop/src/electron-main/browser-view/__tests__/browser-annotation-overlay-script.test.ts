import { describe, expect, it } from "vitest";
import { ANNOTATION_BUNDLE_BYTE_BUDGET } from "../browser-annotation-overlay-logic";
import {
  ANNOTATION_BINDING_NAME,
  ANNOTATION_CANCEL_EXPRESSION,
  ANNOTATION_CAPTURE_FAILED_EXPRESSION,
  ANNOTATION_HIDE_CHROME_EXPRESSION,
  ANNOTATION_LIMITS,
  ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION,
  ANNOTATION_WORLD_NAME,
  buildAnnotationSetTargetChatLabelExpression,
  sanitizeAnnotationBindingPayload,
  sanitizeAttachRequest,
} from "../browser-annotation-overlay-script";

const UNION = { x: 4, y: 8, width: 16, height: 24 };
const TARGET_CHAT_ID = "chat-target-1";
const TARGET_ROSTER = [
  { chatId: TARGET_CHAT_ID, label: "fix-billing" },
  { chatId: "chat-other", label: "other" },
] as const;

const VALID_ATTACH = {
  targetChatId: TARGET_CHAT_ID,
  marks: [
    {
      id: "mark-1",
      kind: "region" as const,
      bounds: UNION,
      selector: null,
    },
  ],
  elements: [],
  comment: "note",
  unionRect: UNION,
};

describe("annotation overlay command expressions", () => {
  it("exposes named command expressions and the isolated world name", () => {
    expect(ANNOTATION_WORLD_NAME).toBe("traycer-annotation");
    expect(ANNOTATION_BINDING_NAME).toBe("__traycerAnnotation");
    expect(ANNOTATION_CANCEL_EXPRESSION).toContain("__traycerAnnotationCancel");
    expect(ANNOTATION_HIDE_CHROME_EXPRESSION).toContain(
      "__traycerAnnotationHideChromeForCapture",
    );
    expect(ANNOTATION_HIDE_CHROME_EXPRESSION).toContain("return false");
    expect(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION).toContain(
      "__traycerAnnotationResetAfterAttach",
    );
    expect(ANNOTATION_RESET_AFTER_ATTACH_EXPRESSION).toContain("return false");
    expect(ANNOTATION_CAPTURE_FAILED_EXPRESSION).toContain(
      "__traycerAnnotationCaptureFailed",
    );
    expect(ANNOTATION_CAPTURE_FAILED_EXPRESSION).not.toContain("return false");
    expect(
      buildAnnotationSetTargetChatLabelExpression(
        TARGET_ROSTER,
        TARGET_CHAT_ID,
      ),
    ).toContain("__traycerAnnotationSetTargetChatLabel");
    expect(
      buildAnnotationSetTargetChatLabelExpression(
        TARGET_ROSTER,
        TARGET_CHAT_ID,
      ),
    ).toContain("fix-billing");
    expect(
      buildAnnotationSetTargetChatLabelExpression(
        TARGET_ROSTER,
        TARGET_CHAT_ID,
      ),
    ).toContain(TARGET_CHAT_ID);
    expect(
      buildAnnotationSetTargetChatLabelExpression(TARGET_ROSTER, null),
    ).toContain(",null");
  });

  it("encodes the target-chat roster as JSON arguments", () => {
    const expression = buildAnnotationSetTargetChatLabelExpression(
      [{ chatId: "chat-1", label: 'say </script> "hi"' }],
      "chat-1",
    );
    expect(expression).toContain("__traycerAnnotationSetTargetChatLabel");
    expect(expression).toContain("\\u003c");
    expect(expression).not.toContain("</script>");
    expect(expression).toContain('"chatId":"chat-1"');
    expect(expression).toContain('"chat-1"');
  });
});

describe("sanitizeAnnotationBindingPayload", () => {
  it("maps cancelled", () => {
    expect(sanitizeAnnotationBindingPayload({ type: "cancelled" })).toEqual({
      type: "cancelled",
    });
    expect(
      sanitizeAnnotationBindingPayload(JSON.stringify({ type: "cancelled" })),
    ).toEqual({ type: "cancelled" });
  });

  it("maps stateChanged and rejects an invalid mode", () => {
    expect(
      sanitizeAnnotationBindingPayload({
        type: "stateChanged",
        mode: "select",
        markCount: 0,
      }),
    ).toEqual({ type: "stateChanged", mode: "select", markCount: 0 });
    expect(
      sanitizeAnnotationBindingPayload({
        type: "stateChanged",
        mode: "lasso",
        markCount: 1,
      }),
    ).toBeNull();
  });

  it("maps a valid attachRequested payload", () => {
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        payload: VALID_ATTACH,
      }),
    ).toEqual({
      type: "attachRequested",
      payload: VALID_ATTACH,
    });
  });

  it("rejects attachRequested when annotationId or screenshot is supplied", () => {
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        annotationId: "guest",
        payload: VALID_ATTACH,
      }),
    ).toBeNull();
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        screenshot: "pixels",
        payload: VALID_ATTACH,
      }),
    ).toBeNull();
  });

  it("rejects annotationId or screenshot nested anywhere in the payload", () => {
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        payload: { ...VALID_ATTACH, annotationId: "guest" },
      }),
    ).toBeNull();
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        payload: { ...VALID_ATTACH, screenshot: "pixels" },
      }),
    ).toBeNull();
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        payload: {
          ...VALID_ATTACH,
          marks: [
            {
              ...VALID_ATTACH.marks[0],
              annotationId: "smuggled",
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      sanitizeAnnotationBindingPayload({
        type: "attachRequested",
        payload: {
          ...VALID_ATTACH,
          elements: [{ screenshot: "data:image/png;base64,abc" }],
        },
      }),
    ).toBeNull();
  });

  it("drops raw unknown types", () => {
    expect(sanitizeAnnotationBindingPayload({ type: "mystery" })).toBeNull();
    expect(
      sanitizeAnnotationBindingPayload({
        type: "ended",
        reason: "navigation",
      }),
    ).toBeNull();
    expect(sanitizeAnnotationBindingPayload("not-json")).toBeNull();
    expect(sanitizeAnnotationBindingPayload(null)).toBeNull();
  });
});

describe("sanitizeAttachRequest", () => {
  it("accepts a valid payload and drops extra fields", () => {
    const result = sanitizeAttachRequest({
      ...VALID_ATTACH,
      extra: "ignored",
    });
    expect(result).toEqual(VALID_ATTACH);
    expect(result === null ? [] : Object.keys(result)).toEqual([
      "targetChatId",
      "marks",
      "elements",
      "comment",
      "unionRect",
    ]);
  });

  it("requires a non-empty targetChatId and keeps it on the sanitized request", () => {
    expect(
      sanitizeAttachRequest({ ...VALID_ATTACH, targetChatId: "" }),
    ).toBeNull();
    const { targetChatId: _omitted, ...withoutTarget } = VALID_ATTACH;
    expect(sanitizeAttachRequest(withoutTarget)).toBeNull();
    expect(sanitizeAttachRequest(VALID_ATTACH)?.targetChatId).toBe(
      TARGET_CHAT_ID,
    );
  });

  it("rejects guest-supplied annotationId or screenshot", () => {
    expect(
      sanitizeAttachRequest({ ...VALID_ATTACH, annotationId: "guest" }),
    ).toBeNull();
    expect(
      sanitizeAttachRequest({ ...VALID_ATTACH, screenshot: "png" }),
    ).toBeNull();
  });

  it("rejects annotationId or screenshot nested under payload or marks", () => {
    expect(
      sanitizeAttachRequest({
        type: "attachRequested",
        payload: { ...VALID_ATTACH, annotationId: "guest" },
      }),
    ).toBeNull();
    expect(
      sanitizeAttachRequest({
        ...VALID_ATTACH,
        marks: [{ ...VALID_ATTACH.marks[0], screenshot: "x" }],
      }),
    ).toBeNull();
  });

  it("requires a unionRect and bounds comment length", () => {
    expect(sanitizeAttachRequest({ comment: "x" })).toBeNull();
    const longComment = "c".repeat(ANNOTATION_LIMITS.comment + 20);
    const result = sanitizeAttachRequest({
      targetChatId: TARGET_CHAT_ID,
      unionRect: UNION,
      comment: longComment,
    });
    expect(result?.comment).toHaveLength(ANNOTATION_LIMITS.comment);
    expect(result?.targetChatId).toBe(TARGET_CHAT_ID);
  });

  it("forces stroke and region selectors to null", () => {
    const result = sanitizeAttachRequest({
      targetChatId: TARGET_CHAT_ID,
      unionRect: UNION,
      marks: [
        {
          id: "s1",
          kind: "stroke",
          bounds: UNION,
          selector: "canvas",
        },
      ],
    });
    expect(result?.marks[0]?.selector).toBeNull();
  });

  it("drops smuggled stroke points so snapshots are bounds-only", () => {
    const result = sanitizeAttachRequest({
      targetChatId: TARGET_CHAT_ID,
      unionRect: UNION,
      marks: [
        {
          id: "s1",
          kind: "stroke",
          bounds: UNION,
          selector: "canvas",
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
    });
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected sanitized request");
    }
    expect(result.marks).toEqual([
      {
        id: "s1",
        kind: "stroke",
        bounds: UNION,
        selector: null,
      },
    ]);
    expect(result.marks[0]).not.toHaveProperty("points");
  });

  it("keeps picker-sanitized attributes and curated computed styles", () => {
    const result = sanitizeAttachRequest({
      ...VALID_ATTACH,
      elements: [
        {
          selector: "main > h1",
          tagName: "H1",
          elementId: "hero",
          classNames: ["title"],
          attributes: [
            { name: "data-kind", value: "heading" },
            { name: "aria-level", value: "1" },
          ],
          outerHtml: '<h1 id="hero" class="title">Example</h1>',
          textPreview: "Example",
          ariaRole: "heading",
          accessibleName: "Example",
          boundingBox: {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            top: 2,
            right: 4,
            bottom: 6,
            left: 1,
          },
          computedStyles: [
            { property: "display", value: "block" },
            { property: "font-size", value: "26px" },
            { property: "--injected", value: "nope" },
            { property: "content", value: "url(https://evil.example)" },
          ],
        },
      ],
    });
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected sanitized request");
    }
    expect(result.elements).toHaveLength(1);
    const element = result.elements[0];
    if (element === undefined) {
      throw new Error("expected captured element");
    }
    expect(element.selector).toBe("main > h1");
    expect(element.tagName).toBe("h1");
    expect(element.attributes).toEqual([
      { name: "data-kind", value: "heading" },
      { name: "aria-level", value: "1" },
    ]);
    expect(element.computedStyles).toEqual([
      { property: "display", value: "block" },
      { property: "font-size", value: "26px" },
    ]);
  });

  it("caps attach elements at the count limit before sanitizing", () => {
    const late = {
      selector: "div.late",
      tagName: "div",
      outerHtml: "<div class='late'></div>",
      boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    };
    const elements = [
      ...Array.from({ length: ANNOTATION_LIMITS.elementCount }, () => null),
      late,
    ];
    const result = sanitizeAttachRequest({ ...VALID_ATTACH, elements });
    expect(result).not.toBeNull();
    expect(result?.elements).toEqual([]);
  });

  it("trims elements so the attach payload stays within the byte budget", () => {
    const fatElements = Array.from({ length: 30 }, (_unused, index) => ({
      selector: `div.el-${index}`,
      tagName: "div",
      attributes: Array.from({ length: 30 }, (_inner, attrIndex) => ({
        name: `data-${attrIndex}`,
        value: "v".repeat(300),
      })),
      computedStyles: Array.from({ length: 48 }, () => ({
        property: "display",
        value: "x".repeat(300),
      })),
      outerHtml: "h".repeat(4000),
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    }));
    const result = sanitizeAttachRequest({
      ...VALID_ATTACH,
      elements: fatElements,
    });
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected sanitized request");
    }
    expect(
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    ).toBeLessThanOrEqual(ANNOTATION_BUNDLE_BYTE_BUDGET);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeLessThan(30);
    expect(result.elements[0]?.selector).toBe("div.el-0");
  });

  it("trims by UTF-8 bytes so a unit-counted payload cannot sneak past the budget", () => {
    const fatElements = Array.from({ length: 25 }, (_unused, index) => ({
      selector: `p.euro-${index}`,
      tagName: "p",
      outerHtml: "€".repeat(4000),
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    }));
    const raw = { ...VALID_ATTACH, elements: fatElements };
    expect(JSON.stringify(raw).length).toBeLessThan(
      ANNOTATION_BUNDLE_BYTE_BUDGET,
    );
    const result = sanitizeAttachRequest(raw);
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error("expected sanitized request");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(bytes).toBeLessThanOrEqual(ANNOTATION_BUNDLE_BYTE_BUDGET);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeLessThan(fatElements.length);
  });
});
