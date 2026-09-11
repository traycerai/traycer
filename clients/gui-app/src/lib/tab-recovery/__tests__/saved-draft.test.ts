import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DraftDocument,
  DraftsListResponse,
  DraftsReadBlobRequest,
  DraftsReadBlobResponse,
} from "@traycer/protocol/host";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  LANDING_IMAGE_BUDGET_BYTES,
  resetLandingImageBudgetReservationsForTesting,
  tryReserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import {
  imageHashKeys,
  deleteImage,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import { queryClient } from "@/lib/query-client";
import { prepareSavedDraft } from "@/lib/tab-recovery/saved-draft";
import type {
  ClosedHeaderTab,
  LegacyRecoveryDraft,
} from "@/lib/tab-recovery/history";
import { useTabRecoveryHistory } from "@/lib/tab-recovery/history";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

const HOST_ID = "saved-draft-host";

type ResolveNamedHostClient = (
  binding: null,
  hostId: string,
) => HostClient<HostRpcRegistry> | null;

const mocks = vi.hoisted(() => ({
  resolveNamedHostClient: vi.fn<ResolveNamedHostClient>(),
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    getHostBindingSnapshot: () => null,
  };
});

vi.mock("@/lib/host/binding-host-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/binding-host-client")>();
  return {
    ...actual,
    resolveNamedHostClient: mocks.resolveNamedHostClient,
  };
});

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("saved-draft image keys must be strings");
  }
  return key;
}

vi.mock("idb-keyval", () => ({
  createStore: vi.fn(() => ({})),
  get: vi.fn((key: IDBValidKey) => Promise.resolve(idbData.get(idbKey(key)))),
  set: vi.fn((key: IDBValidKey, value: unknown) => {
    idbData.set(idbKey(key), value);
    return Promise.resolve();
  }),
  del: vi.fn((key: IDBValidKey) => {
    idbData.delete(idbKey(key));
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  entries: vi.fn(() => Promise.resolve(Array.from(idbData.entries()))),
}));

const IMAGE_BYTES = new Uint8Array([1, 2, 3]);

interface HostBehavior {
  readonly list: () => Promise<DraftsListResponse>;
  readonly readBlob: (
    params: DraftsReadBlobRequest,
  ) => Promise<DraftsReadBlobResponse>;
}

interface HostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
}

function createHostFixture(behavior: HostBehavior): HostFixture {
  const hostEntry = { ...mockLocalHostEntry, hostId: HOST_ID };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "saved-draft-request",
    handlers: {
      "drafts.list": behavior.list,
      "drafts.readBlob": behavior.readBlob,
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger,
    findHostById: (hostId) => (hostId === HOST_ID ? hostEntry : null),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "saved-draft-token",
    }),
  );
  return { client: spine.createRequester(hostEntry), messenger };
}

function textDocument(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function imageDocument(hash: string): JsonContent {
  return imageDocumentWithSize(hash, undefined);
}

function imageDocumentWithSize(
  hash: string,
  size: number | undefined,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "image-1",
              fileName: "image.png",
              hash,
              ...(size === undefined ? {} : { size }),
            },
          },
        ],
      },
    ],
  };
}

function sizedImageDocument(hash: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: { id: "capacity-image", fileName: "image.png", hash, size },
          },
        ],
      },
    ],
  };
}

function landingDocument(
  draftId: string,
  content: JsonContent,
  blobHashes: readonly string[],
): Extract<DraftDocument, { kind: "landing" }> {
  return landingDocumentWithClosed(draftId, content, blobHashes, true);
}

function landingDocumentWithClosed(
  draftId: string,
  content: JsonContent,
  blobHashes: readonly string[],
  closed: boolean,
): Extract<DraftDocument, { kind: "landing" }> {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 3,
    lastTouchedAt: 3,
    workspace: null,
    ownerHostId: HOST_ID,
    origin: "own",
    adoption: { state: "adopted", hostId: HOST_ID },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [...blobHashes],
      closed,
    },
  };
}

function listResponse(
  drafts: readonly DraftDocument[],
  tombstones: DraftsListResponse["tombstones"],
): DraftsListResponse {
  return {
    drafts: [...drafts],
    tombstones,
    snapshotSeq: 3,
    scopeId: null,
  };
}

function recoveryItem(
  draftId: string,
  hostId: string | null,
  legacyDraft: LegacyRecoveryDraft | undefined,
): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId,
    hostId,
    ...(legacyDraft === undefined ? {} : { legacyDraft }),
    index: 0,
  };
}

function legacyDraft(
  draftId: string,
  content: JsonContent,
): LegacyRecoveryDraft {
  return {
    id: draftId,
    content,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
  };
}

