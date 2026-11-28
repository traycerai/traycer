import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextType } from "@traycer/protocol/common/json-content-serializer";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  browserAnnotationRecordSchema,
  canvasAnnotationRecordSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  pendingSend,
  PICKED_SETTINGS,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import type { PendingSandboxSend } from "@/stores/sandboxes/pending-sandbox-send-store";
import { NO_DRAFT_IMAGE_BYTE_TARGET } from "@/lib/drafts/resolve-draft-image-bytes";
import { saveUnsentWholeDraft } from "../save-unsent-whole-draft";

const boundary = vi.hoisted(() => ({
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  putDraftBlobs:
    vi.fn<
      (
        hostId: string,
        client: unknown,
        hashes: ReadonlyArray<string>,
        userId: string,
      ) => Promise<ReadonlyArray<string>>
    >(),
  putImageBytesAtHash:
    vi.fn<(hash: string, bytes: ImageBytes) => Promise<boolean>>(),
  resolveDraftImageBytes:
    vi.fn<(hash: string, source: unknown) => Promise<Uint8Array | null>>(),
}));

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (load) => ({
    ...(await load<
      typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
    >()),
    readProcessHostRpcTierPlan: () => ({ pool: {} }),
  }),
);
vi.mock("@/lib/host/runtime", () => ({ getAppHostClientSnapshot: () => ({}) }));
vi.mock("@/lib/host/binding-host-client", () => ({
  resolvePoolTierHostClient: () => ({ request: boundary.request }),
}));
vi.mock("@/lib/host/read-negotiated-method-version", () => ({
  readNegotiatedMethodVersion: () => ({ major: 1, minor: 0 }),
}));
vi.mock("@/lib/drafts/draft-blob-transport", () => ({
  putDraftBlobs: boundary.putDraftBlobs,
}));
vi.mock("@/lib/composer/landing-image-store", async (load) => ({
  ...(await load<typeof import("@/lib/composer/landing-image-store")>()),
  putImageBytesAtHash: boundary.putImageBytesAtHash,
}));
vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (load) => ({
  ...(await load<typeof import("@/lib/drafts/resolve-draft-image-bytes")>()),
  resolveDraftImageBytes: boundary.resolveDraftImageBytes,
}));

const DRAFT_ID = "draft-1";
const INLINE_HASH = "a".repeat(64);
const SHARED_HASH = "b".repeat(64);
const CROP_HASH = "c".repeat(64);
const BYTES = new Uint8Array([1, 2, 3]);

function image(id: string, hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName: `${id}.png`,
      hash,
      mimeType: "image/png",
      size: 3,
    },
  };
}

const CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "see " },
        { type: "fileAttachment", attrs: { fileName: "report.pdf" } },
        { type: "text", text: " and " },
        {
          type: "mention",
          attrs: {
            contextType: ContextType.File,
            label: "app.ts",
            path: "/other-machine/src/app.ts",
          },
        },
        { type: "text", text: " then " },
        {
          type: "slashCommand",
          attrs: { commandName: "review", path: "/other-machine/review.md" },
        },
        image("inline", INLINE_HASH),
        image("shared", SHARED_HASH),
      ],
    },
  ],
};

const PORTABLE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "see " },
        { type: "text", text: "report.pdf" },
        { type: "text", text: " and " },
        { type: "text", text: "app.ts" },
        { type: "text", text: " then " },
        { type: "text", text: "/review" },
        image("inline", INLINE_HASH),
        image("shared", SHARED_HASH),
      ],
    },
  ],
};

const COMMON = {
  kind: "browser-annotation",
  capturedAt: 1,
  comment: "note",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
};
const ANNOTATIONS: ReadonlyArray<BrowserAnnotationRecord> = [
  canvasAnnotationRecordSchema.parse({
    ...COMMON,
    annotationId: "ann-canvas",
    source: {
      kind: "canvas",
      artifactId: "artifact-1",
      boardPath: "boards/home.html",
      canvasPage: null,
      artifactTitle: "Study",
    },
    imageFileName: "canvas-selection.png",
    imageHash: SHARED_HASH,
  }),
  browserAnnotationRecordSchema.parse({
    ...COMMON,
    annotationId: "ann-browser",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    imageFileName: "browser-annotation-ann-browser.png",
    imageHash: CROP_HASH,
  }),
];

