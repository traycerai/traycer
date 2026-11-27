import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  canonicalJsonStringify,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  decodeDraftHeadDocument,
  decodeDraftHeadDocumentV11,
  DRAFT_HEAD_PARTS_KEY,
  draftComposerPortableSchemaV11,
  draftHeadDocumentPayloadSchemaV11,
  draftTombstoneDocumentSchemaV11,
  DRAFT_HEAD_SCHEMA_VERSION_V11,
  serializeDraftHeadDocument,
  serializeDraftHeadDocumentV11,
  serializeDraftTombstoneDocumentV11,
  type DraftHeadDocumentV11,
  type DraftHeadRecord,
} from "@traycer/protocol/persistence/draft/index";

const IMAGE_HASH = "11".repeat(32);
const CROP_HASH = "22".repeat(32);
const EXTRA_HASH = "33".repeat(32);
const REQUEST_HASH = "44".repeat(32);

const RUN_SETTINGS = {
  harnessId: "claude" as const,
  model: "claude-sonnet-4",
  permissionMode: "supervised" as const,
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular" as const,
  profileId: null,
};

const V10_HEAD: DraftHeadRecord = {
  dialect: "draft/v1",
  schemaVersion: { major: 1, minor: 0 },
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1_753_000_000_000,
  target: { epicId: null, chatId: null, blockId: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: { from: 1, to: 1 },
    runSettings: RUN_SETTINGS,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
  hostLocal: { hostId: "host-fake-1", workspace: null },
};

const BROWSER_ANNOTATION = {
  kind: "browser-annotation" as const,
  annotationId: "annotation-browser-fake",
  tabId: "tab-fake-1",
  sessionId: "session-fake-1",
  origin: "https://example.invalid",
  pageUrl: "https://example.invalid/page",
  pageTitle: "Fake page",
  capturedAt: 1_753_000_000_001,
  comment: "Fake browser note",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "browser-crop.png",
  imageHash: CROP_HASH,
  droppedElementCount: 0,
  source: {
    kind: "browser" as const,
    tabId: "tab-fake-1",
    sessionId: "session-fake-1",
    origin: "https://example.invalid",
    pageUrl: "https://example.invalid/page",
    pageTitle: "Fake page",
  },
};

const CANVAS_ANNOTATION_WITHOUT_CROP = {
  kind: "browser-annotation" as const,
  annotationId: "annotation-canvas-fake",
  source: {
    kind: "canvas" as const,
    artifactId: "artifact-fake-1",
    boardPath: "boards/fake",
    canvasPage: null,
    artifactTitle: "Fake board",
  },
  capturedAt: 1_753_000_000_002,
  comment: "Fake canvas note",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: null,
  imageHash: null,
  droppedElementCount: 0,
};

const V11_HEAD: DraftHeadDocumentV11 = {
  dialect: "draft/v1",
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION_V11,
  kind: "draft",
  surfaceKind: "chat-composer",
  lastTouchedAt: 1_753_000_000_010,
  target: { epicId: "epic-fake-1", chatId: "chat-fake-1", blockId: null },
  operationId: "operation-fake-1",
  requestSha256: REQUEST_HASH,
  portable: {
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: { hash: IMAGE_HASH, fileName: "image.png" },
            },
          ],
        },
      ],
    },
    selection: { from: 1, to: 1 },
    runSettings: RUN_SETTINGS,
    composerMode: "chat",
    blobHashes: [IMAGE_HASH, CROP_HASH],
    closed: false,
    annotations: [BROWSER_ANNOTATION, CANVAS_ANNOTATION_WITHOUT_CROP],
  },
  hostLocal: { hostId: "host-fake-1", workspace: null },
};

function portableWith(
  overrides: Partial<DraftHeadDocumentV11["portable"]>,
): DraftHeadDocumentV11["portable"] {
  return { ...V11_HEAD.portable, ...overrides };
}

