import { bytesToBase64 } from "@/lib/composer/image-base64";
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import {
  deleteImageBytesUnchecked,
  getImageBytes,
  imageHashKeys,
  putImageBytesAtHash,
  releaseSession,
  sha256Hex,
} from "@/lib/composer/landing-image-store";
import {
  markLandingDraftsAuthoritativeNonEmpty,
  markLandingDraftsReady,
  reconcile,
} from "@/lib/composer/landing-image-gc";
import {
  acquireDraftMirrorSession,
  bindComposerDraftHost,
  captureLocalOrdinaryDraft,
  createOrdinaryDraftReadSink,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { withDraftTestRequestMethods } from "@/lib/drafts/__tests__/draft-test-request-methods";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import type { OrdinaryComposerDraftWrite } from "@/lib/drafts/draft-write-codec";
import {
  readOrdinaryDraftPartition,
  readRootedOrdinaryDraftBytes,
  resolveOrdinaryDraftScope,
} from "@/lib/drafts/ordinary-draft-db";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { isRecord } from "@/lib/editor/prosemirror-json";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import {
  draftCloudDocumentSchema,
  draftsReadBlobRequestSchema,
  draftWriteSchema,
  type DraftCloudDocument,
} from "@traycer/protocol/host/drafts";
import type { DraftsSubscribeServerFrameV11 } from "@traycer/protocol/host";
import {
  browserAnnotationRecordSchema,
  canvasAnnotationRecordSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerCanvasAnnotationsKey,
  STORE_KEYS,
  persistKey,
} from "@/lib/persist";
import { loadWindowOrdinaryDraftScope } from "@/stores/composer/composer-canvas-persistence";
import {
  bindOrdinaryDraftRecoveryScope,
  EMPTY_COMPOSER_DRAFT,
  readReleasedComposerDrafts,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { useNewConversationAnnotationStore } from "@/stores/epics/new-conversation-annotation-store";
import {
  useNewConversationModalStore,
  readReleasedModalDrafts,
  type NewConversationModalDraftPatch,
} from "@/stores/epics/new-conversation-modal-store";
import {
  LANDING_DRAFT_PERSIST_KEY,
  readReleasedLandingDrafts,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import type { VersionedHostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "released-differential-host";
const OWNER_ID = "released-differential-owner";
const EPIC_ID = "released-differential-epic";
const CHAT_ID = "released-differential-chat";
const CHAT_DRAFT_ID = "released-differential-chat-draft";
const MODAL_DRAFT_ID = "released-differential-modal-draft";
const LANDING_DRAFT_ID = "released-differential-landing-draft";
const OVERLAY_SCOPE = "scp_released_overlay_diff_0001";
const EMPTY_SCOPE = "scp_released_overlay_empty_0001";
const COMPOSER_KEY = "traycer-gui-app:composer-drafts";
const MODAL_KEY = persistKey(STORE_KEYS.newConversationDraft);
const LANDING_KEY = LANDING_DRAFT_PERSIST_KEY;
const EMPTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

interface PersistedSnapshot {
  readonly composer: string | null;
  readonly canvas: string | null;
  readonly modal: string | null;
  readonly landing: string | null;
}

interface TraceCheckpoint {
  readonly persisted: PersistedSnapshot;
  readonly roots: readonly string[];
}

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function imageContent(text: string, hash: string, size: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text },
          {
            type: "imageAttachment",
            attrs: {
              id: `image-${hash.slice(0, 8)}`,
              fileName: "released.png",
              mimeType: "image/png",
              size,
              byHashEligible: true,
              b64content: null,
              hash,
            },
          },
        ],
      },
    ],
  };
}

