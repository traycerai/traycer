import { describe, expect, it } from "vitest";
import {
  browserAnnotationRecordSchema,
  userAuthoredMessageSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import { chatSubscribeClientFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `browserAnnotationRecordSchema` grew a second arm: an annotation captured on
 * a canvas artifact rather than in a browser tab. Both arms share the
 * `kind: "browser-annotation"` discriminant and the common capture fields; the
 * arms differ in where the page came from (`source`), in whether a crop exists,
 * and in what a captured element can say about its place in the source.
 *
 * Records written before the canvas arm have no `source` at all, so the browser
 * arm infers it from its own top-level fields. That inference is what keeps
 * every persisted record, and every older peer's send, parsing unchanged.
 */

const BROWSER_PAGE = {
  tabId: "t-1",
  sessionId: "s-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
} as const;

const BOUNDING_BOX = {
  x: 60,
  y: 90,
  width: 420,
  height: 40,
  top: 90,
  right: 480,
  bottom: 130,
  left: 60,
};

const BASE_ELEMENT = {
  selector: "main > h1",
  tagName: "h1",
  elementId: null,
  classNames: ["hero"],
  textPreview: "Example Domain",
  ariaRole: "heading",
  accessibleName: "Example Domain",
  boundingBox: BOUNDING_BOX,
  computedStyles: [{ property: "font-size", value: "26px" }],
};

/** A browser record exactly as every release before the canvas arm wrote it. */
const LEGACY_BROWSER_RECORD = {
  kind: "browser-annotation" as const,
  annotationId: "ann-browser",
  ...BROWSER_PAGE,
  capturedAt: 1_700_000_000_000,
  comment: "Make this hero section pop more",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [BASE_ELEMENT],
  imageFileName: "browser-annotation-ann-browser.png",
  imageHash: "abc123def456",
  droppedElementCount: 0,
};

const BROWSER_SOURCE = { kind: "browser" as const, ...BROWSER_PAGE };

/** The same record as the live schema parses it: `source` is present. */
const PARSED_BROWSER_RECORD = {
  ...LEGACY_BROWSER_RECORD,
  source: BROWSER_SOURCE,
};

const CANVAS_SOURCE = {
  kind: "canvas" as const,
  artifactId: "artifact-1",
  boardPath: "boards/pricing.canvas",
  canvasPage: "page-2",
  artifactTitle: "Pricing board",
};

const CANVAS_ELEMENT = {
  ...BASE_ELEMENT,
  sourceRange: { start: 120, end: 168, line: 7 },
  tid: "t-heading-1",
  textRange: { start: 124, end: 131, quote: "Pricing" },
};

/** A canvas record: no top-level browser fields, no crop. */
const CANVAS_RECORD = {
  kind: "browser-annotation" as const,
  annotationId: "ann-canvas",
  source: CANVAS_SOURCE,
  capturedAt: 1_700_000_000_500,
  comment: "Tighten the spacing under this heading",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [CANVAS_ELEMENT],
  imageFileName: null,
  imageHash: null,
  droppedElementCount: 0,
};

function withoutKey(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function canvasRecordWithElement(
  element: Record<string, unknown>,
): Record<string, unknown> {
  return { ...CANVAS_RECORD, elements: [element] };
}

function sendFrameWithAnnotations(
  browserAnnotations: ReadonlyArray<unknown>,
): Record<string, unknown> {
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
    browserAnnotations,
  };
}

describe("browser arm of browserAnnotationRecordSchema", () => {
  it("infers `source` from the top-level fields of a record written before the canvas arm", () => {
    const parsed = browserAnnotationRecordSchema.parse(LEGACY_BROWSER_RECORD);
    expect(parsed).toEqual(PARSED_BROWSER_RECORD);
    expect(parsed.source).toEqual(BROWSER_SOURCE);
  });

  it("keeps the legacy top-level fields alongside the inferred `source`", () => {
    const parsed = browserAnnotationRecordSchema.parse(LEGACY_BROWSER_RECORD);
    if (!("tabId" in parsed)) {
      throw new Error("expected the browser arm");
    }
    expect(parsed.tabId).toBe("t-1");
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.origin).toBe("https://example.com");
    expect(parsed.pageUrl).toBe("https://example.com/");
    expect(parsed.pageTitle).toBe("Example Domain");
  });

  it("round-trips a record that already states its `source`", () => {
    const parsed = browserAnnotationRecordSchema.parse(PARSED_BROWSER_RECORD);
    expect(parsed).toEqual(PARSED_BROWSER_RECORD);

    const serialized: unknown = JSON.parse(JSON.stringify(parsed));
    expect(browserAnnotationRecordSchema.parse(serialized)).toEqual(
      PARSED_BROWSER_RECORD,
    );
  });

  it("still defaults droppedElementCount to 0 on an older persisted record", () => {
    const parsed = browserAnnotationRecordSchema.parse(
      withoutKey(LEGACY_BROWSER_RECORD, "droppedElementCount"),
    );
    expect(parsed.droppedElementCount).toBe(0);
  });

  it.each(["tabId", "sessionId", "origin", "pageUrl", "pageTitle"])(
    "still requires the legacy top-level %s",
    (field) => {
      expect(
        browserAnnotationRecordSchema.safeParse(
          withoutKey(LEGACY_BROWSER_RECORD, field),
        ).success,
      ).toBe(false);
    },
  );

  it("still refuses a browser record without a crop", () => {
    expect(
      browserAnnotationRecordSchema.safeParse({
        ...LEGACY_BROWSER_RECORD,
        imageHash: null,
        imageFileName: null,
      }).success,
    ).toBe(false);
    expect(
      browserAnnotationRecordSchema.safeParse({
        ...LEGACY_BROWSER_RECORD,
        imageHash: null,
      }).success,
    ).toBe(false);
    expect(
      browserAnnotationRecordSchema.safeParse({
        ...LEGACY_BROWSER_RECORD,
        imageFileName: null,
      }).success,
    ).toBe(false);
  });

  it("leaves a browser element without the canvas-only element fields", () => {
    const parsed = browserAnnotationRecordSchema.parse(LEGACY_BROWSER_RECORD);
    const element = parsed.elements[0];
    expect(element).toEqual(BASE_ELEMENT);
    expect(element).not.toHaveProperty("sourceRange");
    expect(element).not.toHaveProperty("tid");
    expect(element).not.toHaveProperty("textRange");
  });
});

describe("canvas arm of browserAnnotationRecordSchema", () => {
  it("round-trips a canvas record with every field", () => {
    const parsed = browserAnnotationRecordSchema.parse(CANVAS_RECORD);
    expect(parsed).toEqual(CANVAS_RECORD);
    expect(parsed.kind).toBe("browser-annotation");
    expect(parsed.source).toEqual(CANVAS_SOURCE);
    expect(parsed.elements[0]).toEqual(CANVAS_ELEMENT);

    const serialized: unknown = JSON.parse(JSON.stringify(parsed));
    expect(browserAnnotationRecordSchema.parse(serialized)).toEqual(
      CANVAS_RECORD,
    );
  });

  it("carries no top-level browser page fields", () => {
    const parsed = browserAnnotationRecordSchema.parse(CANVAS_RECORD);
    for (const field of Object.keys(BROWSER_PAGE)) {
      expect(parsed).not.toHaveProperty(field);
    }
  });

  it("accepts a canvas record with no crop: imageHash and imageFileName are null", () => {
    const parsed = browserAnnotationRecordSchema.parse(CANVAS_RECORD);
    expect(parsed.imageHash).toBeNull();
    expect(parsed.imageFileName).toBeNull();
  });

  it("accepts a canvas record that does carry a crop", () => {
    const withCrop = {
      ...CANVAS_RECORD,
      imageFileName: "browser-annotation-ann-canvas.png",
      imageHash: "0123456789abcdef",
    };
    expect(browserAnnotationRecordSchema.parse(withCrop)).toEqual(withCrop);
  });

  it("accepts a canvas that is not on a named page: canvasPage is null", () => {
    const record = {
      ...CANVAS_RECORD,
      source: { ...CANVAS_SOURCE, canvasPage: null },
    };
    const parsed = browserAnnotationRecordSchema.parse(record);
    expect(parsed.source).toEqual({ ...CANVAS_SOURCE, canvasPage: null });
  });

  it.each(["artifactId", "boardPath", "artifactTitle"])(
    "requires source.%s",
    (field) => {
      expect(
        browserAnnotationRecordSchema.safeParse({
          ...CANVAS_RECORD,
          source: withoutKey(CANVAS_SOURCE, field),
        }).success,
      ).toBe(false);
    },
  );

  it("defaults the element's place-in-source fields to null", () => {
    const parsed = browserAnnotationRecordSchema.parse(
      canvasRecordWithElement(BASE_ELEMENT),
    );
    const element = parsed.elements[0];
    expect(element).toMatchObject({
      ...BASE_ELEMENT,
      sourceRange: null,
      tid: null,
      textRange: null,
    });
  });

  it("keeps each place-in-source field independent of the others", () => {
    const parsed = browserAnnotationRecordSchema.parse(
      canvasRecordWithElement({
        ...BASE_ELEMENT,
        textRange: { start: 0, end: 4, quote: "Word" },
      }),
    );
    expect(parsed.elements[0]).toMatchObject({
      sourceRange: null,
      tid: null,
      textRange: { start: 0, end: 4, quote: "Word" },
    });
  });
});

describe("canvas element place-in-source bounds", () => {
  it("accepts a source range that starts at offset 0 on line 1", () => {
    expect(
      browserAnnotationRecordSchema.safeParse(
        canvasRecordWithElement({
          ...CANVAS_ELEMENT,
          sourceRange: { start: 0, end: 0, line: 1 },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["a negative start", { start: -1, end: 4, line: 1 }],
    ["a negative end", { start: 0, end: -1, line: 1 }],
    ["a fractional start", { start: 1.5, end: 4, line: 1 }],
    ["a fractional end", { start: 0, end: 4.5, line: 1 }],
    ["line 0", { start: 0, end: 4, line: 0 }],
    ["a negative line", { start: 0, end: 4, line: -3 }],
    ["a fractional line", { start: 0, end: 4, line: 1.5 }],
  ])("refuses a source range with %s", (_label, sourceRange) => {
    expect(
      browserAnnotationRecordSchema.safeParse(
        canvasRecordWithElement({ ...CANVAS_ELEMENT, sourceRange }),
      ).success,
    ).toBe(false);
  });

  it("accepts a text range that starts at offset 0", () => {
    expect(
      browserAnnotationRecordSchema.safeParse(
        canvasRecordWithElement({
          ...CANVAS_ELEMENT,
          textRange: { start: 0, end: 7, quote: "Pricing" },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["a negative start", { start: -1, end: 7, quote: "Pricing" }],
    ["a negative end", { start: 0, end: -7, quote: "Pricing" }],
    ["a fractional start", { start: 0.5, end: 7, quote: "Pricing" }],
    ["a fractional end", { start: 0, end: 6.5, quote: "Pricing" }],
    ["no quote", { start: 0, end: 7 }],
  ])("refuses a text range with %s", (_label, textRange) => {
    expect(
      browserAnnotationRecordSchema.safeParse(
        canvasRecordWithElement({ ...CANVAS_ELEMENT, textRange }),
      ).success,
    ).toBe(false);
  });
});

describe("page markup never survives the canvas arm either", () => {
  it("strips markup and raw attributes off a canvas element", () => {
    const parsed = browserAnnotationRecordSchema.parse(
      canvasRecordWithElement({
        ...CANVAS_ELEMENT,
        attributes: [{ name: "data-session", value: "sessionid=abc123" }],
        outerHtml: "<h1 data-session='sessionid=abc123'>Hi</h1>",
        outerHtmlTruncated: false,
      }),
    );
    const element = parsed.elements[0];
    expect(element).not.toHaveProperty("outerHtml");
    expect(element).not.toHaveProperty("outerHtmlTruncated");
    expect(element).not.toHaveProperty("attributes");
    expect(JSON.stringify(parsed)).not.toContain("sessionid=abc123");
  });
});

describe("the two arms are told apart", () => {
  it("refuses a record that states neither arm's identifying fields", () => {
    expect(
      browserAnnotationRecordSchema.safeParse(
        withoutKey(CANVAS_RECORD, "source"),
      ).success,
    ).toBe(false);
  });

  it("refuses an unknown source kind", () => {
    expect(
      browserAnnotationRecordSchema.safeParse({
        ...CANVAS_RECORD,
        source: { ...CANVAS_SOURCE, kind: "figma" },
      }).success,
    ).toBe(false);
  });

  it("parses a mixed array of both arms in order", () => {
    const parsed = userAuthoredMessageSchema.parse({
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations: [LEGACY_BROWSER_RECORD, CANVAS_RECORD],
    });
    expect(parsed.browserAnnotations).toEqual([
      PARSED_BROWSER_RECORD,
      CANVAS_RECORD,
    ]);
  });
});

describe("live send frame browserAnnotations carries both arms", () => {
  it("keeps a canvas record on the live send frame", () => {
    const parsed = chatSubscribeClientFrameSchema.parse(
      sendFrameWithAnnotations([CANVAS_RECORD]),
    );
    if (parsed.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(parsed.browserAnnotations).toEqual([CANVAS_RECORD]);
  });

  it("infers a legacy browser record's source on the live send frame", () => {
    const parsed = chatSubscribeClientFrameSchema.parse(
      sendFrameWithAnnotations([LEGACY_BROWSER_RECORD]),
    );
    if (parsed.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(parsed.browserAnnotations).toEqual([PARSED_BROWSER_RECORD]);
  });
});