function serializeFutureMinor(): string {
  const document = JSON.parse(
    serializeDraftHeadDocumentV11(V11_HEAD),
  ) as JsonObject;
  document.schemaVersion = { major: 1, minor: 2 };
  return canonicalJsonStringify(document);
}

function serializeUnknownMajor(): string {
  const document = JSON.parse(
    serializeDraftHeadDocumentV11(V11_HEAD),
  ) as JsonObject;
  document.schemaVersion = { major: 2, minor: 1 };
  return canonicalJsonStringify(document);
}

function requireOk<T>(
  result:
    | { readonly status: "ok"; readonly record: T }
    | { readonly status: "corrupt"; readonly reason: string },
): T {
  if (result.status !== "ok") {
    throw new Error(`Expected readable draft head, got ${result.reason}`);
  }
  return result.record;
}

describe("draft-head v1.0 canonical fixture", () => {
  it("keeps the released v1.0 document bytes unchanged", () => {
    expect(serializeDraftHeadDocument(V10_HEAD)).toBe(
      '{"dialect":"draft/v1","hostLocal":{"hostId":"host-fake-1","workspace":null},"kind":"draft","lastTouchedAt":1753000000000,"parts":[],"portable":{"blobHashes":[],"closed":false,"composerMode":"chat","content":{"content":[{"type":"paragraph"}],"type":"doc"},"runSettings":{"agentMode":"regular","harnessId":"claude","model":"claude-sonnet-4","permissionMode":"supervised","profileId":null,"reasoningEffort":null,"serviceTier":null},"selection":{"from":1,"to":1}},"schemaVersion":{"major":1,"minor":0},"surfaceKind":"landing","target":{"blockId":null,"chatId":null,"epicId":null}}',
    );
  });
});