function canvasCrop(imageHash: string): BrowserAnnotationRecord {
  return canvasAnnotationRecordSchema.parse({
    kind: "browser-annotation",
    annotationId: "released-canvas-crop",
    source: {
      kind: "canvas",
      artifactId: "released-canvas-artifact",
      boardPath: "boards/released.html",
      canvasPage: null,
      artifactTitle: "Canvas",
    },
    capturedAt: 1,
    comment: "Canvas crop",
    counts: { elements: 0, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: "canvas-crop.png",
    imageHash,
    droppedElementCount: 0,
  });
}

function modalCrop(imageHash: string): BrowserAnnotationRecord {
  return browserAnnotationRecordSchema.parse({
    kind: "browser-annotation",
    annotationId: "released-modal-crop",
    tabId: "released-modal-tab",
    sessionId: "released-modal-session",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    capturedAt: 1,
    comment: "Modal crop",
    counts: { elements: 0, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: "modal-crop.png",
    imageHash,
    droppedElementCount: 0,
  });
}

function cloudEntry(
  write: OrdinaryComposerDraftWrite,
  operationId: string,
): DraftCloudDocument {
  return draftCloudDocumentSchema.parse({
    draftId: write.draftId,
    base: {
      headSha256: "a".repeat(64),
      ownerEpoch: 1,
      revision: 1,
    },
    operationId,
    head: {
      dialect: "draft/v1",
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: write.kind,
      lastTouchedAt: write.lastTouchedAt,
      target: write.target,
      hostLocal: { hostId: HOST_ID, workspace: write.workspace },
      portable: write.portable,
    },
  });
}

function documentFromWrite(write: DraftWrite, revision: number): DraftDocument {
  if (
    write.kind !== "chat-composer" &&
    write.kind !== "new-chat" &&
    write.kind !== "landing"
  ) {
    throw new Error("expected a composer draft write");
  }
  return {
    ...write,
    revision,
    ownerHostId: HOST_ID,
    origin: "own",
    adoption: { state: "adopted", hostId: HOST_ID },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
  };
}

function documentFromCloudEntry(
  entry: DraftCloudDocument,
  revision: number,
  text: string,
): DraftDocument {
  const portable = entry.head.portable;
  const kind = entry.head.surfaceKind;
  const write = draftWriteSchema.parse({
    draftId: entry.draftId,
    kind,
    target: entry.head.target,
    revision,
    lastTouchedAt: entry.head.lastTouchedAt + revision,
    workspace: entry.head.hostLocal.workspace,
    supersedes: null,
    portable: {
      selection: portable.selection,
      runSettings: portable.runSettings,
      composerMode: portable.composerMode,
      closed: portable.closed,
      content:
        imageHashes(entry.head.portable.content).length === 0
          ? textContent(text)
          : replaceText(entry.head.portable.content, text),
      blobHashes: imageHashes(entry.head.portable.content),
    },
  });
  return documentFromWrite(write, revision);
}

function imageHashes(content: JsonContent): string[] {
  if (content.type === "imageAttachment") {
    const hash = content.attrs?.hash;
    return typeof hash === "string" ? [hash] : [];
  }
  const nested = content.content?.flatMap(imageHashes) ?? [];
  return [...new Set(nested)];
}

function replaceText(content: JsonContent, text: string): JsonContent {
  if (content.type === "text") return { ...content, text };
  if (content.content === undefined) return content;
  let replaced = false;
  return {
    ...content,
    content: content.content.map((child) => {
      if (!replaced && child.type === "text") {
        replaced = true;
        return { ...child, text };
      }
      return replaceText(child, text);
    }),
  };
}

function streamHarness(): {
  readonly client: never;
  readonly emit: (frame: DraftsSubscribeServerFrameV11) => void;
  readonly ready: Promise<void>;
} {
  let onFrame: ServerFrameHandler | null = null;
  const ready = Promise.withResolvers<void>();
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: (handler) => {
      onFrame = handler;
      ready.resolve();
    },
    onStatusChange: () => undefined,
    hasSentOpenRequest: () => false,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    client: {
      subscribeAtVersion: () => session,
    } as never,
    ready: ready.promise,
    emit: (frame) => onFrame?.(frame, null),
  };
}

function persistedBytes(): PersistedSnapshot {
  return {
    composer: window.localStorage.getItem(COMPOSER_KEY),
    canvas: window.sessionStorage.getItem(
      composerCanvasAnnotationsKey("session"),
    ),
    modal: window.localStorage.getItem(MODAL_KEY),
    landing: window.localStorage.getItem(LANDING_KEY),
  };
}

function imageRoots(): string[] {
  return [...landingLiveImageRootHashes()].sort();
}

function hostRequester(
  images: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  listed: readonly DraftDocument[],
): VersionedHostRequester<HostRpcRegistry> {
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (method === "drafts.list") {
      return Promise.resolve({
        drafts: listed,
        tombstones: [],
        snapshotSeq: 0,
        scopeId: null,
      });
    }
    if (method === "drafts.upsert") {
      if (typeof params !== "object" || params === null)
        return Promise.reject(new Error("draft upsert params were invalid"));
      const parsed = draftWriteSchema.safeParse(Reflect.get(params, "draft"));
      if (!parsed.success)
        return Promise.reject(new Error("draft upsert payload was invalid"));
      return Promise.resolve({ draft: documentFromWrite(parsed.data, 1) });
    }
    if (method === "drafts.delete") return Promise.resolve({ deleted: true });
    return Promise.reject(new Error(`unexpected drafts RPC ${method}`));
  };
  const requestWithOptions = (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const blobParams = draftsReadBlobRequestSchema.safeParse(params);
    const hash = blobParams.success ? blobParams.data.sha256 : null;
    if (method === "drafts.readBlob" && hash !== null) {
      const bytes = images.get(hash);
      if (bytes === undefined)
        return Promise.resolve({ ok: false, reason: "missing" });
      return Promise.resolve({ ok: true, bytesBase64: bytesToBase64(bytes) });
    }
    if (method === "drafts.putBlob") return Promise.resolve({ ok: true });
    return Promise.reject(new Error(`unexpected blob RPC ${method}`));
  };
  return withDraftTestRequestMethods({ request, requestWithOptions }) as never;
}

