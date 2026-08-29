import { describe, expect, it } from "vitest";
import {
  browserAnnotationRecordSchema,
  userAuthoredMessageSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import { chatSubscribeClientFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";

const FULL_ANNOTATION = {
  kind: "browser-annotation" as const,
  annotationId: "ann-7f3a",
  tabId: "t-1",
  sessionId: "s-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
  capturedAt: 1_700_000_000_000,
  comment: "Make this hero section pop more, bigger heading",
  counts: { elements: 2, regions: 0, strokes: 1 },
  elements: [
    {
      selector: "main > h1",
      tagName: "h1",
      elementId: null,
      classNames: ["hero"],
      attributes: [{ name: "class", value: "hero" }],
      outerHtml: '<h1 class="hero">Example Domain</h1>',
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
    },
  ],
  imageFileName: "browser-annotation-ann-7f3a.png",
  imageHash: "abc123def456",
  droppedElementCount: 0,
};

function sendFrameWithoutAnnotations(): Record<string, unknown> {
  return {
    kind: "send",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    messageId: "message-1",
    content: { type: "doc", content: [] },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5.4",
      permissionMode: "supervised",
      reasoningEffort: "high",
      agentMode: "epic",
    },
    accountContext: { type: "PERSONAL" },
  };
}

describe("browserAnnotationRecordSchema", () => {
  it("round-trips a browser-annotation record with every field", () => {
    const parsed = browserAnnotationRecordSchema.parse(FULL_ANNOTATION);
    expect(parsed).toEqual(FULL_ANNOTATION);
    expect(parsed.kind).toBe("browser-annotation");
    expect(parsed.annotationId).toBe("ann-7f3a");
    expect(parsed.tabId).toBe("t-1");
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.origin).toBe("https://example.com");
    expect(parsed.pageUrl).toBe("https://example.com/");
    expect(parsed.pageTitle).toBe("Example Domain");
    expect(parsed.capturedAt).toBe(1_700_000_000_000);
    expect(parsed.comment).toBe(
      "Make this hero section pop more, bigger heading",
    );
    expect(parsed.counts).toEqual({ elements: 2, regions: 0, strokes: 1 });
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.elements[0]).toEqual(FULL_ANNOTATION.elements[0]);
    expect(parsed.imageFileName).toBe("browser-annotation-ann-7f3a.png");
    expect(parsed.imageHash).toBe("abc123def456");
    expect(parsed.droppedElementCount).toBe(0);

    const serialized: unknown = JSON.parse(JSON.stringify(parsed));
    expect(browserAnnotationRecordSchema.parse(serialized)).toEqual(
      FULL_ANNOTATION,
    );
  });

  it("defaults droppedElementCount to 0 on older persisted records", () => {
    const { droppedElementCount: _dropped, ...legacy } = FULL_ANNOTATION;
    expect(
      browserAnnotationRecordSchema.parse(legacy).droppedElementCount,
    ).toBe(0);
  });
});

describe("live user message browserAnnotations default", () => {
  it("accepts an omitted browserAnnotations field and defaults to []", () => {
    const parsed = userAuthoredMessageSchema.parse({
      kind: "user",
      content: { type: "doc", content: [] },
    });
    expect(parsed.browserAnnotations).toEqual([]);
  });

  it("keeps a supplied browser-annotation record on the live user message", () => {
    const parsed = userAuthoredMessageSchema.parse({
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations: [FULL_ANNOTATION],
    });
    expect(parsed.browserAnnotations).toEqual([FULL_ANNOTATION]);
  });
});

describe("live send frame browserAnnotations default", () => {
  it("accepts an omitted browserAnnotations field and defaults to []", () => {
    const parsed = chatSubscribeClientFrameSchema.parse(
      sendFrameWithoutAnnotations(),
    );
    expect(parsed.kind).toBe("send");
    if (parsed.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(parsed.browserAnnotations).toEqual([]);
  });

  it("keeps a supplied browser-annotation record on the live send frame", () => {
    const parsed = chatSubscribeClientFrameSchema.parse({
      ...sendFrameWithoutAnnotations(),
      browserAnnotations: [FULL_ANNOTATION],
    });
    expect(parsed.kind).toBe("send");
    if (parsed.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(parsed.browserAnnotations).toEqual([FULL_ANNOTATION]);
  });
});