function localDraft(draftId: string, content: JsonContent): LandingDraftTab {
  return {
    id: draftId,
    content,
    selection: null,
    lastTouchedAt: 10,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
    closed: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

let originalCreateObjectURLDescriptor: PropertyDescriptor | undefined;

describe("prepareSavedDraft", () => {
  beforeEach(async () => {
    for (const hash of await imageHashKeys()) {
      await deleteImage(hash);
      releaseSession(hash);
    }
    idbData.clear();
    queryClient.clear();
    resetLandingImageBudgetReservationsForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabRecoveryHistory.setState({ entries: [], ready: true });
    mocks.resolveNamedHostClient.mockReset();
    originalCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: () => "blob:saved-draft",
      });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:saved-draft");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCreateObjectURLDescriptor === undefined)
      Reflect.deleteProperty(URL, "createObjectURL");
    else
      Object.defineProperty(
        URL,
        "createObjectURL",
        originalCreateObjectURLDescriptor,
      );
    originalCreateObjectURLDescriptor = undefined;
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabRecoveryHistory.setState({ entries: [], ready: true });
    resetLandingImageBudgetReservationsForTesting();
  });

  it("reuses a retained local draft and does not overwrite it with legacy content", async () => {
    const draftId = "retained-draft";
    const currentContent = textDocument("newer local content");
    const oldContent = textDocument("old recovery content");
    useLandingDraftStore.setState({
      drafts: [localDraft(draftId, currentContent)],
      activeDraftId: null,
    });

    const result = await prepareSavedDraft(
      recoveryItem(draftId, null, legacyDraft(draftId, oldContent)),
      () => true,
    );

    expect(result).toBe(true);
    expect(useLandingDraftStore.getState().drafts[0]?.content).toEqual(
      currentContent,
    );
  });

  it("imports a legacy draft and materializes inline image bytes", async () => {
    const draftId = "legacy-draft";
    const inlineContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "inline-image",
                fileName: "paste.png",
                b64content: bytesToBase64(IMAGE_BYTES),
              },
            },
          ],
        },
      ],
    };
    const expectedHash = await sha256Hex(IMAGE_BYTES);

    const result = await prepareSavedDraft(
      recoveryItem(draftId, null, legacyDraft(draftId, inlineContent)),
      () => true,
    );

    expect(result).toBe(true);
    const restored = useLandingDraftStore.getState().drafts[0];
    expect(restored.content).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "inline-image",
                fileName: "paste.png",
                hash: expectedHash,
                size: IMAGE_BYTES.byteLength,
              },
            },
          ],
        },
      ],
    });
    expect(restored.adoption).toEqual({ state: "unadopted" });
  });

  it("rejects an oversized legacy image without writing or evicting its history", async () => {
    const capacityDraftId = "capacity-draft";
    const capacityHash = "f".repeat(64);
    useLandingDraftStore.setState({
      drafts: [
        localDraft(
          capacityDraftId,
          sizedImageDocument(capacityHash, LANDING_IMAGE_BUDGET_BYTES),
        ),
      ],
      activeDraftId: null,
    });
    const item = recoveryItem(
      "oversized-legacy-draft",
      null,
      legacyDraft("oversized-legacy-draft", {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "oversized-inline-image",
                  fileName: "too-large.png",
                  b64content: bytesToBase64(IMAGE_BYTES),
                },
              },
            ],
          },
        ],
      }),
    );
    useTabRecoveryHistory.setState({
      ready: true,
      entries: [
        {
          kind: "header",
          id: "oversized-history-entry",
          items: [item],
          bulk: false,
        },
      ],
    });

    await expect(prepareSavedDraft(item, () => true)).rejects.toThrow(
      "not enough image capacity",
    );

    expect(idbData.size).toBe(0);
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual([capacityDraftId]);
    expect(useTabRecoveryHistory.getState().entries).toEqual([
      {
        kind: "header",
        id: "oversized-history-entry",
        items: [item],
        bulk: false,
      },
    ]);
  });

  it("decodes a legacy image batch atomically before any write or history change", async () => {
    const item = recoveryItem(
      "invalid-legacy-batch",
      null,
      legacyDraft("invalid-legacy-batch", {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "valid-inline-image",
                  fileName: "valid.png",
                  b64content: bytesToBase64(IMAGE_BYTES),
                },
              },
              {
                type: "imageAttachment",
                attrs: {
                  id: "invalid-inline-image",
                  fileName: "invalid.png",
                  b64content: "%%%invalid-base64%%%",
                },
              },
            ],
          },
        ],
      }),
    );
    useTabRecoveryHistory.setState({
      ready: true,
      entries: [
        {
          kind: "header",
          id: "invalid-history-entry",
          items: [item],
          bulk: false,
        },
      ],
    });

    await expect(prepareSavedDraft(item, () => true)).rejects.toThrow(
      "could not be decoded",
    );

    expect(idbData.size).toBe(0);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useTabRecoveryHistory.getState().entries).toEqual([
      {
        kind: "header",
        id: "invalid-history-entry",
        items: [item],
        bulk: false,
      },
    ]);
  });

  it("returns false for an unadopted recovery item with no local row", async () => {
    const result = await prepareSavedDraft(
      recoveryItem("missing-local-draft", null, undefined),
      () => true,
    );

    expect(result).toBe(false);
    expect(mocks.resolveNamedHostClient).not.toHaveBeenCalled();
  });

  it("returns false when the named host has an authoritative absence", async () => {
    const fixture = createHostFixture({
      list: () =>
        Promise.resolve(
          listResponse([], [{ draftId: "deleted-draft", revision: 4 }]),
        ),
      readBlob: () => Promise.reject(new Error("unexpected blob read")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    const result = await prepareSavedDraft(
      recoveryItem("deleted-draft", HOST_ID, undefined),
      () => true,
    );

    expect(result).toBe(false);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("loads an adopted mirror and its image bytes from the named owner host", async () => {
    const draftId = "remote-draft";
    const hash = await sha256Hex(IMAGE_BYTES);
    const document = landingDocument(draftId, imageDocument(hash), [hash]);
    const fixture = createHostFixture({
      list: () => Promise.resolve(listResponse([document], [])),
      readBlob: (params) => {
        expect(params.sha256).toBe(hash);
        return Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(IMAGE_BYTES),
        });
      },
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    const result = await prepareSavedDraft(
      recoveryItem(draftId, HOST_ID, undefined),
      () => true,
    );

    expect(result).toBe(true);
    expect(mocks.resolveNamedHostClient).toHaveBeenCalledWith(null, HOST_ID);
    expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
      "drafts.list",
      "drafts.readBlob",
    ]);
    const restored = useLandingDraftStore.getState().drafts[0];
    expect(restored.content).toEqual(
      imageDocumentWithSize(hash, IMAGE_BYTES.byteLength),
    );
    expect(restored.confirmedHostBlobHashes).toEqual([hash]);
  });

  it("installs a closed local mirror when the host record is open", async () => {
    const draftId = "host-open-draft";
    const document = landingDocumentWithClosed(
      draftId,
      textDocument("host content"),
      [],
      false,
    );
    const fixture = createHostFixture({
      list: () => Promise.resolve(listResponse([document], [])),
      readBlob: () => Promise.reject(new Error("unexpected blob read")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    await expect(
      prepareSavedDraft(recoveryItem(draftId, HOST_ID, undefined), () => true),
    ).resolves.toBe(true);

    const restored = useLandingDraftStore.getState().drafts[0];
    expect(restored.content).toEqual(document.portable.content);
    expect(restored.closed).toBe(true);
  });

  it("rejects a host image at capacity before writing bytes or importing history", async () => {
    const outstandingReservation = tryReserveLandingImageBudget([
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES - 2 },
    ]);
    if (outstandingReservation === null)
      throw new Error("expected the capacity reservation to succeed");
    const draftId = "host-over-capacity";
    const hash = await sha256Hex(IMAGE_BYTES);
    const document = landingDocumentWithClosed(
      draftId,
      imageDocumentWithSize(hash, 0),
      [hash],
      false,
    );
    const item = recoveryItem(draftId, HOST_ID, undefined);
    useTabRecoveryHistory.setState({
      entries: [
        {
          kind: "header",
          id: "host-capacity-history",
          items: [item],
          bulk: false,
        },
      ],
      ready: true,
    });
    const historyBefore = useTabRecoveryHistory.getState().entries;
    const fixture = createHostFixture({
      list: () => Promise.resolve(listResponse([document], [])),
      readBlob: () =>
        Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(IMAGE_BYTES),
        }),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    try {
      await expect(prepareSavedDraft(item, () => true)).rejects.toThrow(
        "not enough image capacity",
      );

      expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
        "drafts.list",
        "drafts.readBlob",
      ]);
      expect(idbData.size).toBe(0);
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
      expect(useTabRecoveryHistory.getState().entries).toEqual(historyBefore);
    } finally {
      outstandingReservation.release();
    }
  });

  it("counts actual host bytes, normalizes image size, and releases its reservation", async () => {
    const draftId = "host-sized-image";
    const hash = await sha256Hex(IMAGE_BYTES);
    const document = landingDocumentWithClosed(
      draftId,
      imageDocumentWithSize(hash, 0),
      [hash],
      false,
    );
    const fixture = createHostFixture({
      list: () => Promise.resolve(listResponse([document], [])),
      readBlob: () =>
        Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(IMAGE_BYTES),
        }),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    await expect(
      prepareSavedDraft(recoveryItem(draftId, HOST_ID, undefined), () => true),
    ).resolves.toBe(true);

    const restored = useLandingDraftStore.getState().drafts[0];
    expect(restored.content).toEqual(imageDocumentWithSize(hash, 3));
    expect(restored.closed).toBe(true);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    const reservation = tryReserveLandingImageBudget([
      { hash: null, bytes: LANDING_IMAGE_BUDGET_BYTES },
    ]);
    if (reservation === null)
      throw new Error("expected the host image reservation to be released");
    reservation.release();
  });

  it("keeps a local draft opened while the host mirror is being read", async () => {
    const draftId = "concurrent-local-draft";
    const list = deferred<DraftsListResponse>();
    const document = landingDocument(draftId, textDocument("host content"), []);
    const fixture = createHostFixture({
      list: () => list.promise,
      readBlob: () => Promise.reject(new Error("unexpected blob read")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    const pending = prepareSavedDraft(
      recoveryItem(draftId, HOST_ID, undefined),
      () => true,
    );
    await vi.waitFor(() => {
      expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
        "drafts.list",
      ]);
    });
    const localContent = textDocument("concurrent local content");
    useLandingDraftStore.setState({
      drafts: [localDraft(draftId, localContent)],
      activeDraftId: draftId,
    });
    list.resolve(listResponse([document], []));

    await expect(pending).resolves.toBe(true);
    const retained = useLandingDraftStore.getState().drafts[0];
    expect(retained.content).toEqual(localContent);
    expect(retained.closed).toBe(false);
  });

  it("propagates a temporary host list failure", async () => {
    const error = new Error("temporary host transport failure");
    const fixture = createHostFixture({
      list: () => Promise.reject(error),
      readBlob: () => Promise.reject(new Error("unexpected blob read")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    await expect(
      prepareSavedDraft(
        recoveryItem("rpc-failure", HOST_ID, undefined),
        () => true,
      ),
    ).rejects.toThrow("temporary host transport failure");
  });

  it("throws when a listed image cannot be fetched", async () => {
    const draftId = "image-failure";
    const hash = await sha256Hex(IMAGE_BYTES);
    const fixture = createHostFixture({
      list: () =>
        Promise.resolve(
          listResponse(
            [landingDocument(draftId, imageDocument(hash), [hash])],
            [],
          ),
        ),
      readBlob: () => Promise.reject(new Error("temporary image failure")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);

    await expect(
      prepareSavedDraft(recoveryItem(draftId, HOST_ID, undefined), () => true),
    ).rejects.toThrow("The draft's images are not available yet.");
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("does not resurrect a draft when it becomes stale while drafts.list is pending", async () => {
    const draftId = "deleted-while-listing";
    const list = deferred<DraftsListResponse>();
    const fixture = createHostFixture({
      list: () => list.promise,
      readBlob: () => Promise.reject(new Error("unexpected blob read")),
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);
    let current = true;

    const pending = prepareSavedDraft(
      recoveryItem(draftId, HOST_ID, undefined),
      () => current,
    );
    await vi.waitFor(() => {
      expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
        "drafts.list",
      ]);
    });
    current = false;
    list.resolve(
      listResponse([landingDocument(draftId, textDocument("stale"), [])], []),
    );

    await expect(pending).resolves.toBe(false);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("does not resurrect a draft when it becomes stale while its image is pending", async () => {
    const draftId = "account-changed-while-reading-image";
    const hash = await sha256Hex(IMAGE_BYTES);
    const imageRead = deferred<DraftsReadBlobResponse>();
    const document = landingDocument(draftId, imageDocument(hash), [hash]);
    const fixture = createHostFixture({
      list: () => Promise.resolve(listResponse([document], [])),
      readBlob: () => imageRead.promise,
    });
    mocks.resolveNamedHostClient.mockReturnValue(fixture.client);
    let current = true;

    const pending = prepareSavedDraft(
      recoveryItem(draftId, HOST_ID, undefined),
      () => current,
    );
    await vi.waitFor(() => {
      expect(fixture.messenger.calls.map((call) => call.method)).toEqual([
        "drafts.list",
        "drafts.readBlob",
      ]);
    });
    current = false;
    imageRead.resolve({ ok: true, bytesBase64: bytesToBase64(IMAGE_BYTES) });

    await expect(pending).resolves.toBe(false);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });
});