async function installOverlay(
  scopeId: string,
  entries: ReadonlyArray<DraftCloudDocument>,
  client: DraftBlobClient,
): Promise<string> {
  const sink = createOrdinaryDraftReadSink(client);
  await loadWindowOrdinaryDraftScope(OWNER_ID, scopeId);
  expect(bindOrdinaryDraftRecoveryScope(scopeId)).toBe(true);
  for (const entry of entries) {
    const prepared = await sink.prepare(
      scopeId,
      entry,
      new AbortController().signal,
    );
    expect(prepared).not.toBeNull();
    if (prepared === null)
      throw new Error("ordinary overlay row was not prepared");
    await prepared.commit();
    await prepared.release();
  }
  const scope = await resolveOrdinaryDraftScope(OWNER_ID, scopeId);
  if (scope === null)
    throw new Error("ordinary overlay scope was not persisted");
  return scope.partition;
}

async function switchToEmptyOverlay(): Promise<void> {
  await loadWindowOrdinaryDraftScope(OWNER_ID, EMPTY_SCOPE);
  expect(bindOrdinaryDraftRecoveryScope(EMPTY_SCOPE)).toBe(true);
}

function resetStores(): void {
  resetDraftMirrorCoordinatorForTests();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER_ID, username: "released-differential" },
  });
  useComposerDraftStore.setState({
    drafts: {},
    ordinaryRecoveryDrafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationAnnotationStore.setState({
    byEpicId: {},
    dirtyByEpicId: {},
  });
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
    resumeDraftId: null,
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
}

async function seedImage(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await sha256Hex(bytes);
  await putImageBytesAtHash(hash, bytes);
  releaseSession(hash);
  return hash;
}

function assertFourHashes(
  hashes: readonly string[],
): asserts hashes is readonly [string, string, string, string] {
  if (hashes.length !== 4)
    throw new Error("the image fixtures were incomplete");
}

function makeRows(images: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): {
  readonly entries: readonly DraftCloudDocument[];
  readonly hashes: readonly string[];
} {
  const hashes = [...images.keys()];
  assertFourHashes(hashes);
  const [chatHash, canvasHash, modalHash, landingHash] = hashes;
  const chatAnnotations = [canvasCrop(canvasHash)];
  useComposerDraftStore.setState({
    drafts: {
      [CHAT_ID]: {
        ...EMPTY_COMPOSER_DRAFT,
        content: imageContent(
          "released chat",
          chatHash,
          images.get(chatHash)?.byteLength ?? 0,
        ),
        browserAnnotations: chatAnnotations,
        resetEpoch: 7,
        revision: 2,
        draftId: CHAT_DRAFT_ID,
        targetEpicId: EPIC_ID,
        lastTouchedAt: 10,
        generation: 0,
        syncedGeneration: 0,
      },
    },
    ordinaryRecoveryDrafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  bindComposerDraftHost(CHAT_ID, HOST_ID);

  const modalPatch: NewConversationModalDraftPatch = {
    content: imageContent(
      "released modal",
      modalHash,
      images.get(modalHash)?.byteLength ?? 0,
    ),
    selection: null,
    settings: null,
    composerMode: "chat",
    workspace: null,
    revision: 2,
    draftId: MODAL_DRAFT_ID,
    hostRevision: 0,
    lastTouchedAt: 10,
    generation: 0,
    syncedGeneration: 0,
    epicTitle: null,
    ownerHostId: null,
  };
  useNewConversationModalStore.setState({
    draftPatchesByEpicId: { [EPIC_ID]: modalPatch },
  });
  useNewConversationAnnotationStore.setState({
    byEpicId: { [EPIC_ID]: [modalCrop(modalHash)] },
    dirtyByEpicId: {},
  });

  useLandingDraftStore.getState().createDraftWithId(LANDING_DRAFT_ID, null);
  useLandingDraftStore
    .getState()
    .setDraftContent(
      LANDING_DRAFT_ID,
      imageContent(
        "released landing",
        landingHash,
        images.get(landingHash)?.byteLength ?? 0,
      ),
      null,
    );
  useLandingDraftStore.setState((state) => ({
    drafts: state.drafts.map((draft) =>
      draft.id === LANDING_DRAFT_ID
        ? { ...draft, generation: 0, syncedGeneration: 0, lastTouchedAt: 10 }
        : draft,
    ),
  }));

  const entries = [CHAT_DRAFT_ID, MODAL_DRAFT_ID, LANDING_DRAFT_ID].map(
    (draftId) => {
      const local = captureLocalOrdinaryDraft(draftId);
      if (local === null)
        throw new Error(`released draft ${draftId} was not capturable`);
      return cloudEntry(local.write, `overlay-${draftId}`);
    },
  );
  return { entries, hashes: [chatHash, canvasHash, modalHash, landingHash] };
}

async function runTrace(overlay: boolean): Promise<{
  readonly checkpoints: ReadonlyArray<TraceCheckpoint>;
  readonly finalPersisted: PersistedSnapshot;
  readonly finalRoots: readonly string[];
  readonly finalImageKeys: readonly string[];
  readonly finalImageBytes: ReadonlyArray<
    readonly [string, readonly number[] | null]
  >;
  readonly overlayBytes: ReadonlyArray<readonly [string, readonly number[]]>;
}> {
  resetStores();
  const sourceBytes = [32, 36, 40, 44].map((size) => pngBytesOfSize(size));
  const hashes = await Promise.all(sourceBytes.map(seedImage));
  const images = new Map(
    hashes.map((hash, index) => [hash, sourceBytes[index]]),
  );
  const rows = makeRows(images);
  const listed = rows.entries.map((entry) =>
    documentFromCloudEntry(entry, 1, `released ${entry.draftId}`),
  );
  const requester = hostRequester(images, listed);
  const stream = streamHarness();
  acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: requester,
    streamClient: stream.client,
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
  await stream.ready;

  await vi.waitFor(() => {
    expect(readReleasedComposerDrafts()[CHAT_ID]?.hostRevision).toBe(1);
    expect(readReleasedModalDrafts()[EPIC_ID]?.hostRevision).toBe(1);
    expect(
      readReleasedLandingDrafts().find((draft) => draft.id === LANDING_DRAFT_ID)
        ?.hostRevision,
    ).toBe(1);
  });

  let ordinaryPartition: string | null = null;
  if (overlay) {
    ordinaryPartition = await installOverlay(
      OVERLAY_SCOPE,
      rows.entries,
      requester,
    );
  }
  const checkpoints: TraceCheckpoint[] = [];
  checkpoints.push({ persisted: persistedBytes(), roots: imageRoots() });

  if (overlay) {
    await switchToEmptyOverlay();
    await installOverlay(OVERLAY_SCOPE, rows.entries, requester);
  }

  let sequence = 1;
  for (const entry of rows.entries) {
    const text = `updated ${entry.draftId}`;
    const document = documentFromCloudEntry(entry, 2, text);
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: sequence,
      draftId: entry.draftId,
      revision: document.revision,
      draft: document,
    });
    sequence += 1;
    await vi.waitFor(() => {
      if (entry.draftId === CHAT_DRAFT_ID) {
        const draft = readReleasedComposerDrafts()[CHAT_ID];
        expect(draft?.hostRevision).toBe(2);
        expect(draft?.content).toEqual(
          imageContent(text, hashes[0], sourceBytes[0].byteLength),
        );
      } else if (entry.draftId === MODAL_DRAFT_ID) {
        const patch = readReleasedModalDrafts()[EPIC_ID];
        expect(patch?.hostRevision).toBe(2);
        expect(patch?.content).toEqual(
          imageContent(text, hashes[2], sourceBytes[2].byteLength),
        );
        expect(
          useNewConversationAnnotationStore.getState().byEpicId[EPIC_ID],
        ).toEqual([modalCrop(hashes[2])]);
      } else {
        const draft = readReleasedLandingDrafts().find(
          (row) => row.id === LANDING_DRAFT_ID,
        );
        expect(draft?.hostRevision).toBe(2);
        expect(draft?.content).toEqual(
          imageContent(text, hashes[3], sourceBytes[3].byteLength),
        );
      }
    });
  }
  checkpoints.push({ persisted: persistedBytes(), roots: imageRoots() });

  for (const entry of rows.entries) {
    stream.emit({
      kind: "delete",
      hasBinaryPayload: false,
      storeSeq: sequence,
      draftId: entry.draftId,
      revision: 3,
    });
    sequence += 1;
    await vi.waitFor(() => {
      if (entry.draftId === CHAT_DRAFT_ID) {
        expect(readReleasedComposerDrafts()[CHAT_ID]?.content).toEqual(
          EMPTY_CONTENT,
        );
      } else if (entry.draftId === MODAL_DRAFT_ID) {
        expect(readReleasedModalDrafts()[EPIC_ID]).toBeUndefined();
      } else {
        expect(
          readReleasedLandingDrafts().some(
            (draft) => draft.id === LANDING_DRAFT_ID,
          ),
        ).toBe(false);
      }
    });
  }
  if (overlay) await switchToEmptyOverlay();
  checkpoints.push({ persisted: persistedBytes(), roots: imageRoots() });

  for (const hash of rows.hashes) releaseSession(hash);
  markLandingDraftsReady();
  markLandingDraftsAuthoritativeNonEmpty();
  await reconcile();
  const finalImageKeys = (await imageHashKeys()).sort();
  const finalImageBytes = await Promise.all(
    rows.hashes.map(async (hash) => {
      const bytes = await getImageBytes(hash);
      return [hash, bytes === undefined ? null : [...bytes]] as const;
    }),
  );
  const finalRoots = imageRoots();
  let overlayBytes: Array<readonly [string, readonly number[]]> = [];
  const overlayPartition = ordinaryPartition;
  if (overlayPartition !== null) {
    const partition = await readOrdinaryDraftPartition(overlayPartition);
    const rootedHashes = partition.rows.flatMap((row) => row.roots);
    overlayBytes = await Promise.all(
      rootedHashes.map(async (hash) => {
        const bytes = await readRootedOrdinaryDraftBytes(
          overlayPartition,
          hash,
        );
        if (bytes === undefined)
          throw new Error(`ordinary overlay bytes missing for ${hash}`);
        return [hash, [...bytes]] as const;
      }),
    );
    overlayBytes.sort(([left], [right]) => left.localeCompare(right));
  }
  releaseDraftMirrorSession(HOST_ID);
  resetDraftMirrorCoordinatorForTests();
  return {
    checkpoints,
    finalPersisted: persistedBytes(),
    finalRoots,
    finalImageKeys,
    finalImageBytes,
    overlayBytes,
  };
}

afterEach(async () => {
  resetDraftMirrorCoordinatorForTests();
  useComposerDraftStore.setState({
    drafts: {},
    ordinaryRecoveryDrafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationAnnotationStore.setState({
    byEpicId: {},
    dirtyByEpicId: {},
  });
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
    resumeDraftId: null,
  });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const hash of await imageHashKeys()) {
    releaseSession(hash);
    await deleteImageBytesUnchecked(hash);
  }
  vi.restoreAllMocks();
});