const MESSAGE_SEND = pendingSend({
  content: CONTENT,
  request: {
    kind: "message",
    chatId: "chat-1",
    browserAnnotations: ANNOTATIONS,
  },
});

const always = (): boolean => true;

function save(send: PendingSandboxSend, stillCurrent: () => boolean) {
  return saveUnsentWholeDraft({
    send,
    draftId: DRAFT_ID,
    source: NO_DRAFT_IMAGE_BYTE_TARGET,
    stillCurrent,
  });
}

beforeEach(() => {
  boundary.request.mockReset();
  boundary.request.mockResolvedValue({ kind: "saved", draftId: DRAFT_ID });
  boundary.putDraftBlobs.mockReset();
  boundary.putDraftBlobs.mockImplementation((_host, _client, hashes) =>
    Promise.resolve(hashes),
  );
  boundary.putImageBytesAtHash.mockReset();
  boundary.putImageBytesAtHash.mockResolvedValue(true);
  boundary.resolveDraftImageBytes.mockReset();
  boundary.resolveDraftImageBytes.mockResolvedValue(BYTES);
});

describe("saveUnsentWholeDraft", () => {
  it("saves the exact head: dead machine references stay as words in place, cards keep their order, blob hashes are the deduplicated union", async () => {
    const head = await save(MESSAGE_SEND, always);

    expect(head?.portable.content).toEqual(PORTABLE_CONTENT);
    expect(head?.portable.annotations.map((a) => a.annotationId)).toEqual([
      "ann-canvas",
      "ann-browser",
    ]);
    expect(head?.portable.runSettings).toMatchObject({
      harnessId: PICKED_SETTINGS.harnessId,
      model: PICKED_SETTINGS.model,
    });
    const expectedHashes = [INLINE_HASH, SHARED_HASH, CROP_HASH];
    expect(head?.portable.blobHashes).toEqual(expectedHashes);
    expect(boundary.putDraftBlobs.mock.calls[0]?.[2]).toEqual(expectedHashes);
    expect(
      boundary.putImageBytesAtHash.mock.calls.map((call) => call[0]),
    ).toEqual(expectedHashes);
    expect(boundary.request).toHaveBeenCalledExactlyOnceWith(
      "drafts.mutateWhole",
      { kind: "save", draftId: DRAFT_ID, head },
    );
  });

  it.each([
    ["chat", { kind: "chat", parentId: null, placement: null }, true],
    ["terminal", { kind: "terminal" }, false],
  ] as const)("a %s request is saved: %s", async (_name, request, saved) => {
    const result = await save(
      pendingSend({ content: CONTENT, request }),
      always,
    );
    expect(result !== null).toBe(saved);
    expect(boundary.request).toHaveBeenCalledTimes(saved ? 1 : 0);
  });

  it("a blob that cannot be had or stored stops before the host is asked to save", async () => {
    boundary.resolveDraftImageBytes.mockImplementation((hash) =>
      Promise.resolve(hash === CROP_HASH ? null : BYTES),
    );
    expect(await save(MESSAGE_SEND, always)).toBeNull();

    boundary.resolveDraftImageBytes.mockResolvedValue(BYTES);
    boundary.putDraftBlobs.mockImplementation((_host, _client, hashes) =>
      Promise.resolve(hashes.slice(1)),
    );
    expect(await save(MESSAGE_SEND, always)).toBeNull();

    expect(boundary.request).not.toHaveBeenCalled();
  });

  it("an acknowledgement for anything but this saved draft is not a save", async () => {
    boundary.request.mockResolvedValue({ kind: "saved", draftId: "other" });
    expect(await save(MESSAGE_SEND, always)).toBeNull();

    boundary.request.mockResolvedValue({ kind: "conflict" });
    expect(await save(MESSAGE_SEND, always)).toBeNull();
  });

  it("losing the current attempt while blobs upload stops the save", async () => {
    let current = true;
    boundary.putDraftBlobs.mockImplementation((_host, _client, hashes) => {
      current = false;
      return Promise.resolve(hashes);
    });

    expect(await save(MESSAGE_SEND, () => current)).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
  });
});