describe("draft-head v1.1 canonical fixture", () => {
  it("stores ordered annotations and mutation fingerprints in canonical bytes", () => {
    expect(serializeDraftHeadDocumentV11(V11_HEAD)).toBe(
      '{"dialect":"draft/v1","hostLocal":{"hostId":"host-fake-1","workspace":null},"kind":"draft","lastTouchedAt":1753000000010,"operationId":"operation-fake-1","parts":[],"portable":{"annotations":[{"annotationId":"annotation-browser-fake","capturedAt":1753000000001,"comment":"Fake browser note","counts":{"elements":0,"regions":0,"strokes":0},"droppedElementCount":0,"elements":[],"imageFileName":"browser-crop.png","imageHash":"2222222222222222222222222222222222222222222222222222222222222222","kind":"browser-annotation","origin":"https://example.invalid","pageTitle":"Fake page","pageUrl":"https://example.invalid/page","sessionId":"session-fake-1","source":{"kind":"browser","origin":"https://example.invalid","pageTitle":"Fake page","pageUrl":"https://example.invalid/page","sessionId":"session-fake-1","tabId":"tab-fake-1"},"tabId":"tab-fake-1"},{"annotationId":"annotation-canvas-fake","capturedAt":1753000000002,"comment":"Fake canvas note","counts":{"elements":0,"regions":0,"strokes":0},"droppedElementCount":0,"elements":[],"imageFileName":null,"imageHash":null,"kind":"browser-annotation","source":{"artifactId":"artifact-fake-1","artifactTitle":"Fake board","boardPath":"boards/fake","canvasPage":null,"kind":"canvas"}}],"blobHashes":["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"],"closed":false,"composerMode":"chat","content":{"content":[{"content":[{"attrs":{"fileName":"image.png","hash":"1111111111111111111111111111111111111111111111111111111111111111"},"type":"imageAttachment"}],"type":"paragraph"}],"type":"doc"},"runSettings":{"agentMode":"regular","harnessId":"claude","model":"claude-sonnet-4","permissionMode":"supervised","profileId":null,"reasoningEffort":null,"serviceTier":null},"selection":{"from":1,"to":1}},"requestSha256":"4444444444444444444444444444444444444444444444444444444444444444","schemaVersion":{"major":1,"minor":1},"surfaceKind":"chat-composer","target":{"blockId":null,"chatId":"chat-fake-1","epicId":"epic-fake-1"}}',
    );
    const decoded = decodeDraftHeadDocumentV11(
      serializeDraftHeadDocumentV11(V11_HEAD),
    );
    const record = requireOk(decoded);
    expect(record.operationId).toBe("operation-fake-1");
    expect(record.portable.annotations).toEqual([
      BROWSER_ANNOTATION,
      CANVAS_ANNOTATION_WITHOUT_CROP,
    ]);
    expect(record.portable.blobHashes).toEqual([IMAGE_HASH, CROP_HASH]);
    expect(record.requestSha256).toBe(REQUEST_HASH);
  });

  it("requires the exact original request fingerprint", () => {
    const { requestSha256: _requestSha256, ...withoutFingerprint } = V11_HEAD;
    expect(
      draftHeadDocumentPayloadSchemaV11.safeParse(withoutFingerprint).success,
    ).toBe(false);
  });

  it("keeps the 1.1 version and operation literal when annotations are cleared", () => {
    const cleared: DraftHeadDocumentV11 = {
      ...V11_HEAD,
      operationId: "operation-clear-all-fake",
      portable: portableWith({ annotations: [], blobHashes: [IMAGE_HASH] }),
    };
    const decoded = decodeDraftHeadDocumentV11(
      serializeDraftHeadDocumentV11(cleared),
    );
    const record = requireOk(decoded);
    expect(record.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(record.operationId).toBe("operation-clear-all-fake");
    expect(record.portable.annotations).toEqual([]);
  });
});

describe("draft tombstone v1.1 canonical fixture", () => {
  it("stores the operation and request fingerprint in a canonical tombstone", () => {
    const mutation = {
      operationId: "operation-delete-fake-1",
      requestSha256: REQUEST_HASH,
    };
    expect(serializeDraftTombstoneDocumentV11(mutation)).toBe(
      '{"dialect":"draft/v1","kind":"tombstone","operationId":"operation-delete-fake-1","parts":[],"requestSha256":"4444444444444444444444444444444444444444444444444444444444444444","schemaVersion":{"major":1,"minor":1}}',
    );

    const parsed = JSON.parse(
      serializeDraftTombstoneDocumentV11(mutation),
    ) as Record<string, unknown>;
    expect(draftTombstoneDocumentSchemaV11.parse(parsed)).toEqual(parsed);
    expect(
      draftTombstoneDocumentSchemaV11.safeParse({
        ...parsed,
        schemaVersion: { major: 1, minor: 0 },
      }).success,
    ).toBe(false);
    expect(
      draftTombstoneDocumentSchemaV11.safeParse({
        ...parsed,
        parts: ["unexpected"],
      }).success,
    ).toBe(false);
  });
});

describe("draft-head exact minor readers", () => {
  it("refuses 1.1 through the exact v1.0 decoder", () => {
    const result = decodeDraftHeadDocument(
      serializeDraftHeadDocumentV11(V11_HEAD),
    );
    expect(result).toMatchObject({
      status: "corrupt",
      reason: "schema-rejected",
    });
  });

  it("refuses a v1.0 document through the exact v1.1 decoder", () => {
    const result = decodeDraftHeadDocumentV11(
      serializeDraftHeadDocument(V10_HEAD),
    );
    expect(result).toMatchObject({
      status: "corrupt",
      reason: "schema-rejected",
    });
  });

  it("refuses future minors through the exact v1.1 decoder", () => {
    const result = decodeDraftHeadDocumentV11(serializeFutureMinor());
    expect(result).toMatchObject({
      status: "corrupt",
      reason: "schema-rejected",
    });
  });

  it("refuses an otherwise-valid unknown major through the v1.1 decoder", () => {
    const result = decodeDraftHeadDocumentV11(serializeUnknownMajor());
    expect(result).toMatchObject({
      status: "corrupt",
      reason: "schema-rejected",
    });
  });
});

describe("draft-head v1.1 blob hash union", () => {
  it("accepts a deduplicated image and crop hash union, including a shared hash", () => {
    const sharedHash = IMAGE_HASH;
    const annotations = [
      { ...BROWSER_ANNOTATION, imageHash: sharedHash },
      { ...CANVAS_ANNOTATION_WITHOUT_CROP, imageHash: CROP_HASH },
    ];
    const portable = portableWith({
      blobHashes: [IMAGE_HASH, CROP_HASH],
      annotations,
    });
    expect(draftComposerPortableSchemaV11.safeParse(portable).success).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing image hash",
      portable: portableWith({ blobHashes: [CROP_HASH] }),
    },
    {
      name: "missing crop hash",
      portable: portableWith({ blobHashes: [IMAGE_HASH] }),
    },
    {
      name: "extra hash",
      portable: portableWith({
        blobHashes: [IMAGE_HASH, CROP_HASH, EXTRA_HASH],
      }),
    },
    {
      name: "duplicate hash",
      portable: portableWith({
        blobHashes: [IMAGE_HASH, CROP_HASH, IMAGE_HASH],
      }),
    },
    {
      name: "inline image bytes",
      portable: portableWith({
        content: {
          type: "doc",
          content: [
            {
              type: "imageAttachment",
              attrs: { hash: IMAGE_HASH, b64content: "fake-inline-bytes" },
            },
          ],
        },
      }),
    },
  ])("rejects $name", ({ portable }) => {
    expect(draftComposerPortableSchemaV11.safeParse(portable).success).toBe(
      false,
    );
  });
});