describe("released draft sync with ordinary overlays", () => {
  it("keeps sync frames, persisted bytes, and image roots equal across overlay scope changes", async () => {
    installFreshIndexedDb();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const bytes = [32, 36, 40, 44].map((size) => pngBytesOfSize(size));
    const hashes = await Promise.all(bytes.map(sha256Hex));
    const imageMap = new Map(hashes.map((hash, index) => [hash, bytes[index]]));

    const released = await runTrace(false);
    for (const [hash] of released.finalImageBytes) {
      releaseSession(hash);
      await deleteImageBytesUnchecked(hash);
    }
    const overlaid = await runTrace(true);

    expect(overlaid.checkpoints.map(({ persisted }) => persisted)).toEqual(
      released.checkpoints.map(({ persisted }) => persisted),
    );
    expect(overlaid.checkpoints.map(({ roots }) => roots)).toEqual(
      released.checkpoints.map(({ roots }) => roots),
    );
    expect(overlaid.checkpoints[0]?.roots).toEqual([...hashes].sort());
    expect(overlaid.checkpoints[1]?.roots).toEqual([...hashes].sort());
    expect(overlaid.finalPersisted).toEqual(released.finalPersisted);
    expect(overlaid.finalRoots).toEqual(released.finalRoots);
    expect(overlaid.finalImageKeys).toEqual(released.finalImageKeys);
    expect(overlaid.finalImageBytes).toEqual(released.finalImageBytes);
    expect(overlaid.finalRoots).toEqual([hashes[1]]);
    expect(
      storedChatResetEpochFromSnapshot(
        overlaid.checkpoints[0]?.persisted.composer,
      ),
    ).toBe(
      storedChatResetEpochFromSnapshot(
        released.checkpoints[0]?.persisted.composer,
      ),
    );
    expect(overlaid.overlayBytes).toEqual(imageMapEntries(imageMap));
  });
});

function storedChatResetEpochFromSnapshot(
  raw: string | null | undefined,
): number {
  if (raw === null || raw === undefined)
    throw new Error("persisted chat bytes were missing");
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.state) ||
    !isRecord(parsed.state.drafts)
  )
    throw new Error("unexpected composer storage");
  const draft = parsed.state.drafts[CHAT_ID];
  if (!isRecord(draft)) throw new Error("stored released chat row was missing");
  const epoch = draft.resetEpoch;
  if (typeof epoch !== "number")
    throw new Error("stored released epoch was missing");
  return epoch;
}

function imageMapEntries(
  images: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): readonly (readonly [string, readonly number[]])[] {
  return [...images.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, bytes]) => [hash, [...bytes]] as const);
}
