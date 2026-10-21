import { getRecordSchema } from "@traycer/protocol/framework/index";
import {
  canonicalJsonStringify,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  encodeChatShard,
  serializeChatShard,
} from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  persistenceRecordRegistry,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";

/**
 * A published chat that carries annotations survives a read/write cycle on a
 * canvas-aware reader. Shards are content-addressed, so a re-publication that
 * changed a byte of an unchanged cohort would mint a new hash and re-upload
 * the chat.
 *
 * Two shapes matter. A browser annotation written before the canvas arm has no
 * `source`: the reader's parsed view infers one, but the persisted object it
 * re-emits must stay as written. A canvas annotation with no crop has a null
 * `imageHash` and `imageFileName`, which must survive as nulls rather than
 * being dropped or defaulted.
 */

const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

const BROWSER_PAGE = {
  tabId: "t-1",
  sessionId: "s-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example Domain",
} as const;

const COMMON_FIELDS = {
  kind: "browser-annotation",
  capturedAt: 1_700_000_000_000,
  comment: "Tighten this up",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  droppedElementCount: 0,
} satisfies JsonObject;

/** Persisted before the canvas arm: no `source`. */
const SOURCELESS_BROWSER_ANNOTATION: JsonObject = {
  ...COMMON_FIELDS,
  annotationId: "ann-old-browser",
  ...BROWSER_PAGE,
  imageFileName: "browser-annotation-ann-old-browser.png",
  imageHash: "abc123def456",
};

const NO_CROP_CANVAS_ANNOTATION: JsonObject = {
  ...COMMON_FIELDS,
  annotationId: "ann-canvas-no-crop",
  source: {
    kind: "canvas",
    artifactId: "artifact-1",
    boardPath: "boards/pricing.canvas",
    canvasPage: null,
    artifactTitle: "Pricing board",
  },
  elements: [
    {
      selector: "section > h2",
      tagName: "h2",
      elementId: null,
      classNames: [],
      textPreview: "Pricing",
      ariaRole: "heading",
      accessibleName: "Pricing",
      boundingBox: {
        x: 10,
        y: 20,
        width: 200,
        height: 30,
        top: 20,
        right: 210,
        bottom: 50,
        left: 10,
      },
      computedStyles: [],
      sourceRange: { start: 120, end: 168, line: 7 },
      tid: "t-heading-1",
      textRange: { start: 124, end: 131, quote: "Pricing" },
    },
  ],
  imageFileName: null,
  imageHash: null,
};

function userMessage(
  messageId: string,
  browserAnnotations: JsonObject[],
): JsonObject {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "u-1" },
    message: {
      kind: "user",
      content: { type: "doc" },
      browserAnnotations,
    },
    timestamp: 1,
    sessionAnchor: null,
  };
}

const annotatedShard: JsonObject = {
  schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
  chatId: "chat-1",
  section: "messages",
  messages: [
    userMessage("m-old-browser", [SOURCELESS_BROWSER_ANNOTATION]),
    userMessage("m-canvas", [NO_CROP_CANVAS_ANNOTATION]),
  ],
  events: [],
  hostPrivate: null,
};

function parse(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

function annotationsOfMessage(
  shard: ChatShard,
  index: number,
): ReadonlyArray<unknown> {
  const value = shard.messages[index].value;
  if (
    value === null ||
    value.role !== "user" ||
    value.message.kind !== "user"
  ) {
    throw new Error("expected an interpreted user-authored message");
  }
  return value.message.browserAnnotations;
}

describe("chat-shard annotation preservation", () => {
  it("re-emits a source-less browser annotation and a no-crop canvas annotation byte-identically", () => {
    expect(serializeChatShard(parse(annotatedShard))).toBe(
      canonicalJsonStringify(annotatedShard),
    );
  });

  it("infers the browser source in the interpreted view only", () => {
    const shard = parse(annotatedShard);
    expect(annotationsOfMessage(shard, 0)).toEqual([
      {
        ...SOURCELESS_BROWSER_ANNOTATION,
        source: { kind: "browser", ...BROWSER_PAGE },
      },
    ]);
  });

  it("interprets the no-crop canvas annotation with its nulls and element keys intact", () => {
    const shard = parse(annotatedShard);
    expect(annotationsOfMessage(shard, 1)).toEqual([NO_CROP_CANVAS_ANNOTATION]);
  });

  it("survives repeated read/write cycles (the clone path)", () => {
    const once = encodeChatShard(parse(annotatedShard));
    const twice = encodeChatShard(parse(once));
    expect(twice).toEqual(once);
  });
});