function portableWithInlineNodes(
  nodes: JsonContent[],
): DraftHeadDocumentV11["portable"] {
  return portableWith({
    content: { type: "doc", content: [{ type: "paragraph", content: nodes }] },
    blobHashes: [],
    annotations: [],
  });
}

describe("draft-head v1.1 unsupported file references", () => {
  it.each([
    {
      description: "a valid fileAttachment with no declared blob hashes",
      node: {
        type: "fileAttachment",
        attrs: {
          id: "node-fake-1",
          hash: "ab".repeat(32),
          fileName: "report.pdf",
          mediaType: "application/pdf",
          size: 1024,
        },
      },
      message: "File attachments cannot be published in cloud drafts.",
    },
    {
      description: "a workspace file mention",
      node: {
        type: "mention",
        attrs: {
          contextType: "file",
          id: "file-fake-1",
          label: "report.txt",
          path: "/repo/report.txt",
          relPath: "report.txt",
        },
      },
      message:
        "References to files on a computer cannot be published in cloud drafts.",
    },
    {
      description: "a path-backed slash command",
      node: {
        type: "slashCommand",
        attrs: { commandName: "implement", path: "/repo/command.md" },
      },
      message:
        "References to files on a computer cannot be published in cloud drafts.",
    },
  ])("rejects $description", ({ node, message }) => {
    expect(
      draftComposerPortableSchemaV11.safeParse(portableWithInlineNodes([node])),
    ).toMatchObject({
      success: false,
      error: { issues: [{ code: "custom", path: ["content"], message }] },
    });
  });

  it("preserves mentions and commands that refer to names or identities", () => {
    const portable = portableWithInlineNodes([
      {
        type: "mention",
        attrs: {
          contextType: "github_issue",
          id: "issue-fake-1",
          label: "Fake issue",
        },
      },
      { type: "slashCommand", attrs: { commandName: "implement" } },
    ]);
    expect(draftComposerPortableSchemaV11.parse(portable)).toEqual(portable);
  });
});
