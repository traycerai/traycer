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
import { serializeDraftHeadDocumentV11 } from "@traycer/protocol/persistence/draft/document";
import {
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  readSavedWholeDraft,
  retireSentWholeDraft,
  saveUnsentWholeDraft,
} from "../save-unsent-whole-draft";

const boundary = vi.hoisted(() => ({
  /** Hashes the fake pool currently holds; the real invalidation empties it. */
  confirmed: new Set<string>(),
  uploaded: new Array<ReadonlyArray<string>>(),
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
vi.mock("@/lib/drafts/draft-blob-transport", async (load) => ({
  ...(await load<typeof import("@/lib/drafts/draft-blob-transport")>()),
  putDraftBlobs: boundary.putDraftBlobs,
  invalidateDraftBlobConfirmations: (
    _host: string,
    hashes: ReadonlyArray<string>,
  ) => {
    for (const hash of hashes) boundary.confirmed.delete(hash);
  },
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
  boundary.confirmed.clear();
  boundary.uploaded.length = 0;
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

  it("a stale-authority refusal of the save is not a save and drops the pool's blob confirmations, so a retry uploads the same hashes again", async () => {
    boundary.putDraftBlobs.mockImplementation((_host, _client, hashes) => {
      const missing = hashes.filter((hash) => !boundary.confirmed.has(hash));
      if (missing.length > 0) boundary.uploaded.push(missing);
      for (const hash of hashes) boundary.confirmed.add(hash);
      return Promise.resolve(hashes);
    });
    boundary.request.mockRejectedValueOnce(
      new HostRpcError({
        code: "CHAT_PUBLICATION_STALE_AUTHORITY",
        message: "stale authority",
        requestId: "req-stale",
        method: "drafts.mutateWhole",
        fatalDetails: null,
      }),
    );

    expect(await save(MESSAGE_SEND, always)).toBeNull();
    const hashes = [INLINE_HASH, SHARED_HASH, CROP_HASH];
    expect(boundary.uploaded).toEqual([hashes]);
    expect(boundary.confirmed.size).toBe(0);

    const head = await save(MESSAGE_SEND, always);
    expect(boundary.uploaded).toEqual([hashes, hashes]);
    expect(head?.portable.blobHashes).toEqual(hashes);
    expect(boundary.request).toHaveBeenCalledTimes(2);
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

describe("readSavedWholeDraft", () => {
  const SCOPE = "scope-1";
  const OPERATION_ID = "00000000-0000-4000-8000-000000000001";

  async function committedHead(): Promise<string> {
    const head = await save(MESSAGE_SEND, always);
    if (head === null) throw new Error("expected a saved head");
    return serializeDraftHeadDocumentV11({
      ...head,
      operationId: OPERATION_ID,
      requestSha256: "d".repeat(64),
    });
  }

  function answer(resolve: unknown): void {
    boundary.request.mockImplementation((method) =>
      Promise.resolve(method === "drafts.list" ? { scopeId: SCOPE } : resolve),
    );
  }

  it("reads the committed head through the own pool scope, verified by its digest", async () => {
    const head = await committedHead();
    boundary.request.mockClear();
    answer({
      outcome: { status: "ok", head, headSha256: await digest(head) },
    });

    const read = await readSavedWholeDraft(DRAFT_ID, "user-read-ok", always);

    expect(read?.portable.annotations.map((a) => a.annotationId)).toEqual([
      "ann-canvas",
      "ann-browser",
    ]);
    expect(boundary.request.mock.calls).toEqual([
      ["drafts.list", {}],
      [
        "epic.resolveCloudChatHead",
        { taskId: SCOPE, chatId: DRAFT_ID, ownerUserId: "user-read-ok" },
      ],
    ]);
  });

  it("answers null only for an exact absence, and undefined for anything inconclusive", async () => {
    const head = await committedHead();
    answer({ outcome: { status: "missing" } });
    expect(
      await readSavedWholeDraft(DRAFT_ID, "user-read-missing", always),
    ).toBeNull();

    answer({ outcome: { status: "ok", head, headSha256: "0".repeat(64) } });
    expect(
      await readSavedWholeDraft(DRAFT_ID, "user-read-bad-digest", always),
    ).toBeUndefined();

    boundary.request.mockRejectedValue(new Error("offline"));
    expect(
      await readSavedWholeDraft(DRAFT_ID, "user-read-offline", always),
    ).toBeUndefined();
  });
});

async function digest(text: string): Promise<string> {
  return webCryptoSha256Hex(utf8Bytes(text));
}

describe("retireSentWholeDraft", () => {
  const SOURCE_ID = "source-draft";
  const USER = "user-retire";

  function installSource(draftId: string) {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: USER, userName: "U", email: "u@example.com" },
        { userId: USER, username: "U" },
        [],
      );
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useLandingDraftStore.getState().installLandingDraft({
      id: draftId,
      wholeDraftAnnotations: [],
      content: CONTENT,
      selection: null,
      lastTouchedAt: 1,
      settings: null,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: true,
      returnedSandbox: null,
      namedHostId: null,
      durability: "saved",
    });
  }

  it("deletes the captured row on a matching receipt, but a later local edit suppresses the delete", async () => {
    boundary.request.mockResolvedValue({ kind: "deleted", draftId: SOURCE_ID });
    const submission = {
      content: CONTENT,
      settings: PICKED_SETTINGS,
      userId: USER,
    };
    installSource(SOURCE_ID);
    await retireSentWholeDraft(SOURCE_ID, submission);
    expect(boundary.request).toHaveBeenCalledExactlyOnceWith(
      "drafts.mutateWhole",
      { kind: "delete", draftId: SOURCE_ID },
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);

    boundary.request.mockClear();
    const editedId = "edited-draft";
    installSource(editedId);
    useLandingDraftStore.getState().setDraftComposerMode(editedId, "terminal");
    await retireSentWholeDraft(editedId, submission);
    expect(boundary.request).not.toHaveBeenCalled();
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });
});
