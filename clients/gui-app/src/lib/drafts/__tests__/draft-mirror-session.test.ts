import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { appLogger } from "@/lib/logger";
import * as ordinaryDraftScope from "@/lib/drafts/ordinary-draft-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  DraftCloudDocument,
  DraftCloudTombstone,
  DraftDocument,
  DraftWrite,
  DraftsListResponse,
  DraftsListResponseV30,
  DraftsSubscribeOpenRequestV20,
  DraftsSubscribeServerFrameV20,
  DraftsSubscribeServerFrameV11,
} from "@traycer/protocol/host";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { draftCloudDocumentSchema } from "@traycer/protocol/host/drafts";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { browserAnnotationRecordSchema } from "@traycer/protocol/persistence/epic/schemas";
import {
  DraftMirrorSession,
  OrdinaryDraftReadFeed,
  currentOrdinaryDraftEditingBase,
  attachOrdinaryDraftPeer as attachOrdinaryDraftPeerSession,
  placeOrdinaryDraft,
  type OrdinaryDraftReadPort,
  type OrdinaryDraftReadSink,
  type OrdinaryDraftHeadEvidence,
  type OrdinaryDraftPeer,
  type OrdinaryDraftSnapshot,
  type OrdinaryDraftUpsert,
  type PlacedOrdinaryDraft,
  type DraftDeleteOutcome,
  type DraftDirtyWrite,
  type DraftMirrorSink,
  type DraftsHostRpc,
  type DraftsStreamSubscribe,
  type PendingHostDelete,
} from "@/lib/drafts/draft-mirror-session";
import {
  attachOrdinaryDraftPeer,
  captureOrdinaryDraftSnapshot,
  createOrdinaryDraftReadSink,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  bindOrdinaryDraftRecoveryScope,
  applyComposerHostDelete,
  applyComposerHostDocument,
  composerDraftIsDirty,
  dropComposerAbsentFromList,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  adoptUnadoptedLandingDraftsForHost,
  bindLandingAdoptionHost,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  composerDraftWrite,
  landingTarget,
} from "@/lib/drafts/draft-write-codec";
import type { OrdinaryComposerDraftWrite } from "@/lib/drafts/draft-write-codec";
import {
  collectLandingDirtyWrites,
  landingDraftIsDirty,
  landingDraftRememberSynced,
  rememberLandingBlobsOnHost,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";
import {
  hostWithholdsDraftBlobs,
  isDraftBlobConfirmed,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { putImage, sha256Hex } from "@/lib/composer/landing-image-store";
import {
  ORDINARY_DRAFT_DB_NAME,
  stageOrdinaryDraftBytes,
  readRootedOrdinaryDraftBytes,
  readOrdinaryDraftBytes,
  readOrdinaryDraftPartition,
  resolveOrdinaryDraftScope,
} from "@/lib/drafts/ordinary-draft-db";
import {
  loadWindowOrdinaryDraftScope,
  readWindowOrdinaryDraftScope,
  currentOrdinaryDraftScopeBinding,
  showCommittedOrdinaryDraftRows,
  waitForOrdinaryDraftEditorWrite,
} from "@/stores/composer/composer-canvas-persistence";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { useAuthStore } from "@/stores/auth/auth-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  settleNewConversationAnnotations,
  useNewConversationAnnotationStore,
} from "@/stores/epics/new-conversation-annotation-store";
import {
  newChatDraftRememberSynced,
  useNewConversationModalStore,
} from "@/stores/epics/new-conversation-modal-store";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

const HOST_ID = "host-1";
const SCOPE_ID = "scp_testdraftsscopeid000001";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

type OrdinaryFeedFrame = DraftsSubscribeServerFrameV20;
type OrdinaryFeedSnapshot = DraftsListResponseV30;
type OrdinaryReadSubscription = {
  readonly frontier: DraftsSubscribeOpenRequestV20;
  readonly receive: (frame: OrdinaryFeedFrame) => void;
  readonly requestSnapshot: () => void;
};

function ordinaryText(text: string) {
  return {
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text }],
      },
    ],
  };
}

function ordinaryReadWrite(
  draftId: string,
  chatId: string,
  text: string,
): OrdinaryComposerDraftWrite {
  return {
    draftId,
    kind: "chat-composer",
    target: { epicId: "epic-read-feed", chatId, blockId: null },
    lastTouchedAt: 1,
    workspace: null,
    portable: {
      content: ordinaryText(text),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
      annotations: [],
    },
  };
}

function ordinaryReadEntry(
  draftId: string,
  chatId: string,
  text: string,
  operationId: string,
): Extract<DraftCloudDocument, { operationId: string }> {
  const write = ordinaryReadWrite(draftId, chatId, text);
  return {
    draftId,
    base: {
      headSha256: "a".repeat(64),
      ownerEpoch: 1,
      revision: 1,
    },
    operationId,
    head: {
      dialect: "draft/v1",
      lastTouchedAt: write.lastTouchedAt,
      target: write.target,
      hostLocal: { hostId: HOST_ID, workspace: null },
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: "chat-composer",
      portable: write.portable,
    },
  };
}

function ordinaryReadEntryAtRevision(
  draftId: string,
  chatId: string,
  text: string,
  witness: { readonly operationId: string; readonly revision: number },
): DraftCloudDocument {
  const entry = ordinaryReadEntry(draftId, chatId, text, witness.operationId);
  return { ...entry, base: { ...entry.base, revision: witness.revision } };
}

function ordinaryReadEntryForWrite(
  write: OrdinaryComposerDraftWrite,
  operationId: string,
  revision: number,
): DraftCloudDocument {
  return draftCloudDocumentSchema.parse({
    draftId: write.draftId,
    base: {
      headSha256: "c".repeat(64),
      ownerEpoch: 1,
      revision,
    },
    operationId,
    head: {
      dialect: "draft/v1",
      lastTouchedAt: write.lastTouchedAt,
      target: write.target,
      hostLocal: { hostId: HOST_ID, workspace: write.workspace },
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: write.kind,
      portable: write.portable,
    },
  });
}

async function ordinaryReadFeedPartition(): Promise<string> {
  const scope = await resolveOrdinaryDraftScope("read-feed-owner", SCOPE_ID);
  if (scope === null) throw new Error("ordinary read scope was unavailable");
  return scope.partition;
}

async function ordinaryReadFeedBytes(
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return readOrdinaryDraftBytes(await ordinaryReadFeedPartition(), hash);
}

async function ordinaryReadFeedRow(draftId: string) {
  const partition = await ordinaryReadFeedPartition();
  const stored = await readOrdinaryDraftPartition(partition);
  return stored.rows.find((row) => row.draftId === draftId);
}

function ordinaryNewChatReadEntry(
  draftId: string,
  epicId: string,
  text: string,
  input: {
    readonly operationId: string;
    readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
    readonly runSettings: ChatRunSettings | null;
  },
): DraftCloudDocument {
  const { operationId, annotations, runSettings } = input;
  const entry = ordinaryReadEntry(
    draftId,
    "unused-chat-target",
    text,
    operationId,
  );
  return draftCloudDocumentSchema.parse({
    ...entry,
    head: {
      ...entry.head,
      surfaceKind: "new-chat",
      target: { epicId, chatId: null, blockId: null },
      portable: {
        ...entry.head.portable,
        annotations,
        blobHashes: [
          ...new Set(
            annotations.flatMap((annotation) =>
              annotation.imageHash === null ? [] : [annotation.imageHash],
            ),
          ),
        ],
        runSettings,
      },
    },
  });
}

function ordinaryLandingReadEntry(
  draftId: string,
  text: string,
  operationId: string,
  runSettings: ChatRunSettings | null,
): DraftCloudDocument {
  const entry = ordinaryReadEntry(
    draftId,
    "unused-chat-target",
    text,
    operationId,
  );
  return draftCloudDocumentSchema.parse({
    ...entry,
    head: {
      ...entry.head,
      surfaceKind: "landing",
      target: { epicId: null, chatId: null, blockId: null },
      portable: {
        ...entry.head.portable,
        runSettings,
      },
    },
  });
}

function browserCropRecord(
  annotationId: string,
  imageHash: string,
): BrowserAnnotationRecord {
  return browserAnnotationRecordSchema.parse({
    kind: "browser-annotation",
    annotationId,
    tabId: `tab-${annotationId}`,
    sessionId: `session-${annotationId}`,
    origin: "https://example.com",
    pageUrl: "https://example.com/article",
    pageTitle: "Article",
    capturedAt: 1,
    comment: "Saved crop",
    counts: { elements: 0, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: `${annotationId}.png`,
    imageHash,
    droppedElementCount: 0,
  });
}

function canvasNote(annotationId: string): BrowserAnnotationRecord {
  return browserAnnotationRecordSchema.parse({
    kind: "browser-annotation",
    annotationId,
    source: {
      kind: "canvas",
      artifactId: "canvas-read-feed",
      artifactTitle: "Canvas",
      boardPath: "boards/home.html",
      canvasPage: null,
    },
    capturedAt: 1,
    comment: "Canvas note",
    counts: { elements: 0, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: null,
    imageHash: null,
    droppedElementCount: 0,
  });
}

function ordinaryImageContent(
  text: string,
  imageId: string,
  fileName: string,
  image: { readonly hash: string; readonly size: number },
) {
  return ordinaryImageContentWithDeclaration({
    text,
    imageId,
    fileName,
    imageHash: image.hash,
    mimeType: "image/png",
    size: image.size,
  });
}

function ordinaryImageContentWithDeclaration(input: {
  readonly text: string;
  readonly imageId: string;
  readonly fileName: string;
  readonly imageHash: string;
  readonly mimeType: string;
  readonly size: number;
}) {
  const { text, imageId, fileName, imageHash, mimeType, size } = input;
  return {
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [
          { type: "text" as const, text },
          {
            type: "imageAttachment" as const,
            attrs: {
              id: imageId,
              fileName,
              mimeType,
              size,
              b64content: null,
              hash: imageHash,
              byHashEligible: true,
            },
          },
        ],
      },
    ],
  };
}

function newChatPatch(epicId: string) {
  useNewConversationModalStore
    .getState()
    .setContent(epicId, ordinaryText("local modal body"));
  const patch =
    useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
  if (patch?.draftId === null || patch?.draftId === undefined) {
    throw new Error("new-chat composer did not receive a draft id");
  }
  return patch;
}

function markNewChatPatchClean(draftId: string, revision: number): void {
  const patch = Object.values(
    useNewConversationModalStore.getState().draftPatchesByEpicId,
  ).find((candidate) => candidate?.draftId === draftId);
  if (patch === undefined) throw new Error("new-chat patch disappeared");
  newChatDraftRememberSynced(draftId, revision, patch.generation);
}

function pngBytes(tag: number): Uint8Array<ArrayBuffer> {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=";
  const decoded = atob(encoded);
  const png = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Uint8Array([...png, tag]);
}

function ordinaryReadTombstone(
  draftId: string,
): Extract<DraftCloudTombstone, { operationId: string }> {
  return {
    draftId,
    base: {
      headSha256: "b".repeat(64),
      ownerEpoch: 1,
      revision: 2,
    },
    operationId: "ordinary-read-delete",
  };
}

function ordinaryReadTombstoneAtRevision(
  draftId: string,
  revision: number,
): DraftCloudTombstone {
  const tombstone = ordinaryReadTombstone(draftId);
  return { ...tombstone, base: { ...tombstone.base, revision } };
}

function modernClaudeSettings(ultracode: boolean): ChatRunSettings {
  return {
    harnessId: "claude",
    model: "claude-sonnet-4",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    ultracode,
  };
}

type ReadBlobReply =
  | { readonly ok: true; readonly bytesBase64: string }
  | { readonly ok: false; readonly reason: "missing" };

function readBlobHash(params: unknown): string {
  if (
    typeof params !== "object" ||
    params === null ||
    !("sha256" in params) ||
    typeof params.sha256 !== "string"
  ) {
    throw new Error("readBlob request omitted its digest");
  }
  return params.sha256;
}

function ordinaryBlobClient(
  respond: (
    hash: string,
    signal: AbortSignal | undefined,
  ) => Promise<ReadBlobReply>,
): DraftBlobClient {
  const request = (async (method: string, params: unknown) => {
    if (method !== "drafts.readBlob")
      throw new Error(`unexpected blob request ${method}`);
    return respond(readBlobHash(params), undefined);
  }) as DraftBlobClient["request"];
  const requestWithOptions = (async (
    method: string,
    params: unknown,
    options: { readonly signal: AbortSignal | undefined },
  ) => {
    if (method !== "drafts.readBlob")
      throw new Error(`unexpected blob request ${method}`);
    return respond(readBlobHash(params), options.signal);
  }) as DraftBlobClient["requestWithOptions"];
  return { request, requestWithOptions };
}

function ordinaryPlacementBlobClient(
  respond: (
    hash: string,
    signal: AbortSignal | undefined,
  ) => Promise<ReadBlobReply>,
): DraftBlobClient {
  const request = (async (method: string, params: unknown) => {
    if (method === "drafts.readBlob")
      return respond(readBlobHash(params), undefined);
    if (method === "drafts.putBlob") return { ok: true as const };
    throw new Error(`unexpected blob request ${method}`);
  }) as DraftBlobClient["request"];
  const requestWithOptions = (async (
    method: string,
    params: unknown,
    options: { readonly signal: AbortSignal | undefined },
  ) => {
    if (method === "drafts.readBlob")
      return respond(readBlobHash(params), options.signal);
    if (method === "drafts.putBlob") return { ok: true as const };
    throw new Error(`unexpected blob request ${method}`);
  }) as DraftBlobClient["requestWithOptions"];
  return { request, requestWithOptions };
}

function seedCleanComposerRow(chatId: string, text: string): string {
  return seedCleanComposerRowWithContent(chatId, ordinaryText(text));
}

function seedCleanComposerRowWithContent(
  chatId: string,
  content: JsonContent,
): string {
  useComposerDraftStore.getState().setSnapshot(chatId, content, null);
  useComposerDraftStore.getState().bindTarget(chatId, "epic-read-feed");
  const draft = useComposerDraftStore.getState().drafts[chatId];
  if (draft?.draftId === null || draft?.draftId === undefined) {
    throw new Error("local composer did not receive a draft id");
  }
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[chatId];
    if (current === undefined) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          syncedGeneration: current.generation,
          hostRevision: 1,
          ownerHostId: HOST_ID,
          origin: "own",
        },
      },
    };
  });
  return draft.draftId;
}

function createOrdinaryReadHarness(snapshots: OrdinaryFeedSnapshot[]): {
  readonly port: OrdinaryDraftReadPort;
  readonly subscriptions: OrdinaryReadSubscription[];
} {
  const subscriptions: OrdinaryReadSubscription[] = [];
  const port: OrdinaryDraftReadPort = {
    list: (_signal) => {
      const snapshot = snapshots.shift();
      if (snapshot === undefined) {
        return Promise.reject(new Error("ordinary feed snapshot exhausted"));
      }
      return Promise.resolve(snapshot);
    },
    subscribe: (frontier, _signal, receive, requestSnapshot) => {
      subscriptions.push({ frontier, receive, requestSnapshot });
    },
  };
  return { port, subscriptions };
}

function landingDocument(input: {
  readonly draftId: string;
  readonly revision: number;
}): DraftDocument {
  return {
    draftId: input.draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: input.revision,
    lastTouchedAt: 1,
    workspace: null,
    supersedes: null,
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
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

const EMPTY_LIST_TOMBSTONES: DraftsListResponse["tombstones"] = [];

function listResponse(
  drafts: readonly DraftDocument[],
  snapshotSeq: number,
  tombstones: DraftsListResponse["tombstones"],
): DraftsListResponse {
  return {
    drafts: [...drafts],
    tombstones: [...tombstones],
    snapshotSeq,
    scopeId: null,
  };
}

function landingWrite(
  draftId: string,
  revision: number,
): Extract<DraftWrite, { readonly kind: "landing" }> {
  return {
    draftId,
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision,
    lastTouchedAt: 1,
    workspace: null,
    supersedes: null,
    portable: {
      content: EMPTY_DOC,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

function unsupportedError(method: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "old host",
    requestId: "req-1",
    method,
    fatalDetails: null,
  });
}

function createStreamHarness(): {
  readonly client: DraftsStreamSubscribe;
  readonly emit: (frame: DraftsSubscribeServerFrameV11) => void;
  /** Drive the session's own status handler - how a reconnect is staged. */
  readonly emitStatus: (status: StreamConnectionStatus) => void;
  readonly sent: Array<{ readonly kind: string; readonly draftIds?: unknown }>;
  readonly subscribeCalls: { count: number };
  readonly subscribeVersions: Array<{
    readonly major: number;
    readonly minor: number;
  }>;
} {
  let onFrame: ServerFrameHandler | null = null;
  let onStatus: StatusChangeHandler | null = null;
  const subscribeCalls = { count: 0 };
  const subscribeVersions: Array<{
    readonly major: number;
    readonly minor: number;
  }> = [];
  const sent: Array<{ readonly kind: string; readonly draftIds?: unknown }> =
    [];
  const session: IStreamSession = {
    sendClientFrame: (envelope, _binary) => {
      sent.push({
        kind: typeof envelope.kind === "string" ? envelope.kind : "",
        draftIds: "draftIds" in envelope ? envelope.draftIds : undefined,
      });
      void _binary;
    },
    onServerFrame: (handler) => {
      onFrame = handler;
    },
    onStatusChange: (handler) => {
      onStatus = handler;
    },
    hasSentOpenRequest: () => false,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return {
    emit: (frame) => {
      onFrame?.(frame, null);
    },
    emitStatus: (status) => {
      onStatus?.(status, null, null, null);
    },
    sent,
    subscribeCalls,
    subscribeVersions,
    client: {
      subscribeAtVersion: (_method, version, _params) => {
        subscribeCalls.count += 1;
        subscribeVersions.push(version);
        return session;
      },
    },
  };
}

function createRpc(handlers: {
  readonly list: () => Promise<DraftsListResponse>;
  readonly upsert: (
    write: DraftWrite,
  ) => Promise<{ readonly draft: DraftDocument }>;
  readonly delete: (draftId: string) => Promise<{ readonly deleted: boolean }>;
  readonly retract?: (
    draftId: string,
  ) => Promise<{ readonly retracted: boolean }>;
}): DraftsHostRpc {
  return {
    list: handlers.list,
    upsert: handlers.upsert,
    delete: handlers.delete,
    retract: handlers.retract ?? (() => Promise.resolve({ retracted: true })),
  };
}

function createSink(options: {
  readonly dirty: Set<string>;
  readonly writes: DraftDirtyWrite[];
  readonly pendingDeletes?: Set<string>;
  readonly prepareWrite?: DraftMirrorSink["prepareWrite"];
  readonly collectDirtyWrites?: DraftMirrorSink["collectDirtyWrites"];
  readonly rememberSynced?: DraftMirrorSink["rememberSynced"];
  readonly applyUpsert?: DraftMirrorSink["applyUpsert"];
  readonly dropAbsentFromList?: DraftMirrorSink["dropAbsentFromList"];
}): DraftMirrorSink & {
  readonly upserts: DraftDocument[];
  readonly deletes: string[];
  readonly scopes: string[];
  readonly synced: ReadonlyArray<{
    readonly draftId: string;
    readonly hostRevision: number;
  }>;
  readonly settles: ReadonlyArray<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }>;
} {
  const upserts: DraftDocument[] = [];
  const deletes: string[] = [];
  const scopes: string[] = [];
  const synced: Array<{
    readonly draftId: string;
    readonly hostRevision: number;
  }> = [];
  const settles: Array<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }> = [];
  return {
    upserts,
    deletes,
    scopes,
    synced,
    settles,
    isDirty: (draftId) => options.dirty.has(draftId),
    isDeletePending: (draftId) => options.pendingDeletes?.has(draftId) ?? false,
    pendingDeletesForHost: () =>
      [...(options.pendingDeletes ?? [])].map((draftId) => ({
        draftId,
        retract: false,
      })),
    settleDelete: (hostId, draftId, outcome) => {
      settles.push({ hostId, draftId, outcome });
      options.pendingDeletes?.delete(draftId);
    },
    applyUpsert:
      options.applyUpsert ??
      ((document) => {
        upserts.push(document);
        return Promise.resolve();
      }),
    applyDelete: (draftId) => {
      deletes.push(draftId);
    },
    collectDirtyWrites:
      options.collectDirtyWrites ?? (() => Promise.resolve(options.writes)),
    rememberSynced:
      options.rememberSynced ??
      ((draftId, hostRevision) => {
        synced.push({ draftId, hostRevision });
      }),
    prepareWrite:
      options.prepareWrite ?? ((_hostId, write) => Promise.resolve(write)),
    dropAbsentFromList:
      options.dropAbsentFromList ??
      ((_hostId, _listedIds) => {
        void _hostId;
        void _listedIds;
      }),
    adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
      void _hostId;
      void _wanted;
      return Promise.resolve();
    },
    applyCloudScope: (_hostId, scopeId) => {
      scopes.push(scopeId);
    },
  };
}

beforeEach(() => {
  installFreshIndexedDb();
  resetDraftMirrorCoordinatorForTests();
});

/**
 * A minimal sink for exercising `pendingDeletesForHost` / `settleDelete`
 * against a caller-owned, mutable list of pending retract/delete entries -
 * used by the `drafts.retract` bootstrap-retry tests, where the interesting
 * behavior is entirely in which entries settle and what the rpc records.
 */
function createRetractTrackingSink(
  pendingEntries: PendingHostDelete[],
): DraftMirrorSink & {
  readonly settles: ReadonlyArray<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }>;
} {
  const settles: Array<{
    readonly hostId: string;
    readonly draftId: string;
    readonly outcome: DraftDeleteOutcome;
  }> = [];
  return {
    settles,
    isDirty: (_draftId) => {
      void _draftId;
      return false;
    },
    isDeletePending: (_draftId) => {
      void _draftId;
      return false;
    },
    pendingDeletesForHost: (_hostId) => {
      void _hostId;
      return [...pendingEntries];
    },
    settleDelete: (hostId, draftId, outcome) => {
      settles.push({ hostId, draftId, outcome });
      const index = pendingEntries.findIndex(
        (entry) => entry.draftId === draftId,
      );
      if (index !== -1) pendingEntries.splice(index, 1);
    },
    applyUpsert: (_document) => {
      void _document;
      return Promise.resolve();
    },
    applyDelete: (_draftId) => {
      void _draftId;
    },
    collectDirtyWrites: (_hostId) => {
      void _hostId;
      return Promise.resolve([]);
    },
    rememberSynced: (_draftId, _hostRevision, _collectedGeneration) => {
      void _draftId;
      void _hostRevision;
      void _collectedGeneration;
    },
    prepareWrite: (_hostId, write) => {
      void _hostId;
      return Promise.resolve(write);
    },
    dropAbsentFromList: (_hostId, _listedIds) => {
      void _hostId;
      void _listedIds;
    },
    adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
      void _hostId;
      void _wanted;
      return Promise.resolve();
    },
    applyCloudScope: (_hostId, _scopeId) => {
      void _hostId;
      void _scopeId;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  useComposerDraftStore.setState({ drafts: {}, ordinaryRecoveryDrafts: {} });
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
    resumeDraftId: null,
  });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationAnnotationStore.setState({
    byEpicId: {},
    dirtyByEpicId: {},
  });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  resetDraftBlobTransportForTests();
});

describe("DraftMirrorSession", () => {
  it("opens subscribe when drafts.list returns with a null scopeId", async () => {
    const stream = createStreamHarness();
    const sink = createSink({ dirty: new Set(), writes: [] });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve({
            drafts: [],
            tombstones: EMPTY_LIST_TOMBSTONES,
            snapshotSeq: 1,
            scopeId: null,
          }),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    expect(stream.subscribeVersions).toEqual([{ major: 1, minor: 0 }]);
    expect(session.cloudScopeId()).toBeNull();
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(false);
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(sink.scopes).toEqual([SCOPE_ID]);
    });
    expect(session.cloudScopeId()).toBe(SCOPE_ID);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await Promise.resolve();
    expect(sink.scopes).toEqual([SCOPE_ID, SCOPE_ID]);
    session.close();
  });

  it("applies a late-joiner scope frame as the first subscribe message", async () => {
    const stream = createStreamHarness();
    const sink = createSink({ dirty: new Set(), writes: [] });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve({
            drafts: [],
            tombstones: EMPTY_LIST_TOMBSTONES,
            snapshotSeq: 1,
            scopeId: null,
          }),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "scope",
      hasBinaryPayload: false,
      scopeId: SCOPE_ID,
    });
    await vi.waitFor(() => {
      expect(session.cloudScopeId()).toBe(SCOPE_ID);
    });
    expect(sink.upserts).toEqual([]);
    expect(sink.deletes).toEqual([]);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: session.cloudScopeId(),
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
    session.close();
  });

  it("applies list rows that are not dirty and keeps dirty locals", async () => {
    const listed = landingDocument({ draftId: "d1", revision: 2 });
    const dirty = landingDocument({ draftId: "d2", revision: 1 });
    const sink = createSink({
      dirty: new Set(["d2"]),
      writes: [],
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([listed, dirty], 9, EMPTY_LIST_TOMBSTONES),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.upserts.map((row) => row.draftId)).toEqual(["d1"]);
    });
  });

  it("abandons the REST of a bootstrap when the session closes inside a row's apply (DRIVE RED)", async () => {
    // A close lands inside row 1's own blob read. Row 1 is correctly dropped by
    // the apply's own guard, but without a per-row guard the loop carried on
    // and row 2 was applied by a session that no longer owns the window - which
    // on a sign-out or account switch installs one account's private draft
    // under another. The apply cannot see that: by then it is a fresh call with
    // a fresh capture.
    const first = landingDocument({ draftId: "d1", revision: 2 });
    const second = landingDocument({ draftId: "d2", revision: 3 });
    const applied: string[] = [];
    const dropped: string[] = [];
    let closeSession: () => void = () => undefined;
    const sink = createSink({
      dirty: new Set(),
      writes: [],
      applyUpsert: (document) => {
        applied.push(document.draftId);
        if (document.draftId === "d1") closeSession();
        return Promise.resolve();
      },
      dropAbsentFromList: (_hostId, _listedIds) => {
        dropped.push(_hostId);
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([first, second], 9, [{ draftId: "t1", revision: 4 }]),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    closeSession = () => {
      session.close();
    };
    session.start();

    await vi.waitFor(() => {
      expect(applied).toEqual(["d1"]);
    });
    // Everything downstream of the loop is a mutation by a session that lost
    // the window, so none of it may run either.
    expect(sink.synced).toEqual([]);
    expect(sink.deletes).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("abandons a bootstrap when the ACCOUNT switches mid-listing, with no close at all (DRIVE RED)", async () => {
    // Closing is how a sign-out reaches this session, and it does - eventually.
    // The teardown is asynchronous, so between the switch and the close this
    // session is open, on its original generation, and still applying: row 1's
    // own apply correctly drops its bytes, and row 2 then installs account A's
    // text under account B with every guard answering "carry on".
    const first = landingDocument({ draftId: "d1", revision: 2 });
    const second = landingDocument({ draftId: "d2", revision: 3 });
    const applied: string[] = [];
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-a", username: "a" },
    });
    const sink = createSink({
      dirty: new Set(),
      writes: [],
      applyUpsert: (document) => {
        applied.push(document.draftId);
        if (document.draftId === "d1") {
          useAuthStore.setState({
            status: "signed-in",
            contextMetadata: { userId: "user-b", username: "b" },
          });
        }
        return Promise.resolve();
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([first, second], 9, EMPTY_LIST_TOMBSTONES),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();

    await vi.waitFor(() => {
      expect(applied).toEqual(["d1"]);
    });
    await Promise.resolve();
    await Promise.resolve();
    // Row 2 is never applied, and nothing below the loop runs either.
    expect(applied).toEqual(["d1"]);
    expect(sink.synced).toEqual([]);
    session.close();
  });

  it("abandons a bootstrap when the session closes in the hop OUT of the row loop (DRIVE RED)", async () => {
    // Every row is dirty, so the loop awaits nothing and its own post-apply
    // guard never runs. Awaiting the loop still yields, and a close landing in
    // that hop used to reach the tombstones and the absence sweep - which is
    // how a superseded bootstrap drops rows a newer one installed.
    const dirty = landingDocument({ draftId: "d1", revision: 2 });
    const dropped: string[] = [];
    let closeSession: () => void = () => undefined;
    const sink = createSink({
      dirty: new Set(["d1"]),
      writes: [],
      dropAbsentFromList: (hostId, _listedIds) => {
        dropped.push(hostId);
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([dirty], 9, [{ draftId: "t1", revision: 4 }]),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    // The close lands while the row loop is running - synchronously, from the
    // dirty check, so the only guard left between it and the sink mutations is
    // the one on the far side of the loop's own await.
    closeSession = () => {
      session.close();
    };
    let closed = false;
    const dirtyIds = new Set(["d1"]);
    Object.defineProperty(sink, "isDirty", {
      value: (draftId: string): boolean => {
        if (!closed) {
          closed = true;
          closeSession();
        }
        return dirtyIds.has(draftId);
      },
    });
    session.start();

    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.deletes).toEqual([]);
    expect(sink.synced).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("abandons a bootstrap when the session closes inside the LAST row's apply (DRIVE RED)", async () => {
    // The per-row guard above is at the TOP of the iteration, so it never runs
    // again after the final row: closing during the last apply still reached
    // `rememberIncomingSynced`, the tombstones and the absence sweep. An
    // absence sweep from a superseded bootstrap drops rows a NEWER bootstrap
    // already installed, which is the same cross-account failure one step
    // later.
    const only = landingDocument({ draftId: "d1", revision: 2 });
    const applied: string[] = [];
    const dropped: string[] = [];
    let closeSession: () => void = () => undefined;
    const sink = createSink({
      dirty: new Set(),
      writes: [],
      applyUpsert: (document) => {
        applied.push(document.draftId);
        closeSession();
        return Promise.resolve();
      },
      dropAbsentFromList: (hostId, _listedIds) => {
        dropped.push(hostId);
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([only], 9, [{ draftId: "t1", revision: 4 }]),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    closeSession = () => {
      session.close();
    };
    session.start();

    await vi.waitFor(() => {
      expect(applied).toEqual(["d1"]);
    });
    // Drain the microtask the apply's continuation is queued on, so a missing
    // post-await guard has actually run its mutations by the time we look.
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.synced).toEqual([]);
    expect(sink.deletes).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("drops a subscribe upsert of an omitted list id whose storeSeq is not newer", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(listResponse([], 21, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.upserts).toEqual([]);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 21,
      draftId: "ghost",
      revision: 1,
      draft: landingDocument({ draftId: "ghost", revision: 1 }),
    });
    // Yield first: the frame handler is async, so asserting in the emitting
    // tick would pass even if the stale frame were accepted one await later.
    await Promise.resolve();
    expect(sink.upserts).toEqual([]);
  });

  it("stays local on E_HOST_UNSUPPORTED without applying or upserting", async () => {
    const sink = createSink({
      dirty: new Set(["d1"]),
      writes: [{ write: landingWrite("d1", 0), generation: 1 }],
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.reject(unsupportedError("drafts.list")),
        upsert: () => Promise.reject(unsupportedError("drafts.upsert")),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    session.noteDirty("d1");
    await session.flush(["d1"]);
    expect(sink.upserts).toEqual([]);
  });

  it("does not send a flush frame with an empty draftIds list", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    let listed = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    await session.flush(null);
    expect(
      stream.sent.filter(
        (frame) =>
          frame.kind === "flush" &&
          Array.isArray(frame.draftIds) &&
          frame.draftIds.length === 0,
      ),
    ).toEqual([]);
  });

  it("re-arms a bounded retry after a failed upsert", async () => {
    let attempts = 0;
    let listed = false;
    const dirty = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    const sink = createSink({ dirty, writes });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("transient"));
          return Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: {
        debounceMs: 0,
        maxWaitMs: 0,
        retryBackoffMs: 1_000,
        maxRetryBackoffMs: 4_000,
      },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    vi.useFakeTimers();
    dirty.add("d1");
    writes.push({ write: landingWrite("d1", 0), generation: 1 });
    session.noteDirty("d1");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    session.close();
  });

  it("does not rememberSynced when drafts.delete reports deleted: false", async () => {
    const sink = createSink({ dirty: new Set(), writes: [] });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHost("d1")).resolves.toBe(true);
    expect(sink.synced).toEqual([]);
    session.close();
    await expect(session.deleteOnHost("d1")).resolves.toBe(false);
  });

  it("treats a missing drafts.delete capability as a completed deletion", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    await expect(session.deleteOnHost("d1")).resolves.toBe(true);
    expect(pendingDeletes).toEqual(new Set());
    expect(sink.settles).toEqual([
      { hostId: HOST_ID, draftId: "d1", outcome: "unsupported" },
    ]);
  });

  it("reports deleteOnHostOutcome as deleted when the host removed its row", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("deleted");
    session.close();
  });

  it("reports deleteOnHostOutcome as absent when the host does not hold the row, while deleteOnHost still resolves true", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("absent");
    await expect(session.deleteOnHost("d2")).resolves.toBe(true);
    session.close();
  });

  it("reports deleteOnHostOutcome as failed when the rpc rejects", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(new Error("transport error")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe("failed");
    session.close();
  });

  it("reports deleteOnHostOutcome as unsupported when the drafts capability is missing", async () => {
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.reject(unsupportedError("drafts.delete")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await expect(session.deleteOnHostOutcome("d1")).resolves.toBe(
      "unsupported",
    );
    session.close();
  });

  it("settles a bootstrap-retried pending delete as absent when the host does not hold the row", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: false }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "d1", outcome: "absent" },
      ]);
    });
    expect(pendingDeletes).toEqual(new Set());
    session.close();
  });

  it("settles a bootstrap-retried pending delete as deleted when the host removed its row", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(pendingDeletes).toEqual(new Set());
    session.close();
  });

  it("leaves a bootstrap-retried pending delete unsettled when the rpc rejects", async () => {
    const pendingDeletes = new Set(["d1"]);
    const sink = createSink({ dirty: new Set(), writes: [], pendingDeletes });
    let deleteAttempted = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => {
          deleteAttempted = true;
          return Promise.reject(new Error("transport error"));
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(deleteAttempted).toBe(true);
    });
    expect(sink.settles).toEqual([]);
    expect(pendingDeletes).toEqual(new Set(["d1"]));
    session.close();
  });

  it("retries a pending retract with drafts.retract at bootstrap and settles deleted", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
      { draftId: "d1", retract: false },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const deleteCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: (draftId) => {
          deleteCalls.push(draftId);
          return Promise.resolve({ deleted: true });
        },
        retract: (draftId) => {
          retractCalls.push(draftId);
          return Promise.resolve({ retracted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "deleted" },
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(retractCalls).toEqual(["r1"]);
    expect(deleteCalls).toEqual(["d1"]);
    session.close();
  });

  it("retries a pending retract with drafts.retract at bootstrap and settles absent", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
      { draftId: "d1", retract: false },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const deleteCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: (draftId) => {
          deleteCalls.push(draftId);
          return Promise.resolve({ deleted: true });
        },
        retract: (draftId) => {
          retractCalls.push(draftId);
          return Promise.resolve({ retracted: false });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "absent" },
        { hostId: HOST_ID, draftId: "d1", outcome: "deleted" },
      ]);
    });
    expect(retractCalls).toEqual(["r1"]);
    expect(deleteCalls).toEqual(["d1"]);
    session.close();
  });

  it("a host without drafts.retract settles the retract unsupported without tearing the session down", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    const retractCalls: string[] = [];
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
        retract: (draftId) => {
          retractCalls.push(draftId);
          if (draftId === "r1") {
            return Promise.reject(unsupportedError("drafts.retract"));
          }
          return Promise.resolve({ retracted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(sink.settles).toEqual([
        { hostId: HOST_ID, draftId: "r1", outcome: "unsupported" },
      ]);
    });
    // The retract capability being missing does not tear the whole drafts
    // session down: a fresh retract still reaches the rpc instead of being
    // short-circuited to "unsupported" by a wrongly-flipped capability flag.
    await expect(session.retractOnHostOutcome("r2")).resolves.toBe("deleted");
    expect(retractCalls).toEqual(["r1", "r2"]);
    session.close();
  });

  it("a transport failure leaves the retract pending", async () => {
    const pendingEntries: PendingHostDelete[] = [
      { draftId: "r1", retract: true },
    ];
    const sink = createRetractTrackingSink(pendingEntries);
    let retractCalls = 0;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
        retract: () => {
          retractCalls += 1;
          return Promise.reject(new Error("transport error"));
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(retractCalls).toBeGreaterThanOrEqual(1);
    });
    expect(sink.settles).toEqual([]);
    await expect(session.retractOnHostOutcome("r1")).resolves.toBe("failed");
    expect(sink.settles).toEqual([]);
    session.close();
  });

  it("does not erase a composer draft synced to host A when host B bootstraps", async () => {
    const typed = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep me" }],
        },
      ],
    };
    useComposerDraftStore.setState({
      drafts: {
        "chat-x": {
          content: typed,
          selection: { from: 1, to: 8 },
          browserAnnotations: [],
          resetEpoch: 3,
          revision: 2,
          draftId: "draft-x",
          hostRevision: 4,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 1,
          ownerHostId: null,
          origin: null,
          supersedes: null,
          publication: null,
          chatTitle: null,
          epicTitle: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", "host-a"]]);
    let hostBDropped = false;
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      applyUpsert: (document) => {
        applyComposerHostDocument(document);
        return Promise.resolve();
      },
      applyDelete: (draftId) => {
        applyComposerHostDelete(draftId);
      },
      collectDirtyWrites: () => Promise.resolve([]),
      rememberSynced: () => undefined,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: (hostId, listedIds) => {
        if (hostId === "host-b") hostBDropped = true;
        dropComposerAbsentFromList(hostId, listedIds, boundHostByChatId);
      },
      adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
        void _hostId;
        void _wanted;
        return Promise.resolve();
      },
      applyCloudScope: () => undefined,
    };
    const listed: DraftDocument = {
      draftId: "draft-x",
      kind: "chat-composer",
      target: { epicId: "epic-1", chatId: "chat-x", blockId: null },
      revision: 4,
      lastTouchedAt: 1,
      workspace: null,
      supersedes: null,
      ownerHostId: "host-a",
      origin: "own",
      adoption: { state: "adopted", hostId: "host-a" },
      publication: {
        status: "unpublished",
        lastPublishedAt: null,
        publishedRevision: null,
        halted: null,
      },
      portable: {
        content: typed,
        selection: { from: 1, to: 8 },
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    const sessionA = new DraftMirrorSession({
      hostId: "host-a",
      rpc: createRpc({
        list: () =>
          Promise.resolve(listResponse([listed], 3, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const sessionB = new DraftMirrorSession({
      hostId: "host-b",
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    sessionA.start();
    await vi.waitFor(() => {
      expect(useComposerDraftStore.getState().drafts["chat-x"]?.draftId).toBe(
        "draft-x",
      );
    });
    const epochAfterA =
      useComposerDraftStore.getState().drafts["chat-x"]?.resetEpoch ?? -1;
    sessionB.start();
    await vi.waitFor(() => {
      expect(hostBDropped).toBe(true);
    });
    const afterB = useComposerDraftStore.getState().drafts["chat-x"];
    expect(afterB?.content).toEqual(typed);
    expect(afterB?.resetEpoch).toBe(epochAfterA);
    expect(afterB?.selection).toEqual({ from: 1, to: 8 });
    sessionA.close();
    sessionB.close();
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("clears stale composer content from a list tombstone after missing the delete frame", async () => {
    const typed = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "already sent" }],
        },
      ],
    };
    useComposerDraftStore.setState({
      drafts: {
        "chat-x": {
          content: typed,
          selection: { from: 1, to: 13 },
          browserAnnotations: [],
          resetEpoch: 3,
          revision: 2,
          draftId: "draft-x",
          hostRevision: 4,
          targetEpicId: "epic-1",
          lastTouchedAt: 1,
          generation: 1,
          syncedGeneration: 1,
          ownerHostId: null,
          origin: null,
          supersedes: null,
          publication: null,
          chatTitle: null,
          epicTitle: null,
        },
      },
    });
    const boundHostByChatId = new Map([["chat-x", HOST_ID]]);
    const sink: DraftMirrorSink = {
      isDirty: (draftId) => composerDraftIsDirty(draftId),
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      applyUpsert: (document) => {
        applyComposerHostDocument(document);
        return Promise.resolve();
      },
      applyDelete: (draftId) => {
        applyComposerHostDelete(draftId);
      },
      collectDirtyWrites: () => Promise.resolve([]),
      rememberSynced: () => undefined,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: (hostId, listedIds) => {
        dropComposerAbsentFromList(hostId, listedIds, boundHostByChatId);
      },
      adoptUnadoptedLandingDrafts: (_hostId, _wanted) => {
        void _hostId;
        void _wanted;
        return Promise.resolve();
      },
      applyCloudScope: () => undefined,
    };
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () =>
          Promise.resolve(
            listResponse([], 20, [{ draftId: "draft-x", revision: 5 }]),
          ),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(
        useComposerDraftStore.getState().drafts["chat-x"]?.resetEpoch,
      ).toBe(4);
    });
    const after = useComposerDraftStore.getState().drafts["chat-x"];
    expect(after?.content).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(after?.selection).toEqual({ from: 1, to: 1 });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 21,
      draftId: "draft-x",
      revision: 6,
      draft: {
        draftId: "draft-x",
        kind: "chat-composer",
        target: { epicId: "epic-1", chatId: "chat-x", blockId: null },
        revision: 6,
        lastTouchedAt: 2,
        workspace: null,
        supersedes: null,
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
          content: typed,
          selection: { from: 1, to: 13 },
          runSettings: null,
          composerMode: "chat",
          blobHashes: [],
          closed: false,
        },
      },
    });
    expect(useComposerDraftStore.getState().drafts["chat-x"]?.content).toEqual(
      typed,
    );
    session.close();
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("orders deletion behind an already-dispatched upsert", async () => {
    let finishUpsert: () => void = () => {
      throw new Error("upsert did not start");
    };
    const order: string[] = [];
    const write = landingWrite("ordered", 0);
    const sink = createSink({
      dirty: new Set([write.draftId]),
      writes: [{ write, generation: 1 }],
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: async () => {
          order.push("upsert-start");
          await new Promise<void>((resolve) => {
            finishUpsert = resolve;
          });
          order.push("upsert-end");
          return {
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          };
        },
        delete: () => {
          order.push("delete");
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => expect(order).toEqual(["upsert-start"]));
    const deleting = session.deleteOnHost(write.draftId);
    await Promise.resolve();
    expect(order).toEqual(["upsert-start"]);
    finishUpsert();
    await deleting;
    expect(order).toEqual(["upsert-start", "upsert-end", "delete"]);
    session.close();
  });

  it("drops a collected write when submission fences it during preparation", async () => {
    let finishPrepare: () => void = () => {
      throw new Error("prepare did not start");
    };
    let prepareStarted = false;
    const pendingDeletes = new Set<string>();
    const write = landingWrite("collected-before-submit", 0);
    let upsertCount = 0;
    const sink = createSink({
      dirty: new Set([write.draftId]),
      writes: [{ write, generation: 1 }],
      pendingDeletes,
      prepareWrite: async (_hostId, prepared) => {
        prepareStarted = true;
        await new Promise<void>((resolve) => {
          finishPrepare = resolve;
        });
        return prepared;
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, [])),
        upsert: () => {
          upsertCount += 1;
          return Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => expect(prepareStarted).toBe(true));
    pendingDeletes.add(write.draftId);
    finishPrepare();
    await vi.waitFor(() => expect(sink.synced).toEqual([]));
    expect(upsertCount).toBe(0);
    session.close();
  });

  it("upserts a landing draft created after bootstrap by adopting on the sync path", async () => {
    resetDraftMirrorCoordinatorForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    bindLandingAdoptionHost(HOST_ID);
    const upserted: string[] = [];
    const sink: DraftMirrorSink = {
      isDeletePending: () => false,
      pendingDeletesForHost: () => [],
      settleDelete: (_hostId, _draftId, _outcome) => {
        void _hostId;
        void _draftId;
        void _outcome;
      },
      isDirty: (draftId) => landingDraftIsDirty(draftId),
      applyUpsert: () => Promise.resolve(),
      applyDelete: () => undefined,
      collectDirtyWrites: (hostId) =>
        Promise.resolve(
          collectLandingDirtyWrites(hostId).map(({ draft }) => ({
            generation: draft.generation,
            write: composerDraftWrite({
              draftId: draft.id,
              kind: "landing",
              target: landingTarget(),
              revision: draft.hostRevision,
              lastTouchedAt: draft.lastTouchedAt,
              content: draft.content,
              selection: draft.selection,
              runSettings: draft.settings,
              composerMode: draft.composerMode,
              workspace: draft.workspace,
              closed: draft.closed,
              supersedes: draft.supersedes,
            }),
          })),
        ),
      rememberSynced: landingDraftRememberSynced,
      prepareWrite: (_hostId, write) => Promise.resolve(write),
      dropAbsentFromList: () => undefined,
      adoptUnadoptedLandingDrafts: (hostId, wanted) =>
        adoptUnadoptedLandingDraftsForHost(hostId, wanted),
      applyCloudScope: () => undefined,
    };
    let listed = false;
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => {
          listed = true;
          return Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES));
        },
        upsert: (write) => {
          upserted.push(write.draftId);
          return Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: 1,
            }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(listed).toBe(true);
    });
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      id,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        ],
      },
      { from: 1, to: 6 },
    );
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "unadopted" });
    session.noteDirty(id);
    await vi.waitFor(() => {
      expect(upserted).toEqual([id]);
    });
    expect(
      useLandingDraftStore.getState().drafts.find((d) => d.id === id)?.adoption,
    ).toEqual({ state: "adopted", hostId: HOST_ID });
    session.close();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    resetDraftMirrorCoordinatorForTests();
  });

  it("coalesces a newer landing save behind a stalled save to the latest snapshot", async () => {
    const draftId = "coalesced-landing";
    const first = landingWrite(draftId, 0);
    const latest: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 2,
      portable: {
        ...first.portable,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "latest" }] },
          ],
        },
      },
    };
    const writes: DraftDirtyWrite[] = [{ write: first, generation: 1 }];
    const dirty = new Set([draftId]);
    let collectCalls = 0;
    let prepareCalls = 0;
    let finishFirstPrepare: (() => void) | undefined;
    const firstPrepare = new Promise<void>((resolve) => {
      finishFirstPrepare = resolve;
    });
    const sent: DraftWrite[] = [];
    const sink = createSink({
      dirty,
      writes,
      collectDirtyWrites: () => {
        collectCalls += 1;
        return Promise.resolve([...writes]);
      },
      prepareWrite: async (_hostId, write) => {
        prepareCalls += 1;
        if (prepareCalls === 1) await firstPrepare;
        return write;
      },
      rememberSynced: (draftId) => {
        dirty.delete(draftId);
      },
    });
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) => {
          sent.push(write);
          return Promise.resolve({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          });
        },
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const firstFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(prepareCalls).toBe(1);
    });

    writes.splice(0, writes.length, { write: latest, generation: 2 });
    const latestFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(2);
    });
    finishFirstPrepare?.();
    await Promise.all([firstFlush, latestFlush]);

    expect(sent).toEqual([first, latest]);
    session.close();
  });

  it("does not ACK an incoming landing row when a local edit lands during apply", async () => {
    const draftId = "incoming-apply-edit";
    const incoming = landingDocument({ draftId, revision: 2 });
    const stream = createStreamHarness();
    const dirty = new Set<string>();
    const applied: DraftDocument[] = [];
    let applyFinished = false;
    let finishApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const sink = createSink({
      dirty,
      writes: [],
      applyUpsert: async (document) => {
        applied.push(document);
        await applyGate;
        applyFinished = true;
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) =>
          Promise.resolve({
            draft: landingDocument({
              draftId: write.draftId,
              revision: write.revision + 1,
            }),
          }),
        delete: () => Promise.resolve({ deleted: true }),
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });

    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 1,
      draftId,
      revision: incoming.revision,
      draft: incoming,
    });
    await vi.waitFor(() => {
      expect(applied).toEqual([incoming]);
    });
    dirty.add(draftId);
    finishApply?.();
    await vi.waitFor(() => {
      expect(applyFinished).toBe(true);
    });
    await Promise.resolve();

    expect(sink.synced).toEqual([]);
    session.close();
  });

  it("advances the committed upsert frontier before acknowledging deletion", async () => {
    const draftId = "late-success-after-delete";
    const heldRow = landingDocument({ draftId, revision: 4 });
    const committedRow = landingDocument({ draftId, revision: 7 });
    const stream = createStreamHarness();
    const pendingDeletes = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    let upsertStarted = false;
    let resolveUpsert:
      | ((response: { readonly draft: DraftDocument }) => void)
      | undefined;
    const upsertResponse = new Promise<{ readonly draft: DraftDocument }>(
      (resolve) => {
        resolveUpsert = resolve;
      },
    );
    const sink = createSink({
      dirty: new Set(),
      writes,
      pendingDeletes,
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: () => {
          upsertStarted = true;
          return upsertResponse;
        },
        delete: (id) => {
          pendingDeletes.add(id);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 4,
      draftId,
      revision: heldRow.revision,
      draft: heldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow]);

    writes.push({ write: landingWrite(draftId, 4), generation: 1 });
    const upserting = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });
    const deleting = session.deleteOnHost(draftId);
    resolveUpsert?.({ draft: committedRow });
    await deleting;
    pendingDeletes.delete(draftId);
    await upserting;

    // The delete ACK clears the chat-style pending receipt. Deletion must
    // include committed r7 in its tombstone frontier to reject the late echo.
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 7,
      draftId,
      revision: committedRow.revision,
      draft: committedRow,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.upserts).toEqual([heldRow]);
    expect(sink.synced).toEqual([
      { draftId, hostRevision: 4 },
      { draftId, hostRevision: 0 },
    ]);
    session.close();
  });

  it("preserves a newer held row when an older retired upsert completes", async () => {
    const draftId = "late-upsert-after-delete";
    const heldRow = landingDocument({ draftId, revision: 4 });
    const committedRow = landingDocument({ draftId, revision: 7 });
    const stream = createStreamHarness();
    const pendingDeletes = new Set<string>();
    const writes: DraftDirtyWrite[] = [];
    let upsertStarted = false;
    let resolveUpsert:
      | ((response: { readonly draft: DraftDocument }) => void)
      | undefined;
    const upsertResponse = new Promise<{ readonly draft: DraftDocument }>(
      (resolve) => {
        resolveUpsert = resolve;
      },
    );
    const sink = createSink({
      dirty: new Set(),
      writes,
      pendingDeletes,
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 0, EMPTY_LIST_TOMBSTONES)),
        upsert: () => {
          upsertStarted = true;
          return upsertResponse;
        },
        delete: (id) => {
          pendingDeletes.add(id);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: stream.client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await vi.waitFor(() => {
      expect(stream.subscribeCalls.count).toBe(1);
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 4,
      draftId,
      revision: heldRow.revision,
      draft: heldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow]);

    writes.push({ write: landingWrite(draftId, 4), generation: 1 });
    const upserting = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });
    const deleting = session.deleteOnHost(draftId);
    const newerHeldRow = landingDocument({ draftId, revision: 9 });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 9,
      draftId,
      revision: newerHeldRow.revision,
      draft: newerHeldRow,
    });
    await Promise.resolve();
    expect(sink.upserts).toEqual([heldRow, newerHeldRow]);
    resolveUpsert?.({ draft: committedRow });
    await deleting;
    pendingDeletes.delete(draftId);
    await upserting;

    // The chat-style pending receipt is cleared after the ACK. The held
    // tombstone, not a durable landing receipt, must still reject this late
    // echo and any older response.
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 7,
      draftId,
      revision: committedRow.revision,
      draft: committedRow,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 9,
      draftId,
      revision: newerHeldRow.revision,
      draft: newerHeldRow,
    });
    stream.emit({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 6,
      draftId,
      revision: 6,
      draft: landingDocument({ draftId, revision: 6 }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.upserts).toEqual([heldRow, newerHeldRow]);
    expect(sink.synced).toEqual([
      { draftId, hostRevision: 4 },
      { draftId, hostRevision: 0 },
    ]);
    session.close();
  });

  it("drops waiting landing saves at delete and gates generations appended after it", async () => {
    const draftId = "cancelled-landing";
    const first = landingWrite(draftId, 0);
    const second: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 2,
    };
    const third: Extract<DraftWrite, { readonly kind: "landing" }> = {
      ...first,
      lastTouchedAt: 3,
    };
    const writes: DraftDirtyWrite[] = [{ write: first, generation: 1 }];
    const dirty = new Set([draftId]);
    const pendingDeletes = new Set<string>();
    let collectCalls = 0;
    let finishFirstUpsert: (() => void) | undefined;
    let upsertStarted = false;
    const firstUpsert = new Promise<void>((resolve) => {
      finishFirstUpsert = resolve;
    });
    const sent: DraftWrite[] = [];
    const deletes: string[] = [];
    const sink = createSink({
      dirty,
      writes,
      pendingDeletes,
      collectDirtyWrites: () => {
        collectCalls += 1;
        return Promise.resolve([...writes]);
      },
      rememberSynced: (draftId) => {
        dirty.delete(draftId);
      },
    });
    const session = new DraftMirrorSession({
      hostId: HOST_ID,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: (write) => {
          sent.push(write);
          upsertStarted = true;
          return firstUpsert.then(() => ({
            draft: landingDocument({ draftId: write.draftId, revision: 1 }),
          }));
        },
        delete: (draftId) => {
          deletes.push(draftId);
          return Promise.resolve({ deleted: true });
        },
      }),
      streamClient: createStreamHarness().client,
      sink,
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    const firstFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(upsertStarted).toBe(true);
    });

    writes.splice(0, writes.length, { write: second, generation: 2 });
    const secondFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(2);
    });
    pendingDeletes.add(draftId);
    const deleting = session.deleteOnHost(draftId);

    writes.splice(0, writes.length, { write: third, generation: 3 });
    const thirdFlush = session.flush([draftId]);
    await vi.waitFor(() => {
      expect(collectCalls).toBeGreaterThanOrEqual(3);
    });
    finishFirstUpsert?.();
    await Promise.all([firstFlush, secondFlush, thirdFlush, deleting]);

    expect(sent).toEqual([first]);
    expect(deletes).toEqual([draftId]);
    session.close();
  });

  // ─── F6: close() fences the blob memo ───────────────────────────────────

  const BLOB_HOST = "host-close-fence";
  const BLOB_OWNER = "owner-close-fence";

  it("F6 (10): close() fences a late putBlob acknowledgement - a confirmation that lands after close is not recorded", async () => {
    // Real bytes, a real upload dispatched, `close()` called while it is
    // still on the wire, and only THEN the response resolves.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const request = (async (_method, _params) => {
      await gate;
      return { ok: true as const };
    }) as HostRequester<HostRpcRegistry>["request"];
    const client: DraftBlobClient = { request, requestWithOptions: request };

    const uploadPromise = putDraftBlobs(BLOB_HOST, client, [hash], BLOB_OWNER);
    // The request has dispatched (it is parked on `gate`, inside the
    // client's own `request` call) by the time we get here - synchronous up
    // to its first await, same as every other upload-in-flight fixture in
    // this suite.

    const session = new DraftMirrorSession({
      hostId: BLOB_HOST,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.close();

    releaseUpload();
    const confirmed = await uploadPromise;

    // Reported UNCONFIRMED, not "confirmed but unmemoized". `close()` fenced
    // the acknowledgement, and the caller's own bookkeeping is the landing
    // draft's `confirmedHostBlobHashes` - the set that decides whether the
    // local bytes may be evicted. A digest here would let the only copy go.
    expect(confirmed).toEqual([]);
    // The memo agrees: the send gate must not trust bytes on a connection this
    // client has stopped talking to.
    expect(isDraftBlobConfirmed(BLOB_HOST, hash, BLOB_OWNER)).toBe(false);
  });

  it("a reconnect re-bootstrap re-probes the capability memos, not just the confirmations (DRIVE RED)", async () => {
    // A host that comes back on a reconnect can be a host that came back on a
    // new BUILD - a restart is how an upgrade lands. Acquisition already
    // re-probes for exactly that reason, and the reconnect path re-lists
    // without re-acquiring, so a host that GAINED `drafts.putBlob` stayed
    // short-circuited until the whole tile hierarchy unmounted.
    const host = "host-rebootstrap-capability";
    const hash = await putImage(new Uint8Array([13, 14, 15, 16]));

    // The host answers "I do not have these methods" once.
    let withholds = true;
    const request = ((_method, _params) =>
      withholds
        ? Promise.reject(unsupportedError("drafts.putBlob"))
        : Promise.resolve({
            ok: true as const,
          })) as HostRequester<HostRpcRegistry>["request"];
    const client: DraftBlobClient = { request, requestWithOptions: request };
    expect(await putDraftBlobs(host, client, [hash], BLOB_OWNER)).toEqual([]);
    expect(hostWithholdsDraftBlobs(host)).toBe(true);

    // The host restarts into a build that has them, and the mirror re-lists.
    const stream = createStreamHarness();
    const session = new DraftMirrorSession({
      hostId: host,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: stream.client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.start();
    await Promise.resolve();
    // The FIRST `open` is the subscribe itself, which `start()` already listed
    // for; the second is the reconnect that re-bootstraps.
    stream.emitStatus("open");
    stream.emitStatus("open");
    await Promise.resolve();

    expect(hostWithholdsDraftBlobs(host)).toBe(false);
    withholds = false;
    expect(await putDraftBlobs(host, client, [hash], BLOB_OWNER)).toEqual([
      hash,
    ]);
    session.close();
  });

  it("F6 consequence: a fenced acknowledgement never reaches a landing draft's confirmedHostBlobHashes", async () => {
    // The memo is not the only consumer of `putDraftBlobs`' answer.
    // `rememberLandingBlobsOnHost` feeds that same array into the set
    // `landingDraftPinsLocalImageBytes` reads, and a draft whose every hash is
    // in it stops pinning its local bytes - so an acknowledgement from a
    // retired conversation would let the LRU discard the only copy of the
    // image. This asserts the value at the boundary the eviction gate reads.
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const request = (async (_method, _params) => {
      await gate;
      return { ok: true as const };
    }) as HostRequester<HostRpcRegistry>["request"];
    const client: DraftBlobClient = { request, requestWithOptions: request };
    const host = "host-close-fence-eviction";

    const uploadPromise = putDraftBlobs(host, client, [hash], BLOB_OWNER);
    const session = new DraftMirrorSession({
      hostId: host,
      rpc: createRpc({
        list: () => Promise.resolve(listResponse([], 1, EMPTY_LIST_TOMBSTONES)),
        upsert: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      }),
      streamClient: createStreamHarness().client,
      sink: createSink({ dirty: new Set(), writes: [] }),
      timing: { debounceMs: 0, maxWaitMs: 0 },
      now: () => 0,
    });
    session.close();

    releaseUpload();
    const confirmed = await uploadPromise;

    const draftId = useLandingDraftStore.getState().createDraft(null);
    rememberLandingBlobsOnHost(draftId, confirmed);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === draftId)?.confirmedHostBlobHashes,
    ).toEqual([]);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("F6 positive control: without close(), the identical sequence DOES confirm", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hash = await putImage(bytes);
    let releaseUpload: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const request = (async (_method, _params) => {
      await gate;
      return { ok: true as const };
    }) as HostRequester<HostRpcRegistry>["request"];
    const client: DraftBlobClient = { request, requestWithOptions: request };

    const uploadPromise = putDraftBlobs(
      "host-close-fence-control",
      client,
      [hash],
      BLOB_OWNER,
    );
    releaseUpload();
    const confirmed = await uploadPromise;

    expect(confirmed).toEqual([hash]);
    expect(
      isDraftBlobConfirmed("host-close-fence-control", hash, BLOB_OWNER),
    ).toBe(true);
  });
});

describe("OrdinaryDraftReadFeed", () => {
  it("keeps the highwater across a regressing reset snapshot and fences old work", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const oldEntry = ordinaryReadEntry(
      "draft-read-feed",
      "chat-read-feed",
      "old stream body",
      "old-stream",
    );
    const newerBaseEntry = ordinaryReadEntry(
      "draft-read-feed",
      "chat-read-feed",
      "newer frame body",
      "newer-frame",
    );
    const newerEntry: DraftCloudDocument = {
      ...newerBaseEntry,
      base: { ...newerBaseEntry.base, revision: 2 },
    };
    const staleEntry = ordinaryReadEntry(
      "draft-read-feed",
      "chat-read-feed",
      "old snapshot body",
      "stale-snapshot-body",
    );
    const custodyBaseEntry = ordinaryReadEntry(
      "draft-read-feed",
      "chat-read-feed",
      "resnapshot body",
      "custody-snapshot",
    );
    const custodyEntry: DraftCloudDocument = {
      ...custodyBaseEntry,
      base: { ...custodyBaseEntry.base, revision: 3 },
    };
    const staleTombstone = {
      ...ordinaryReadTombstone("draft-stale-tombstone"),
      operationId: "stale-snapshot-tombstone",
    };
    const { port, subscriptions } = createOrdinaryReadHarness([
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 80,
        drafts: [],
        tombstones: [],
      },
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 2,
        drafts: [staleEntry],
        tombstones: [staleTombstone],
      },
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 95,
        drafts: [custodyEntry],
        tombstones: [],
      },
    ]);
    const preparedOperations: string[] = [];
    const committed: string[] = [];
    const released: string[] = [];
    let markOldPrepareStarted: () => void = () => undefined;
    const oldPrepareStarted = new Promise<void>((resolve) => {
      markOldPrepareStarted = resolve;
    });
    let finishOldPrepare: () => void = () => undefined;
    const oldPrepareGate = new Promise<void>((resolve) => {
      finishOldPrepare = resolve;
    });
    let markOldReleased: () => void = () => undefined;
    const oldReleased = new Promise<void>((resolve) => {
      markOldReleased = resolve;
    });
    const sink: OrdinaryDraftReadSink = {
      localOccurrence: () => null,
      prepare: async (_scopeId, entry, _signal) => {
        const operationId = entry.operationId;
        if (operationId === null)
          throw new Error("expected a conditional head");
        preparedOperations.push(operationId);
        if (operationId === "old-stream") {
          markOldPrepareStarted();
          await oldPrepareGate;
        }
        return {
          commit: () => {
            committed.push(
              `${"head" in entry ? "upsert" : "delete"}:${operationId}`,
            );
          },
          release: () => {
            released.push(operationId);
            if (operationId === "old-stream") markOldReleased();
          },
        };
      },
    };
    const feed = new OrdinaryDraftReadFeed(SCOPE_ID, port, sink);

    await feed.refresh();
    const oldSubscription = subscriptions[0];
    expect(oldSubscription.frontier).toEqual({
      scopeId: SCOPE_ID,
      afterSeq: 80,
    });
    oldSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 89,
      draft: oldEntry,
    });
    await oldPrepareStarted;
    oldSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 90,
      draft: newerEntry,
    });
    await vi.waitFor(() => {
      expect(committed).toEqual(["upsert:newer-frame"]);
    });

    oldSubscription.receive({ kind: "reset", hasBinaryPayload: false });
    await vi.waitFor(() => {
      expect(subscriptions).toHaveLength(2);
    });
    const currentSubscription = subscriptions[1];
    expect(currentSubscription.frontier).toEqual({
      scopeId: SCOPE_ID,
      afterSeq: 90,
    });
    oldSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 91,
      draft: oldEntry,
    });
    currentSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 89,
      draft: staleEntry,
    });
    currentSubscription.receive({
      kind: "delete",
      hasBinaryPayload: false,
      seq: 90,
      tombstone: staleTombstone,
    });
    currentSubscription.requestSnapshot();
    await vi.waitFor(() => {
      expect(subscriptions).toHaveLength(3);
    });
    expect(subscriptions[2].frontier).toEqual({
      scopeId: SCOPE_ID,
      afterSeq: 95,
    });
    await vi.waitFor(() => {
      expect(committed).toEqual([
        "upsert:newer-frame",
        "upsert:custody-snapshot",
      ]);
    });

    finishOldPrepare();
    await oldReleased;
    expect(committed).toEqual([
      "upsert:newer-frame",
      "upsert:custody-snapshot",
    ]);
    expect(released).toEqual(["newer-frame", "custody-snapshot", "old-stream"]);
    expect(preparedOperations).toEqual([
      "old-stream",
      "newer-frame",
      "custody-snapshot",
    ]);
    feed.close();
  });

  it("releases a prepared host body when a local composer edit becomes dirty", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-local";
    const draftId = seedCleanComposerRow(chatId, "before host read");
    expect(composerDraftIsDirty(draftId)).toBe(false);
    const imageBytes = pngBytes(1);
    const imageHash = await sha256Hex(imageBytes);
    const baseEntry = ordinaryReadEntry(
      draftId,
      chatId,
      "stale host body",
      "host-snapshot",
    );
    const entry: DraftCloudDocument = {
      ...baseEntry,
      head: {
        ...baseEntry.head,
        portable: {
          ...baseEntry.head.portable,
          content: ordinaryImageContent(
            "stale host body",
            "read-feed-local-race-image",
            "read-feed-local-race.png",
            { hash: imageHash, size: imageBytes.byteLength },
          ),
          blobHashes: [imageHash],
        },
      },
    };
    const { port } = createOrdinaryReadHarness([
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 1,
        drafts: [entry],
        tombstones: [],
      },
    ]);
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let resolveBlobRead: (reply: ReadBlobReply) => void = () => undefined;
    const pendingBlobRead = new Promise<ReadBlobReply>((resolve) => {
      resolveBlobRead = resolve;
    });
    const client = ordinaryBlobClient((hash) => {
      expect(hash).toBe(imageHash);
      markReadStarted();
      return pendingBlobRead;
    });
    let markPreparedRefused: () => void = () => undefined;
    const preparedRefused = new Promise<void>((resolve) => {
      markPreparedRefused = resolve;
    });
    const realSink = createOrdinaryDraftReadSink(client);
    const sink: OrdinaryDraftReadSink = {
      ...realSink,
      async prepare(scopeId, candidate, signal) {
        const prepared = await realSink.prepare(scopeId, candidate, signal);
        if (candidate === entry && prepared === null) markPreparedRefused();
        return prepared;
      },
    };
    const feed = new OrdinaryDraftReadFeed(SCOPE_ID, port, sink);

    const refreshing = feed.refresh();
    await readStarted;
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, ordinaryText("new local text"), null);
    expect(composerDraftIsDirty(draftId)).toBe(true);
    resolveBlobRead({
      ok: true,
      bytesBase64: bytesToBase64(imageBytes),
    });
    await preparedRefused;
    await refreshing;
    await vi.waitFor(async () => {
      expect(await ordinaryReadFeedBytes(imageHash)).toBeUndefined();
    });
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      ordinaryText("new local text"),
    );
    feed.close();
  });

  it("rehydrates dirty chat, landing and modal patches before holding live heads, deletes and refreshes", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });

    const chatId = "chat-read-feed-dirty-chat";
    const chatDraftId = seedCleanComposerRow(chatId, "accepted chat body");
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, ordinaryText("edited chat body"), null);

    const landingDraftId = "draft-read-feed-dirty-landing";
    useLandingDraftStore.getState().createDraftWithId(landingDraftId, null);
    landingDraftRememberSynced(landingDraftId, 1, 0, HOST_ID);
    useLandingDraftStore
      .getState()
      .setDraftContent(
        landingDraftId,
        ordinaryText("edited landing body"),
        null,
      );

    const epicId = "epic-read-feed-dirty-modal";
    const modalPatch = newChatPatch(epicId);
    if (modalPatch.draftId === null) throw new Error("modal patch has no id");
    markNewChatPatchClean(modalPatch.draftId, 1);
    useNewConversationModalStore
      .getState()
      .setContent(epicId, ordinaryText("edited modal body"));

    await Promise.all([
      useComposerDraftStore.persist.rehydrate(),
      useLandingDraftStore.persist.rehydrate(),
      useNewConversationModalStore.persist.rehydrate(),
    ]);

    const rehydratedChat = useComposerDraftStore.getState().drafts[chatId];
    const rehydratedLanding = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === landingDraftId);
    const rehydratedModal =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    if (
      rehydratedChat === undefined ||
      rehydratedLanding === undefined ||
      rehydratedModal === undefined
    ) {
      throw new Error("dirty local editor did not rehydrate");
    }
    expect(rehydratedChat.hostRevision).toBe(1);
    expect(rehydratedChat.content).toEqual(ordinaryText("edited chat body"));
    expect(rehydratedLanding.hostRevision).toBe(1);
    expect(rehydratedLanding.content).toEqual(
      ordinaryText("edited landing body"),
    );
    expect(rehydratedModal.hostRevision).toBe(1);
    expect(rehydratedModal.content).toEqual(ordinaryText("edited modal body"));

    const chatEntry = ordinaryReadEntryAtRevision(
      chatDraftId,
      chatId,
      "remote chat body",
      { operationId: "dirty-chat-live", revision: 2 },
    );
    const landingBase = ordinaryLandingReadEntry(
      landingDraftId,
      "remote landing body",
      "dirty-landing-live",
      null,
    );
    const landingEntry: DraftCloudDocument = {
      ...landingBase,
      base: { ...landingBase.base, revision: 2 },
    };
    const modalBase = ordinaryNewChatReadEntry(
      modalPatch.draftId,
      epicId,
      "remote modal body",
      { operationId: "dirty-modal-live", annotations: [], runSettings: null },
    );
    const modalEntry: DraftCloudDocument = {
      ...modalBase,
      base: { ...modalBase.base, revision: 2 },
    };
    const tombstones = [
      ordinaryReadTombstoneAtRevision(chatDraftId, 3),
      ordinaryReadTombstoneAtRevision(landingDraftId, 3),
      ordinaryReadTombstoneAtRevision(modalPatch.draftId, 3),
    ];
    const { port, subscriptions } = createOrdinaryReadHarness([
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 0,
        drafts: [chatEntry, landingEntry, modalEntry],
        tombstones: [],
      },
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 3,
        drafts: [],
        tombstones,
      },
    ]);
    const feed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() =>
          Promise.reject(new Error("dirty rows do not read blobs")),
        ),
      ),
    );

    await feed.refresh();
    const subscription = subscriptions.at(0);
    if (subscription === undefined)
      throw new Error("ordinary feed did not subscribe");
    for (const [index, tombstone] of tombstones.entries()) {
      subscription.receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: index + 1,
        tombstone,
      });
    }
    subscription.requestSnapshot();
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));

    expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
      chatDraftId,
    );
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      ordinaryText("edited chat body"),
    );
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === landingDraftId)?.content,
    ).toEqual(ordinaryText("edited landing body"));
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.content,
    ).toEqual(ordinaryText("edited modal body"));
    expect(useComposerDraftStore.getState().ordinaryRecoveryDrafts).toEqual({});
    feed.close();
  });

  it("holds modal sidecar removal before arrival and patch plus sidecar change-revert during preparation", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const epicId = "epic-read-feed-sidecar-race";
    const patch = newChatPatch(epicId);
    if (patch.draftId === null) throw new Error("modal patch has no id");
    markNewChatPatchClean(patch.draftId, 1);
    const beforeArrival = canvasNote("sidecar-before-arrival");
    useNewConversationAnnotationStore.getState().add(epicId, beforeArrival);
    settleNewConversationAnnotations(
      epicId,
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    );

    const firstAnnotation = canvasNote("sidecar-first-head");
    const first = ordinaryNewChatReadEntry(
      patch.draftId,
      epicId,
      "remote modal first head",
      {
        operationId: "modal-sidecar-first",
        annotations: [firstAnnotation],
        runSettings: null,
      },
    );
    const imageBytes = pngBytes(5);
    const cropHash = await sha256Hex(imageBytes);
    const secondAnnotation = browserCropRecord("sidecar-second-head", cropHash);
    const secondBase = ordinaryNewChatReadEntry(
      patch.draftId,
      epicId,
      "remote modal second head",
      {
        operationId: "modal-sidecar-second",
        annotations: [secondAnnotation],
        runSettings: null,
      },
    );
    const second = draftCloudDocumentSchema.parse({
      ...secondBase,
      base: { ...secondBase.base, revision: 2 },
      head: {
        ...secondBase.head,
        portable: {
          ...secondBase.head.portable,
          blobHashes: [cropHash],
        },
      },
    });
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let resolveCropRead: (reply: ReadBlobReply) => void = () => undefined;
    const cropRead = new Promise<ReadBlobReply>((resolve) => {
      resolveCropRead = resolve;
    });
    let blockCropRead = false;
    const client = ordinaryBlobClient((hash) => {
      if (hash !== cropHash) throw new Error("unexpected modal crop hash");
      if (!blockCropRead)
        return Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(imageBytes),
        });
      blockCropRead = false;
      markReadStarted();
      return cropRead;
    });
    let markSecondPrepareRefused: () => void = () => undefined;
    const secondPrepareRefused = new Promise<void>((resolve) => {
      markSecondPrepareRefused = resolve;
    });
    const realSink = createOrdinaryDraftReadSink(client);
    const sink: OrdinaryDraftReadSink = {
      ...realSink,
      async prepare(scopeId, candidate, signal) {
        const prepared = await realSink.prepare(scopeId, candidate, signal);
        if (candidate === second && prepared === null)
          markSecondPrepareRefused();
        return prepared;
      },
    };
    const { port, subscriptions } = createOrdinaryReadHarness([
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 0,
        drafts: [],
        tombstones: [],
      },
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 1,
        drafts: [first],
        tombstones: [],
      },
      {
        scopeId: SCOPE_ID,
        snapshotSeq: 2,
        drafts: [second],
        tombstones: [],
      },
    ]);
    const feed = new OrdinaryDraftReadFeed(SCOPE_ID, port, sink);
    await feed.refresh();
    const initialSubscription = subscriptions.at(0);
    if (initialSubscription === undefined)
      throw new Error("ordinary feed did not subscribe");

    useNewConversationAnnotationStore
      .getState()
      .remove(epicId, beforeArrival.annotationId);
    initialSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 1,
      draft: first,
    });
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toEqual([]);
    expect(
      useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId],
    ).toBe(true);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.content,
    ).toEqual(ordinaryText("local modal body"));

    const removedAll =
      useNewConversationAnnotationStore.getState().byEpicId[epicId] ?? [];
    settleNewConversationAnnotations(epicId, removedAll);
    initialSubscription.requestSnapshot();
    await vi.waitFor(() =>
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
          ?.content,
      ).toEqual(ordinaryText("remote modal first head")),
    );
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toEqual([firstAnnotation]);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    const settledSubscription = subscriptions.at(1);
    if (settledSubscription === undefined)
      throw new Error("settled modal feed did not subscribe");
    blockCropRead = true;
    settledSubscription.receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 2,
      draft: second,
    });
    await readStarted;

    useNewConversationModalStore
      .getState()
      .setContent(epicId, ordinaryText("temporary modal edit"));
    useNewConversationModalStore
      .getState()
      .setContent(epicId, ordinaryText("remote modal first head"));
    useNewConversationAnnotationStore
      .getState()
      .remove(epicId, firstAnnotation.annotationId);
    useNewConversationAnnotationStore.getState().add(epicId, firstAnnotation);
    resolveCropRead({ ok: true, bytesBase64: bytesToBase64(imageBytes) });
    await secondPrepareRefused;
    await vi.waitFor(async () => {
      expect(await ordinaryReadFeedBytes(cropHash)).toBeUndefined();
    });
    const changedAndRevertedPatch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
    if (changedAndRevertedPatch === undefined)
      throw new Error("modal patch disappeared");
    expect(changedAndRevertedPatch.content).toEqual(
      ordinaryText("remote modal first head"),
    );
    expect(changedAndRevertedPatch.generation).toBeGreaterThan(
      changedAndRevertedPatch.syncedGeneration,
    );
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toEqual([firstAnnotation]);
    expect(
      useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId],
    ).toBe(true);

    markNewChatPatchClean(patch.draftId, 2);
    const exactRestoredSidecar =
      useNewConversationAnnotationStore.getState().byEpicId[epicId] ?? [];
    settleNewConversationAnnotations(epicId, exactRestoredSidecar);
    settledSubscription.requestSnapshot();
    await vi.waitFor(() =>
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
          ?.content,
      ).toEqual(ordinaryText("remote modal second head")),
    );
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toEqual([secondAnnotation]);
    expect(
      useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId],
    ).toBeUndefined();
    feed.close();
  });

  it("installs the complete verified image and crop batch with its ordinary head", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const imageBytes = pngBytes(2);
    const cropBytes = pngBytes(3);
    const imageHash = await sha256Hex(imageBytes);
    const cropHash = await sha256Hex(cropBytes);
    const crop = browserCropRecord("read-feed-crop", cropHash);
    const baseEntry = ordinaryReadEntry(
      "draft-whole-upsert",
      "chat-whole-upsert",
      "verified cloud body",
      "whole-upsert",
    );
    const content = ordinaryImageContent(
      "verified cloud body",
      "read-feed-body-image",
      "read-feed-body.png",
      { hash: imageHash, size: imageBytes.byteLength },
    );
    const entry = draftCloudDocumentSchema.parse({
      ...baseEntry,
      head: {
        ...baseEntry.head,
        portable: {
          ...baseEntry.head.portable,
          content,
          blobHashes: [imageHash, cropHash],
          annotations: [crop],
        },
      },
    });
    expect(await ordinaryReadFeedBytes(imageHash)).toBeUndefined();
    expect(await ordinaryReadFeedBytes(cropHash)).toBeUndefined();
    const reads: string[] = [];
    const custody = new Map([
      [imageHash, imageBytes],
      [cropHash, cropBytes],
    ]);
    const client = ordinaryBlobClient((hash) => {
      reads.push(hash);
      const bytes = custody.get(hash);
      if (bytes === undefined)
        return Promise.resolve({ ok: false, reason: "missing" });
      return Promise.resolve({
        ok: true,
        bytesBase64: bytesToBase64(bytes),
      });
    });
    const sink = createOrdinaryDraftReadSink(client);
    const prepared = await sink.prepare(
      SCOPE_ID,
      entry,
      new AbortController().signal,
    );
    if (prepared === null) throw new Error("whole ordinary head was refused");

    await prepared.commit();

    expect(reads).toEqual([imageHash, cropHash]);
    expect(
      useComposerDraftStore.getState().drafts["chat-whole-upsert"]?.content,
    ).toEqual(content);
    expect(
      useComposerDraftStore.getState().drafts["chat-whole-upsert"]
        ?.browserAnnotations,
    ).toEqual([crop]);
    expect(Array.from((await ordinaryReadFeedBytes(imageHash)) ?? [])).toEqual(
      Array.from(imageBytes),
    );
    expect(Array.from((await ordinaryReadFeedBytes(cropHash)) ?? [])).toEqual(
      Array.from(cropBytes),
    );
    await prepared.release();
  });

  it("installs a free landing identity while keeping another open landing tab and its settings", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const settings = modernClaudeSettings(false);
    const openTabId = "draft-read-feed-open-landing";
    useLandingDraftStore.getState().createDraftWithId(openTabId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(openTabId, ordinaryText("open landing tab"), null);
    const incoming = ordinaryLandingReadEntry(
      "draft-read-feed-incoming-landing",
      "incoming landing body",
      "landing-free-destination",
      settings,
    );
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free landing head does not read blobs")),
    );
    const prepared = await createOrdinaryDraftReadSink(client).prepare(
      SCOPE_ID,
      incoming,
      new AbortController().signal,
    );
    if (prepared === null) throw new Error("free landing head was refused");

    await prepared.commit();

    const drafts = useLandingDraftStore.getState().drafts;
    const incomingDraft = drafts.find((draft) => draft.id === incoming.draftId);
    expect(drafts.map((draft) => draft.id)).toContain(openTabId);
    expect(incomingDraft?.content).toEqual(
      ordinaryText("incoming landing body"),
    );
    expect(incomingDraft?.settings).toEqual(settings);
    expect(incomingDraft?.settings?.ultracode).toBe(false);
    await prepared.release();
  });

  it("uses a free modal identity and keeps an occupied modal with an exact modern recovery", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const settings = modernClaudeSettings(false);
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free modal head does not read blobs")),
    );
    const sink = createOrdinaryDraftReadSink(client);
    const freeEpicId = "epic-read-feed-free-modal";
    const freeEntry = ordinaryNewChatReadEntry(
      "draft-read-feed-free-modal",
      freeEpicId,
      "free modal body",
      {
        operationId: "free-modal-head",
        annotations: [],
        runSettings: settings,
      },
    );
    const freePrepared = await sink.prepare(
      SCOPE_ID,
      freeEntry,
      new AbortController().signal,
    );
    if (freePrepared === null) throw new Error("free modal head was refused");
    await freePrepared.commit();

    const freePatch =
      useNewConversationModalStore.getState().draftPatchesByEpicId[freeEpicId];
    expect(freePatch?.draftId).toBe(freeEntry.draftId);
    expect(freePatch?.content).toEqual(ordinaryText("free modal body"));
    expect(freePatch?.settings).toEqual(settings);
    expect(freePatch?.settings?.ultracode).toBe(false);
    await freePrepared.release();

    const occupiedEpicId = "epic-read-feed-occupied-modal";
    const occupiedPatch = newChatPatch(occupiedEpicId);
    if (occupiedPatch.draftId === null)
      throw new Error("occupied modal has no id");
    const occupiedEntry = ordinaryNewChatReadEntry(
      "draft-read-feed-occupied-modal",
      occupiedEpicId,
      "recovery modal body",
      {
        operationId: "occupied-modal-head",
        annotations: [],
        runSettings: settings,
      },
    );
    const occupiedPrepared = await sink.prepare(
      SCOPE_ID,
      occupiedEntry,
      new AbortController().signal,
    );
    if (occupiedPrepared === null)
      throw new Error("occupied modal head was refused");
    await occupiedPrepared.commit();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        occupiedEpicId
      ]?.draftId,
    ).toBe(occupiedPatch.draftId);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        occupiedEpicId
      ]?.content,
    ).toEqual(ordinaryText("local modal body"));
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[
        occupiedEntry.draftId
      ],
    ).toEqual(occupiedEntry);
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[
        occupiedEntry.draftId
      ]?.head.portable.runSettings,
    ).toEqual(settings);
    await occupiedPrepared.release();
  });

  it("moves an older accepted recovery after a newer refused head and honors its tombstone", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-recovery-move";
    const occupiedDraftId = seedCleanComposerRow(chatId, "occupied chat body");
    const recoveryId = "draft-read-feed-recovery-move";
    const first = ordinaryReadEntryAtRevision(
      recoveryId,
      chatId,
      "first recovery body",
      { operationId: "recovery-first", revision: 1 },
    );
    const imageBytes = pngBytes(6);
    const imageHash = await sha256Hex(imageBytes);
    const secondBase = ordinaryReadEntryAtRevision(
      recoveryId,
      chatId,
      "updated recovery body",
      { operationId: "recovery-updated", revision: 2 },
    );
    const updated = draftCloudDocumentSchema.parse({
      ...secondBase,
      head: {
        ...secondBase.head,
        portable: {
          ...secondBase.head.portable,
          content: ordinaryImageContent(
            "updated recovery body",
            "recovery-image",
            "recovery.png",
            { hash: imageHash, size: imageBytes.byteLength },
          ),
          blobHashes: [imageHash],
        },
      },
    });
    const refusedBase = ordinaryReadEntryAtRevision(
      recoveryId,
      chatId,
      "unsupported newer body",
      { operationId: "recovery-refused-newer", revision: 3 },
    );
    const refusedNewer = draftCloudDocumentSchema.parse({
      ...refusedBase,
      head: {
        ...refusedBase.head,
        portable: {
          ...refusedBase.head.portable,
          runSettings: modernClaudeSettings(false),
        },
      },
    });
    const client = ordinaryBlobClient((hash) => {
      if (hash !== imageHash) throw new Error("unexpected recovery image hash");
      return Promise.resolve({
        ok: true,
        bytesBase64: bytesToBase64(imageBytes),
      });
    });
    const sink = createOrdinaryDraftReadSink(client);
    const firstPrepared = await sink.prepare(
      SCOPE_ID,
      first,
      new AbortController().signal,
    );
    if (firstPrepared === null)
      throw new Error("first recovery head was refused");
    await firstPrepared.commit();
    await firstPrepared.release();
    const updatedPrepared = await sink.prepare(
      SCOPE_ID,
      updated,
      new AbortController().signal,
    );
    if (updatedPrepared === null)
      throw new Error("updated recovery head was refused");
    await updatedPrepared.commit();
    await updatedPrepared.release();
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[recoveryId],
    ).toEqual(updated);
    expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
      occupiedDraftId,
    );

    useComposerDraftStore.setState({ ordinaryRecoveryDrafts: {} });
    await useComposerDraftStore.persist.rehydrate();
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[recoveryId],
    ).toEqual(updated);
    expect(Array.from((await ordinaryReadFeedBytes(imageHash)) ?? [])).toEqual(
      Array.from(imageBytes),
    );

    const subscriptions: Array<{
      readonly receive: (frame: OrdinaryFeedFrame) => void;
    }> = [];
    const port: OrdinaryDraftReadPort = {
      list: () =>
        Promise.resolve({
          scopeId: SCOPE_ID,
          snapshotSeq: 0,
          drafts: [],
          tombstones: [],
        }),
      subscribe: (_frontier, _signal, receive, _requestSnapshot) => {
        subscriptions.push({ receive });
      },
    };
    const peer: OrdinaryDraftPeer = {
      hostId: HOST_ID,
      scopeId: SCOPE_ID,
      client,
      read: { port },
      editingBase: (_draftId: string) => null,
      readCurrent: (
        _draftId: string,
        _signal: AbortSignal,
      ): Promise<OrdinaryDraftHeadEvidence> =>
        Promise.resolve({ kind: "absent" }),
      upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) =>
        Promise.resolve({
          status: "committed",
          current: { kind: "absent" },
        }),
      settle: (
        _snapshot: OrdinaryDraftSnapshot,
        _receipt: PlacedOrdinaryDraft,
      ) => true,
    };
    const detach = attachOrdinaryDraftPeer(peer);
    try {
      await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
      await vi.waitFor(() => {
        expect(currentOrdinaryDraftEditingBase(recoveryId)).toEqual(
          updated.base,
        );
      });
      subscriptions[0].receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 1,
        draft: refusedNewer,
      });
      await vi.waitFor(() => {
        expect(
          readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
            (base) => base.draftId === recoveryId,
          ),
        ).toMatchObject({
          base: refusedNewer.base,
          kind: "live",
          accepted: updated.base,
          ambiguous: false,
        });
      });
      subscriptions[0].receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 2,
        draft: updated,
      });
      const occupiedTombstone = ordinaryReadTombstoneAtRevision(
        occupiedDraftId,
        2,
      );
      expect(
        await sink.prepare(
          SCOPE_ID,
          occupiedTombstone,
          new AbortController().signal,
        ),
      ).toBeNull();
      useComposerDraftStore.getState().clearDraft(chatId);
      useComposerDraftStore
        .getState()
        .fenceAndDetachSubmittedDraft(chatId, occupiedDraftId, HOST_ID);
      const deletePrepared = await sink.prepare(
        SCOPE_ID,
        occupiedTombstone,
        new AbortController().signal,
      );
      if (deletePrepared === null)
        throw new Error("occupied row tombstone was refused");
      await deletePrepared.commit();
      await deletePrepared.release();

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
          recoveryId,
        );
        expect(
          useComposerDraftStore.getState().drafts[chatId]?.content,
        ).toEqual(updated.head.portable.content);
        expect(
          useComposerDraftStore.getState().ordinaryRecoveryDrafts[recoveryId],
        ).toBeUndefined();
      });
      expect(
        Array.from((await ordinaryReadFeedBytes(imageHash)) ?? []),
      ).toEqual(Array.from(imageBytes));
      expect(
        Object.values(useComposerDraftStore.getState().drafts).filter(
          (draft) => draft?.draftId === recoveryId,
        ),
      ).toHaveLength(1);
      expect(subscriptions).toHaveLength(1);
      expect(currentOrdinaryDraftEditingBase(recoveryId)).toEqual(updated.base);
      expect(
        readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
          (base) => base.draftId === recoveryId,
        ),
      ).toMatchObject({
        base: refusedNewer.base,
        kind: "live",
        accepted: updated.base,
        ambiguous: false,
      });
      const tombstone = ordinaryReadTombstoneAtRevision(recoveryId, 4);
      subscriptions[0].receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 3,
        tombstone,
      });
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().drafts[chatId]?.draftId,
        ).toBeNull();
        expect(
          readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
            (base) => base.draftId === recoveryId,
          ),
        ).toMatchObject({
          base: tombstone.base,
          kind: "tombstone",
          ambiguous: false,
        });
      });
    } finally {
      detach();
      resetDraftMirrorCoordinatorForTests();
    }
  });

  it("removes only the matching recovery when its destination composer is occupied", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-recovery-delete";
    const occupiedDraftId = seedCleanComposerRow(
      chatId,
      "keep occupied editor",
    );
    const matching = ordinaryReadEntry(
      "draft-read-feed-recovery-delete",
      chatId,
      "matching recovery",
      "matching-recovery",
    );
    const unrelated = ordinaryReadEntry(
      "draft-read-feed-recovery-unrelated",
      chatId,
      "unrelated recovery",
      "unrelated-recovery",
    );
    const sink = createOrdinaryDraftReadSink(
      ordinaryBlobClient(() =>
        Promise.reject(new Error("hash-free recovery does not read blobs")),
      ),
    );
    for (const entry of [matching, unrelated]) {
      const prepared = await sink.prepare(
        SCOPE_ID,
        entry,
        new AbortController().signal,
      );
      if (prepared === null)
        throw new Error("occupied recovery head was refused");
      await prepared.commit();
      await prepared.release();
    }

    const tombstone = await sink.prepare(
      SCOPE_ID,
      ordinaryReadTombstoneAtRevision(matching.draftId, 2),
      new AbortController().signal,
    );
    if (tombstone === null)
      throw new Error("matching recovery tombstone was refused");
    await tombstone.commit();

    expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
      occupiedDraftId,
    );
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      ordinaryText("keep occupied editor"),
    );
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[matching.draftId],
    ).toBeUndefined();
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[
        unrelated.draftId
      ],
    ).toEqual(unrelated);
    await tombstone.release();
  });

  it("clears a clean modal patch and its sidecar together on an ordinary tombstone", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const epicId = "epic-read-feed-modal-tombstone";
    const draftId = "draft-clean-modal-tombstone";
    const sidecar = canvasNote("modal-tombstone-sidecar");
    const sink = createOrdinaryDraftReadSink(
      ordinaryBlobClient(() =>
        Promise.reject(new Error("hash-free modal does not read blobs")),
      ),
    );
    const live = await sink.prepare(
      SCOPE_ID,
      ordinaryNewChatReadEntry(draftId, epicId, "modal before delete", {
        operationId: "modal-before-delete",
        annotations: [sidecar],
        runSettings: null,
      }),
      new AbortController().signal,
    );
    if (live === null) throw new Error("live modal refused");
    await live.commit();
    await live.release();
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toEqual([sidecar]);
    const prepared = await sink.prepare(
      SCOPE_ID,
      ordinaryReadTombstoneAtRevision(draftId, 2),
      new AbortController().signal,
    );
    if (prepared === null) throw new Error("clean modal tombstone was refused");

    await prepared.commit();

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId],
    ).toBeUndefined();
    expect(
      useNewConversationAnnotationStore.getState().byEpicId[epicId],
    ).toBeUndefined();
    expect(
      useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId],
    ).toBeUndefined();
    await prepared.release();
  });

  it("applies an ordinary tombstone to the matching composer row", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-tombstone";
    const draftId = "draft-ordinary-chat-tombstone";
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free rows do not read blobs")),
    );
    const sink = createOrdinaryDraftReadSink(client);
    const live = await sink.prepare(
      SCOPE_ID,
      ordinaryReadEntry(draftId, chatId, "ordinary body", "chat-before-delete"),
      new AbortController().signal,
    );
    if (live === null) throw new Error("ordinary chat refused");
    await live.commit();
    await live.release();
    const prepared = await createOrdinaryDraftReadSink(client).prepare(
      SCOPE_ID,
      ordinaryReadTombstoneAtRevision(draftId, 2),
      new AbortController().signal,
    );
    if (prepared === null) throw new Error("ordinary tombstone was refused");

    await prepared.commit();

    expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBeNull();
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[draftId],
    ).toBeUndefined();
    await prepared.release();
  });

  it("flushes a debounced landing edit before it classifies a tombstone", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const initial = ordinaryLandingReadEntry(
      "landing-with-pending-keystroke",
      "before local edit",
      "before-local-edit",
      null,
    );
    const harness = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [initial], tombstones: [] },
    ]);
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("text only")),
    );
    const feed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      harness.port,
      createOrdinaryDraftReadSink(client),
    );
    feed.bindPeer(HOST_ID);
    try {
      await feed.refresh();
      const runtime = draftRuntimeRegistry.getOrHydrate(initial.draftId);
      if (runtime === null)
        throw new Error("ordinary landing editor was not created");
      const edit = ordinaryText("debounced local edit");
      runtime.setSnapshot(edit, null);
      const content = () =>
        useLandingDraftStore
          .getState()
          .drafts.find(({ id }) => id === initial.draftId)?.content;
      expect(content()).toEqual(initial.head.portable.content);
      harness.subscriptions[0].receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 2,
        tombstone: ordinaryReadTombstoneAtRevision(initial.draftId, 2),
      });
      await vi.waitFor(async () => {
        expect(await ordinaryReadFeedRow(initial.draftId)).toMatchObject({
          pending: { reason: "held" },
          editor: { dirty: true, value: { value: { content: edit } } },
        });
      });
      expect(content()).toEqual(edit);
    } finally {
      feed.close();
    }
  });

  it("retries a refused ordinary modal sidecar removal against the same editor row", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const epicId = "epic-retry-sidecar";
    const sidecar = canvasNote("retry-sidecar");
    const initial = ordinaryNewChatReadEntry(
      "draft-retry-sidecar",
      epicId,
      "modal body",
      {
        operationId: "sidecar-before-removal",
        annotations: [sidecar],
        runSettings: null,
      },
    );
    const harness = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [initial], tombstones: [] },
    ]);
    const feed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      harness.port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() => Promise.reject(new Error("no crop"))),
      ),
    );
    await feed.refresh();
    const saved = await ordinaryReadFeedRow(initial.draftId);
    expect(saved?.editor?.value).toMatchObject({
      sidecar: { records: [sidecar], dirty: false },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const write = vi.spyOn(ordinaryDraftScope, "saveOrdinaryDraftEditor");
    write.mockRejectedValueOnce(new Error("temporary storage refusal"));
    try {
      useNewConversationAnnotationStore
        .getState()
        .remove(epicId, sidecar.annotationId);
      const partition = await ordinaryReadFeedPartition();
      await waitForOrdinaryDraftEditorWrite(partition, initial.draftId);
      expect(
        (await ordinaryReadFeedRow(initial.draftId))?.editor?.value,
      ).toMatchObject({ sidecar: { records: [sidecar], dirty: false } });
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForOrdinaryDraftEditorWrite(partition, initial.draftId);
      expect(
        (await ordinaryReadFeedRow(initial.draftId))?.editor,
      ).toMatchObject({
        dirty: true,
        value: { sidecar: { records: [], dirty: true } },
      });
    } finally {
      feed.close();
      write.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not project a whole upsert when the peer refuses its blob", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-refused";
    const draftId = seedCleanComposerRow(chatId, "keep local body");
    const imageBytes = pngBytes(4);
    const imageHash = await sha256Hex(imageBytes);
    const baseEntry = ordinaryReadEntry(
      draftId,
      chatId,
      "unavailable cloud body",
      "refused-upsert",
    );
    const entry: DraftCloudDocument = {
      ...baseEntry,
      head: {
        ...baseEntry.head,
        portable: {
          ...baseEntry.head.portable,
          content: ordinaryImageContent(
            "unavailable cloud body",
            "read-feed-refused-image",
            "read-feed-refused.png",
            { hash: imageHash, size: imageBytes.byteLength },
          ),
          blobHashes: [imageHash],
        },
      },
    };
    const reads: string[] = [];
    const client = ordinaryBlobClient((hash) => {
      reads.push(hash);
      return Promise.resolve({ ok: false, reason: "missing" });
    });
    const prepared = await createOrdinaryDraftReadSink(client).prepare(
      SCOPE_ID,
      entry,
      new AbortController().signal,
    );

    expect(prepared).toBeNull();
    expect(reads).toEqual([imageHash]);
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      ordinaryText("keep local body"),
    );
  });

  it("keeps an occupied composer and records the complete ordinary recovery head", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-read-feed-occupied";
    const currentDraftId = seedCleanComposerRow(chatId, "current local line");
    const incoming = ordinaryReadEntry(
      "draft-occupied-cloud-line",
      chatId,
      "incoming cloud line",
      "occupied-head",
    );
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free recovery does not read blobs")),
    );
    const prepared = await createOrdinaryDraftReadSink(client).prepare(
      SCOPE_ID,
      incoming,
      new AbortController().signal,
    );
    if (prepared === null) throw new Error("occupied head was refused");

    await prepared.commit();

    expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
      currentDraftId,
    );
    expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
      ordinaryText("current local line"),
    );
    expect(
      useComposerDraftStore.getState().ordinaryRecoveryDrafts[incoming.draftId],
    ).toEqual(incoming);
    await prepared.release();
  });

  it("does not subscribe or prepare a snapshot from another private scope", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const entry = ordinaryReadEntry(
      "draft-wrong-scope",
      "chat-wrong-scope",
      "wrong scope body",
      "wrong-scope",
    );
    const { port, subscriptions } = createOrdinaryReadHarness([
      {
        scopeId: "scp_wrongordinaryscope00001",
        snapshotSeq: 7,
        drafts: [entry],
        tombstones: [ordinaryReadTombstone("draft-wrong-scope-deleted")],
      },
    ]);
    let prepared = 0;
    const sink: OrdinaryDraftReadSink = {
      localOccurrence: () => null,
      prepare: () => {
        prepared += 1;
        return Promise.resolve(null);
      },
    };
    const feed = new OrdinaryDraftReadFeed(SCOPE_ID, port, sink);

    await feed.refresh();

    expect(subscriptions).toEqual([]);
    expect(prepared).toBe(0);
    feed.close();
  });
});

describe("ordinary draft placement evidence ordering", () => {
  it.each([
    { evidenceSource: "readCurrent" as const },
    { evidenceSource: "conflict" as const },
  ])(
    "$evidenceSource fences an older prepared read before it can replace the editor",
    async ({ evidenceSource }) => {
      resetDraftMirrorCoordinatorForTests();
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const chatId = `chat-h2-${evidenceSource}`;
      const draftId = seedCleanComposerRow(chatId, "locally accepted body");
      const imageBytes = pngBytes(21);
      const imageHash = await sha256Hex(imageBytes);
      const oldBase = ordinaryReadEntry(
        draftId,
        chatId,
        "older feed body",
        `older-feed-${evidenceSource}`,
      );
      const oldEntry = draftCloudDocumentSchema.parse({
        ...oldBase,
        head: {
          ...oldBase.head,
          portable: {
            ...oldBase.head.portable,
            content: ordinaryImageContent(
              "older feed body",
              `h2-crop-${evidenceSource}`,
              "older.png",
              { hash: imageHash, size: imageBytes.byteLength },
            ),
            blobHashes: [imageHash],
            annotations: [
              browserCropRecord(`h2-crop-${evidenceSource}`, imageHash),
            ],
          },
        },
      });
      const newerLive = ordinaryReadEntryAtRevision(
        draftId,
        chatId,
        "newer cloud body",
        {
          operationId: `newer-read-current-${evidenceSource}`,
          revision: 2,
        },
      );
      let markReadStarted: () => void = () => undefined;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const client = ordinaryBlobClient((hash) => {
        expect(hash).toBe(imageHash);
        markReadStarted();
        return Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(imageBytes),
        });
      });
      const realSink = createOrdinaryDraftReadSink(client);
      let finishOlderPrepare: () => void = () => undefined;
      const olderPrepareGate = new Promise<void>((resolve) => {
        finishOlderPrepare = resolve;
      });
      let markOlderPrepared: () => void = () => undefined;
      const olderPrepared = new Promise<void>((resolve) => {
        markOlderPrepared = resolve;
      });
      let markOlderReleased: () => void = () => undefined;
      const olderReleased = new Promise<void>((resolve) => {
        markOlderReleased = resolve;
      });
      const sink: OrdinaryDraftReadSink = {
        ...realSink,
        async prepare(scopeId, entry, signal) {
          const prepared = await realSink.prepare(scopeId, entry, signal);
          if (prepared === null || entry !== oldEntry) return prepared;
          markOlderPrepared();
          await olderPrepareGate;
          return {
            ...prepared,
            async release() {
              await prepared.release();
              markOlderReleased();
            },
          };
        },
      };
      const { port, subscriptions } = createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
      ]);
      let readCurrentCalls = 0;
      let upsertCalls = 0;
      const conflictTombstone = ordinaryReadTombstoneAtRevision(draftId, 2);
      const peer: OrdinaryDraftPeer = {
        hostId: `host-h2-${evidenceSource}`,
        scopeId: SCOPE_ID,
        client,
        read: { port },
        editingBase: (_draftId: string) => oldBase.base,
        readCurrent: (_draftId: string, _signal: AbortSignal) => {
          readCurrentCalls += 1;
          return Promise.resolve(
            evidenceSource === "readCurrent"
              ? {
                  kind: "live",
                  draft: {
                    base: newerLive.base,
                    operationId: newerLive.operationId,
                  },
                }
              : {
                  kind: "live",
                  draft: {
                    base: oldEntry.base,
                    operationId: oldEntry.operationId,
                  },
                },
          );
        },
        upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) => {
          upsertCalls += 1;
          return Promise.resolve({
            status: "conflict",
            current: {
              kind: "tombstone",
              tombstone: { base: conflictTombstone.base },
            },
          });
        },
        settle: (
          _snapshot: OrdinaryDraftSnapshot,
          _receipt: PlacedOrdinaryDraft,
        ) => true,
      };
      const detach = attachOrdinaryDraftPeerSession(peer, sink);
      try {
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        subscriptions[0].receive({
          kind: "upsert",
          hasBinaryPayload: false,
          seq: 1,
          draft: oldEntry,
        });
        await readStarted;
        await olderPrepared;
        expect(await ordinaryReadFeedBytes(imageHash)).toBeDefined();
        const snapshot = captureOrdinaryDraftSnapshot(draftId);
        if (snapshot === null)
          throw new Error("local placement snapshot was absent");
        expect(snapshot.base).toEqual(oldBase.base);

        const placement = await placeOrdinaryDraft(
          snapshot,
          `placement-${evidenceSource}`,
        );

        expect(placement).toEqual({ status: "unsettled" });
        expect(readCurrentCalls).toBe(1);
        expect(upsertCalls).toBe(evidenceSource === "readCurrent" ? 0 : 1);
        finishOlderPrepare();
        await olderReleased;
        await vi.waitFor(async () => {
          expect(await ordinaryReadFeedBytes(imageHash)).toBeUndefined();
        });
        expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
          draftId,
        );
        expect(
          useComposerDraftStore.getState().drafts[chatId]?.content,
        ).toEqual(ordinaryText("locally accepted body"));
      } finally {
        finishOlderPrepare();
        detach();
        resetDraftMirrorCoordinatorForTests();
      }
    },
  );

  it.each([{ kind: "live" as const }, { kind: "tombstone" as const }])(
    "uses complete $kind readCurrent evidence as the current result",
    async ({ kind }) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const chatId = `chat-complete-current-${kind}`;
      const draftId = "draft-current-" + kind;
      const previous = ordinaryReadEntry(
        draftId,
        chatId,
        "previous accepted body",
        "previous-accepted-operation",
      );
      const client = ordinaryPlacementBlobClient(() =>
        Promise.reject(new Error("hash-free placement does not read blobs")),
      );
      const { port, subscriptions } = createOrdinaryReadHarness([
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [previous],
          tombstones: [],
        },
      ]);
      let current: OrdinaryDraftHeadEvidence | null = null;
      let readCurrentCalls = 0;
      let upsertCalls = 0;
      const peer: OrdinaryDraftPeer = {
        hostId: `host-complete-current-${kind}`,
        scopeId: SCOPE_ID,
        client,
        read: { port },
        editingBase: (_draftId: string) => previous.base,
        readCurrent: (_draftId: string, _signal: AbortSignal) => {
          readCurrentCalls += 1;
          if (current === null)
            return Promise.reject(new Error("current head was not prepared"));
          return Promise.resolve(current);
        },
        upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) => {
          upsertCalls += 1;
          return Promise.resolve({
            status: "committed",
            current: { kind: "absent" },
          });
        },
        settle: (
          _snapshot: OrdinaryDraftSnapshot,
          _receipt: PlacedOrdinaryDraft,
        ) => true,
      };
      const detach = attachOrdinaryDraftPeer(peer);
      try {
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        const snapshot = captureOrdinaryDraftSnapshot(draftId);
        if (snapshot === null)
          throw new Error("local placement snapshot was absent");
        const operationId = `exact-current-${kind}`;
        if (kind === "live") {
          const entry = ordinaryReadEntryForWrite(
            snapshot.write,
            operationId,
            2,
          );
          current = {
            kind: "live",
            draft: {
              base: entry.base,
              operationId: entry.operationId,
              entry,
            },
          };
          const placement = await placeOrdinaryDraft(snapshot, operationId);
          expect(placement).toEqual({
            status: "placed",
            draftId,
            operationId,
            base: entry.base,
          });
          expect(readCurrentCalls).toBe(2);
          expect(
            useComposerDraftStore.getState().drafts[chatId]?.content,
          ).toEqual(snapshot.write.portable.content);
        } else {
          const entry = ordinaryReadTombstoneAtRevision(draftId, 2);
          current = {
            kind: "tombstone",
            tombstone: { base: entry.base, entry },
          };
          expect(await placeOrdinaryDraft(snapshot, operationId)).toEqual({
            status: "unsettled",
          });
          await vi.waitFor(() =>
            expect(
              useComposerDraftStore.getState().drafts[chatId]?.draftId,
            ).toBeNull(),
          );
          expect(readCurrentCalls).toBe(1);
          expect(
            readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases,
          ).toContainEqual(
            expect.objectContaining({
              draftId,
              base: entry.base,
              kind: "tombstone",
              operationId: entry.operationId,
              ambiguous: false,
            }),
          );
        }
        expect(upsertCalls).toBe(0);
      } finally {
        detach();
        resetDraftMirrorCoordinatorForTests();
      }
    },
  );

  it("projects the host-local workspace from the complete live conflict", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const draftId = "draft-live-conflict-workspace";
    const store = useLandingDraftStore.getState();
    store.createDraftWithId(draftId, null);
    store.setDraftContent(draftId, ordinaryText("local landing body"), null);
    const local = useLandingDraftStore
      .getState()
      .drafts.find((row) => row.id === draftId);
    if (local === undefined) throw new Error("landing draft was not created");
    landingDraftRememberSynced(draftId, 1, local.generation, HOST_ID);
    const folder = "/test/workspaces/accepted";
    const workspace = {
      folders: [folder],
      folderInfoByPath: {
        [folder]: {
          path: folder,
          name: "accepted",
          repoIdentifier: null,
          hostId: HOST_ID,
        },
      },
      primaryPath: folder,
    };
    const previous = ordinaryLandingReadEntry(
      draftId,
      "winner",
      "winning-conflict",
      null,
    );
    const winner = draftCloudDocumentSchema.parse({
      ...previous,
      base: { ...previous.base, revision: 2 },
      head: {
        ...previous.head,
        hostLocal: { hostId: HOST_ID, workspace },
      },
    });
    const harness = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
    ]);
    const peer: OrdinaryDraftPeer = {
      hostId: HOST_ID,
      scopeId: SCOPE_ID,
      client: ordinaryPlacementBlobClient(() =>
        Promise.reject(new Error("text only")),
      ),
      read: { port: harness.port },
      editingBase: () => null,
      readCurrent: () => Promise.resolve({ kind: "absent" }),
      upsert: () =>
        Promise.resolve({
          status: "conflict",
          current: {
            kind: "live",
            draft: {
              base: winner.base,
              operationId: winner.operationId,
              entry: winner,
            },
          },
        }),
      settle: () => false,
    };
    const detach = attachOrdinaryDraftPeer(peer);
    try {
      await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(1));
      const snapshot = captureOrdinaryDraftSnapshot(draftId);
      if (snapshot === null)
        throw new Error("landing placement could not be captured");
      expect(await placeOrdinaryDraft(snapshot, "local-operation")).toEqual({
        status: "unsettled",
      });
      await vi.waitFor(() => {
        const row = useLandingDraftStore
          .getState()
          .drafts.find((candidate) => candidate.id === draftId);
        expect(row?.content).toEqual(winner.head.portable.content);
        expect(row?.workspace).toEqual(workspace);
      });
      expect((await ordinaryReadFeedRow(draftId))?.acceptedEntry).toEqual(
        winner,
      );
    } finally {
      detach();
    }
  });

  it.each(["live", "tombstone", "ambiguous"])(
    "does not upsert when $0 supersedes the placement base during blob confirmation",
    async (winner) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const chatId = "chat-placement-newer-during-blob";
      const imageBytes = pngBytes(24);
      const imageHash = await sha256Hex(imageBytes);
      expect(await putImage(imageBytes)).toBe(imageHash);
      const content = ordinaryImageContent(
        "local body with image",
        "placement-race-image",
        "placement-race.png",
        { hash: imageHash, size: imageBytes.byteLength },
      );
      const draftId = seedCleanComposerRowWithContent(chatId, content);
      const previous = ordinaryReadEntry(
        draftId,
        chatId,
        "previous accepted body",
        "placement-race-previous",
      );
      const newer = ordinaryReadEntryAtRevision(
        draftId,
        chatId,
        "newer peer body",
        {
          operationId: "placement-race-newer",
          revision: winner === "ambiguous" ? 1 : 2,
        },
      );
      const tombstone = ordinaryReadTombstoneAtRevision(draftId, 2);
      let markBlobReadStarted: () => void = () => undefined;
      const blobReadStarted = new Promise<void>((resolve) => {
        markBlobReadStarted = resolve;
      });
      let resolveBlobRead: (reply: ReadBlobReply) => void = () => undefined;
      const pendingBlobRead = new Promise<ReadBlobReply>((resolve) => {
        resolveBlobRead = resolve;
      });
      let upsertCalls = 0;
      let readCurrentCalls = 0;
      const client = ordinaryPlacementBlobClient((hash) => {
        if (hash !== imageHash) throw new Error("unexpected placement hash");
        markBlobReadStarted();
        return pendingBlobRead;
      });
      const { port, subscriptions } = createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
      ]);
      const peer: OrdinaryDraftPeer = {
        hostId: "host-placement-newer-during-blob",
        scopeId: SCOPE_ID,
        client,
        read: { port },
        editingBase: (_draftId: string) => previous.base,
        readCurrent: (_draftId: string, _signal: AbortSignal) => {
          readCurrentCalls += 1;
          return Promise.resolve({
            kind: "live",
            draft: {
              base: previous.base,
              operationId: previous.operationId,
              entry: previous,
            },
          });
        },
        upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) => {
          upsertCalls += 1;
          return Promise.resolve({
            status: "committed",
            current: { kind: "absent" },
          });
        },
        settle: (
          _snapshot: OrdinaryDraftSnapshot,
          _receipt: PlacedOrdinaryDraft,
        ) => true,
      };
      const detach = attachOrdinaryDraftPeer(peer);
      try {
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        const snapshot = captureOrdinaryDraftSnapshot(draftId);
        if (snapshot === null)
          throw new Error("local placement snapshot was absent");
        const placementPromise = placeOrdinaryDraft(
          snapshot,
          "placement-race-local-operation",
        );
        await blobReadStarted;
        subscriptions[0].receive(
          winner === "tombstone"
            ? { kind: "delete", hasBinaryPayload: false, seq: 1, tombstone }
            : { kind: "upsert", hasBinaryPayload: false, seq: 1, draft: newer },
        );
        await vi.waitFor(async () => {
          const row = await ordinaryReadFeedRow(draftId);
          if (winner === "live") expect(row?.acceptedEntry).toEqual(newer);
          else if (winner === "tombstone")
            expect(row?.evidence).toMatchObject({
              kind: "tombstone",
              base: tombstone.base,
            });
          else expect(row?.evidence?.ambiguous).toBe(true);
        });
        resolveBlobRead({ ok: true, bytesBase64: bytesToBase64(imageBytes) });

        expect(await placementPromise).toEqual({ status: "unsettled" });
        expect(readCurrentCalls).toBe(1);
        expect(upsertCalls).toBe(0);
        expect(await ordinaryReadFeedBytes(imageHash)).toBeUndefined();
        if (winner === "live")
          expect(
            useComposerDraftStore.getState().drafts[chatId]?.content,
          ).toEqual(newer.head.portable.content);
      } finally {
        resolveBlobRead({ ok: false, reason: "missing" });
        detach();
        resetDraftMirrorCoordinatorForTests();
      }
    },
  );

  it.each([{ mismatch: "mime" as const }, { mismatch: "size" as const }])(
    "refuses a declared $mismatch mismatch on both intake and recovery",
    async ({ mismatch }) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const imageBytes = pngBytes(mismatch === "mime" ? 25 : 26);
      const imageHash = await sha256Hex(imageBytes);
      const content = ordinaryImageContentWithDeclaration({
        text: `reject ${mismatch} mismatch`,
        imageId: `read-feed-${mismatch}-image`,
        fileName: `${mismatch}.png`,
        imageHash,
        mimeType: mismatch === "mime" ? "image/jpeg" : "image/png",
        size: imageBytes.byteLength + (mismatch === "size" ? 1 : 0),
      });
      const base = ordinaryReadEntry(
        `draft-read-feed-${mismatch}-mismatch`,
        `chat-read-feed-${mismatch}-mismatch`,
        `reject ${mismatch} mismatch`,
        `reject-${mismatch}-mismatch`,
      );
      const entry = draftCloudDocumentSchema.parse({
        ...base,
        head: {
          ...base.head,
          portable: {
            ...base.head.portable,
            content,
            blobHashes: [imageHash],
          },
        },
      });
      const reads: string[] = [];
      const client = ordinaryBlobClient((hash) => {
        reads.push(hash);
        if (hash !== imageHash)
          return Promise.reject(new Error("unexpected mismatch hash"));
        return Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(imageBytes),
        });
      });
      const { port, subscriptions } = createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
      ]);
      const peer: OrdinaryDraftPeer = {
        hostId: `host-read-feed-${mismatch}-mismatch`,
        scopeId: SCOPE_ID,
        client,
        read: { port },
        editingBase: (_draftId: string) => null,
        readCurrent: (_draftId: string, _signal: AbortSignal) =>
          Promise.resolve({ kind: "absent" }),
        upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) =>
          Promise.resolve({
            status: "committed",
            current: { kind: "absent" },
          }),
        settle: (
          _snapshot: OrdinaryDraftSnapshot,
          _receipt: PlacedOrdinaryDraft,
        ) => true,
      };
      const detach = attachOrdinaryDraftPeer(peer);
      try {
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        const prepared = await createOrdinaryDraftReadSink(client).prepare(
          SCOPE_ID,
          entry,
          new AbortController().signal,
        );

        expect(prepared).toBeNull();
        expect(reads).toEqual([imageHash]);
        expect(
          await readOrdinaryDraftBytes(
            await ordinaryReadFeedPartition(),
            imageHash,
          ),
        ).toBeUndefined();
        expect(
          useComposerDraftStore.getState().ordinaryRecoveryDrafts[
            entry.draftId
          ],
        ).toBeUndefined();

        // Seed the inconsistent recovery body directly. Normal intake above
        // cannot create it, so this exercises the independent move verifier.
        const binding = currentOrdinaryDraftScopeBinding();
        const projection = ordinaryDraftScope.currentOrdinaryScopeProjection(
          "read-feed-owner",
          SCOPE_ID,
        );
        if (binding === null || projection === null)
          throw new Error("ordinary scope unavailable");
        const { partition } = projection.scope;
        await stageOrdinaryDraftBytes({
          partition,
          stageId: "recovery-declaration-check",
          images: new Map([[imageHash, imageBytes]]),
        });
        const [recovery] = await ordinaryDraftScope.publishOrdinaryDraftEntries(
          {
            projection,
            cursor: null,
            signal: new AbortController().signal,
            entries: [
              {
                entry,
                expectedEditor: null,
                isEligible: () => true,
                stageId: "recovery-declaration-check",
                editor: null,
                refused: false,
                resolved: null,
              },
            ],
          },
        );
        const log = vi.spyOn(appLogger, "debug");
        try {
          showCommittedOrdinaryDraftRows(binding, [recovery]);
          await vi.waitFor(() =>
            expect(log).toHaveBeenCalledWith(
              "[draft-mirror] ordinary recovery image refused",
              {
                code: "ordinary-draft-recovery-image-refused",
                draftId: entry.draftId,
              },
            ),
          );
          expect(await ordinaryReadFeedRow(entry.draftId)).toMatchObject({
            accepted: entry.base,
            recovery: entry,
            editor: null,
            roots: [imageHash],
          });
          expect(
            Array.from(
              (await readRootedOrdinaryDraftBytes(partition, imageHash)) ?? [],
            ),
          ).toEqual(Array.from(imageBytes));
        } finally {
          log.mockRestore();
        }
      } finally {
        detach();
        resetDraftMirrorCoordinatorForTests();
      }
    },
  );
});

describe("ordinary draft tombstone and revival ordering", () => {
  it.each([
    { surface: "landing" as const, order: "tombstone-first" as const },
    { surface: "landing" as const, order: "revival-first" as const },
    { surface: "modal" as const, order: "tombstone-first" as const },
    { surface: "modal" as const, order: "revival-first" as const },
  ])(
    "keeps same-ID $surface revival when $order arrives",
    async ({ surface, order }) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const suffix = `${surface}-${order}`;
      const epicId = `epic-revival-${suffix}`;
      const draftId = `draft-revival-${suffix}`;
      const baseEntry =
        surface === "landing"
          ? ordinaryLandingReadEntry(
              draftId,
              "before revival",
              `revived-${suffix}`,
              null,
            )
          : ordinaryNewChatReadEntry(draftId, epicId, "before revival", {
              operationId: `revived-${suffix}`,
              annotations: [],
              runSettings: null,
            });
      const revival = draftCloudDocumentSchema.parse({
        ...baseEntry,
        base: { ...baseEntry.base, revision: 3 },
        head: {
          ...baseEntry.head,
          portable: {
            ...baseEntry.head.portable,
            content: ordinaryText(`revived ${surface} body`),
          },
        },
      });
      const tombstone = ordinaryReadTombstoneAtRevision(draftId, 2);
      const { port, subscriptions } = createOrdinaryReadHarness([
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 0,
          drafts: [baseEntry],
          tombstones: [],
        },
      ]);
      const feed = new OrdinaryDraftReadFeed(
        SCOPE_ID,
        port,
        createOrdinaryDraftReadSink(
          ordinaryBlobClient(() =>
            Promise.reject(new Error("hash-free revival does not read blobs")),
          ),
        ),
      );
      try {
        await feed.refresh();
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        const subscription = subscriptions[0];
        const deleteFrame: OrdinaryFeedFrame = {
          kind: "delete",
          hasBinaryPayload: false,
          seq: order === "tombstone-first" ? 1 : 2,
          tombstone,
        };
        const reviveFrame: OrdinaryFeedFrame = {
          kind: "upsert",
          hasBinaryPayload: false,
          seq: order === "tombstone-first" ? 2 : 1,
          draft: revival,
        };
        if (order === "tombstone-first") {
          subscription.receive(deleteFrame);
          await vi.waitFor(() => {
            if (surface === "landing") {
              expect(
                useLandingDraftStore
                  .getState()
                  .drafts.find((row) => row.id === draftId),
              ).toBeUndefined();
            } else {
              expect(
                useNewConversationModalStore.getState().draftPatchesByEpicId[
                  epicId
                ],
              ).toBeUndefined();
            }
          });
          subscription.receive(reviveFrame);
        } else {
          subscription.receive(reviveFrame);
          await vi.waitFor(() => {
            if (surface === "landing") {
              expect(
                useLandingDraftStore
                  .getState()
                  .drafts.find((row) => row.id === draftId)?.content,
              ).toEqual(ordinaryText("revived landing body"));
            } else {
              expect(
                useNewConversationModalStore.getState().draftPatchesByEpicId[
                  epicId
                ]?.content,
              ).toEqual(ordinaryText("revived modal body"));
            }
          });
          subscription.receive(deleteFrame);
        }
        await vi.waitFor(() => {
          if (surface === "landing") {
            expect(
              useLandingDraftStore
                .getState()
                .drafts.find((row) => row.id === draftId)?.content,
            ).toEqual(ordinaryText("revived landing body"));
          } else {
            expect(
              useNewConversationModalStore.getState().draftPatchesByEpicId[
                epicId
              ]?.draftId,
            ).toBe(draftId);
            expect(
              useNewConversationModalStore.getState().draftPatchesByEpicId[
                epicId
              ]?.content,
            ).toEqual(ordinaryText("revived modal body"));
          }
        });
        expect(
          readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
            (base) => base.draftId === draftId,
          ),
        ).toMatchObject({
          base: revival.base,
          kind: "live",
          accepted: revival.base,
          ambiguous: false,
        });
      } finally {
        feed.close();
      }
    },
  );
});

describe("ordinary draft peer reconnect ordering", () => {
  it("keeps peer A's cursor and head across A→B→A and replays only on the current feed", async () => {
    resetDraftMirrorCoordinatorForTests();
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const draftId = "draft-reconnect-a-b-a";
    const firstBase = ordinaryLandingReadEntry(
      draftId,
      "peer A accepted body",
      "peer-a-first",
      null,
    );
    const firstEntry: DraftCloudDocument = {
      ...firstBase,
      base: { ...firstBase.base, revision: 3 },
    };
    const resumedBase = ordinaryLandingReadEntry(
      draftId,
      "peer A resumed body",
      "peer-a-resumed",
      null,
    );
    const resumedEntry: DraftCloudDocument = {
      ...resumedBase,
      base: { ...resumedBase.base, revision: 4 },
    };
    const olderTombstone = ordinaryReadTombstoneAtRevision(draftId, 2);
    const retiredPeerTombstone = ordinaryReadTombstoneAtRevision(draftId, 4);
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free reconnect does not read blobs")),
    );
    const sink = createOrdinaryDraftReadSink(client);
    const makePeer = (
      hostId: string,
      snapshot: OrdinaryFeedSnapshot,
    ): {
      readonly peer: OrdinaryDraftPeer;
      readonly subscriptions: OrdinaryReadSubscription[];
    } => {
      const { port, subscriptions } = createOrdinaryReadHarness([snapshot]);
      return {
        subscriptions,
        peer: {
          hostId,
          scopeId: SCOPE_ID,
          client,
          read: { port },
          editingBase: (_draftId: string) => firstEntry.base,
          readCurrent: (_draftId: string, _signal: AbortSignal) =>
            Promise.resolve({ kind: "absent" }),
          upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) =>
            Promise.resolve({
              status: "committed",
              current: { kind: "absent" },
            }),
          settle: (
            _snapshot: OrdinaryDraftSnapshot,
            _receipt: PlacedOrdinaryDraft,
          ) => true,
        },
      };
    };
    const firstA = makePeer("host-a", {
      scopeId: SCOPE_ID,
      snapshotSeq: 80,
      drafts: [firstEntry],
      tombstones: [],
    });
    const peerB = makePeer("host-b", {
      scopeId: SCOPE_ID,
      snapshotSeq: 1,
      drafts: [],
      tombstones: [olderTombstone],
    });
    const resumedA = makePeer("host-a", {
      scopeId: SCOPE_ID,
      snapshotSeq: 2,
      drafts: [],
      tombstones: [olderTombstone],
    });
    let detachFirstA: (() => void) | null = null;
    let detachB: (() => void) | null = null;
    let detachResumedA: (() => void) | null = null;
    try {
      detachFirstA = attachOrdinaryDraftPeerSession(firstA.peer, sink);
      await vi.waitFor(() => expect(firstA.subscriptions).toHaveLength(1));
      await vi.waitFor(() => {
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((row) => row.id === draftId)?.content,
        ).toEqual(ordinaryText("peer A accepted body"));
      });
      expect(firstA.subscriptions[0].frontier).toEqual({
        scopeId: SCOPE_ID,
        afterSeq: 80,
      });

      detachB = attachOrdinaryDraftPeerSession(peerB.peer, sink);
      await vi.waitFor(() => expect(peerB.subscriptions).toHaveLength(1));
      expect(peerB.subscriptions[0].frontier).toEqual({
        scopeId: SCOPE_ID,
        afterSeq: 1,
      });
      firstA.subscriptions[0].receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 81,
        draft: resumedEntry,
      });
      expect(
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content,
      ).toEqual(ordinaryText("peer A accepted body"));

      detachResumedA = attachOrdinaryDraftPeerSession(resumedA.peer, sink);
      await vi.waitFor(() => expect(resumedA.subscriptions).toHaveLength(1));
      expect(resumedA.subscriptions[0].frontier).toEqual({
        scopeId: SCOPE_ID,
        afterSeq: 80,
      });
      peerB.subscriptions[0].receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 2,
        tombstone: retiredPeerTombstone,
      });
      resumedA.subscriptions[0].receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 80,
        tombstone: retiredPeerTombstone,
      });
      expect(
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content,
      ).toEqual(ordinaryText("peer A accepted body"));

      resumedA.subscriptions[0].receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 81,
        draft: resumedEntry,
      });
      await vi.waitFor(() => {
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((row) => row.id === draftId)?.content,
        ).toEqual(ordinaryText("peer A resumed body"));
      });
      expect(
        readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
          (base) => base.draftId === draftId,
        ),
      ).toMatchObject({
        base: resumedEntry.base,
        kind: "live",
        accepted: resumedEntry.base,
        ambiguous: false,
      });
    } finally {
      detachResumedA?.();
      detachB?.();
      detachFirstA?.();
      resetDraftMirrorCoordinatorForTests();
    }
  });
});

describe("ordinary released-list tail ordering", () => {
  it.each([
    { tailTiming: "before-list-return" as const },
    { tailTiming: "during-first-image-prepare" as const },
    { tailTiming: "after-list-completion" as const },
  ])(
    "retains both list rows and the unrelated tail when it arrives $tailTiming",
    async ({ tailTiming }) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const suffix = tailTiming;
      const imageBytes = pngBytes(32);
      const imageHash = await sha256Hex(imageBytes);
      const imageId = `draft-r2-image-${suffix}`;
      const missedId = `draft-r2-missed-${suffix}`;
      const tailId = `draft-r2-tail-${suffix}`;
      const imageBase = ordinaryLandingReadEntry(
        imageId,
        "reconnected image row",
        `r2-image-${suffix}`,
        null,
      );
      const imageEntry = draftCloudDocumentSchema.parse({
        ...imageBase,
        head: {
          ...imageBase.head,
          portable: {
            ...imageBase.head.portable,
            content: ordinaryImageContent(
              "reconnected image row",
              `r2-image-atom-${suffix}`,
              "reconnected.png",
              { hash: imageHash, size: imageBytes.byteLength },
            ),
            blobHashes: [imageHash],
          },
        },
      });
      const missedEntry = ordinaryLandingReadEntry(
        missedId,
        "reconnected missed row",
        `r2-missed-${suffix}`,
        null,
      );
      const tailEntry = ordinaryLandingReadEntry(
        tailId,
        "unrelated newer tail",
        `r2-tail-${suffix}`,
        null,
      );
      const reconnectSnapshot: OrdinaryFeedSnapshot = {
        scopeId: SCOPE_ID,
        snapshotSeq: 11,
        drafts: [imageEntry, missedEntry],
        tombstones: [],
      };
      let resolveReconnectList: (snapshot: OrdinaryFeedSnapshot) => void = () =>
        undefined;
      const reconnectList = new Promise<OrdinaryFeedSnapshot>((resolve) => {
        resolveReconnectList = resolve;
      });
      let markReconnectListStarted: () => void = () => undefined;
      const reconnectListStarted = new Promise<void>((resolve) => {
        markReconnectListStarted = resolve;
      });
      let listCalls = 0;
      const subscriptions: OrdinaryReadSubscription[] = [];
      const port: OrdinaryDraftReadPort = {
        list: (_signal) => {
          listCalls += 1;
          if (listCalls === 1) {
            return Promise.resolve({
              scopeId: SCOPE_ID,
              snapshotSeq: 10,
              drafts: [],
              tombstones: [],
            });
          }
          markReconnectListStarted();
          return tailTiming === "before-list-return"
            ? reconnectList
            : Promise.resolve(reconnectSnapshot);
        },
        subscribe: (frontier, _signal, receive, requestSnapshot) => {
          subscriptions.push({ frontier, receive, requestSnapshot });
        },
      };
      let markImageReadStarted: () => void = () => undefined;
      const imageReadStarted = new Promise<void>((resolve) => {
        markImageReadStarted = resolve;
      });
      let resolveImageRead: (reply: ReadBlobReply) => void = () => undefined;
      const pendingImageRead = new Promise<ReadBlobReply>((resolve) => {
        resolveImageRead = resolve;
      });
      const client = ordinaryBlobClient((hash) => {
        if (hash !== imageHash) throw new Error("unexpected R2 image hash");
        markImageReadStarted();
        return tailTiming === "during-first-image-prepare"
          ? pendingImageRead
          : Promise.resolve({
              ok: true,
              bytesBase64: bytesToBase64(imageBytes),
            });
      });
      const feed = new OrdinaryDraftReadFeed(
        SCOPE_ID,
        port,
        createOrdinaryDraftReadSink(client),
      );
      const rowContent = (draftId: string) =>
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content;
      try {
        await feed.refresh();
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        const oldSubscription = subscriptions[0];
        oldSubscription.requestSnapshot();
        await reconnectListStarted;
        const frame: OrdinaryFeedFrame = {
          kind: "upsert",
          hasBinaryPayload: false,
          seq: 12,
          draft: tailEntry,
        };
        if (tailTiming === "before-list-return") {
          oldSubscription.receive(frame);
          resolveReconnectList(reconnectSnapshot);
        } else if (tailTiming === "during-first-image-prepare") {
          await imageReadStarted;
          oldSubscription.receive(frame);
          const partition = await ordinaryReadFeedPartition();
          const during = await readOrdinaryDraftPartition(partition);
          expect(during.rows.map(({ draftId }) => draftId)).toEqual([]);
          expect(rowContent(missedId)).toBeUndefined();
          resolveImageRead({
            ok: true,
            bytesBase64: bytesToBase64(imageBytes),
          });
        }
        await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
        const currentSubscription = subscriptions[1];
        expect(currentSubscription.frontier).toEqual({
          scopeId: SCOPE_ID,
          afterSeq: 11,
        });
        expect(rowContent(imageId)).toEqual(imageEntry.head.portable.content);
        expect(rowContent(tailId)).toBeUndefined();
        currentSubscription.receive(frame);
        await vi.waitFor(async () => {
          expect(rowContent(imageId)).toEqual(imageEntry.head.portable.content);
          expect(rowContent(missedId)).toEqual(
            ordinaryText("reconnected missed row"),
          );
          expect(rowContent(tailId)).toEqual(
            ordinaryText("unrelated newer tail"),
          );
          expect(
            Array.from((await ordinaryReadFeedBytes(imageHash)) ?? []),
          ).toEqual(Array.from(imageBytes));
        });
      } finally {
        feed.close();
      }
    },
  );
});

describe("ordinary same-revision disagreement ordering", () => {
  it.each([
    { disagreement: "live/live" as const },
    { disagreement: "live/tombstone" as const },
  ])(
    "holds a projected row for $disagreement disagreement until the fresh list resolves it",
    async ({ disagreement }) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const draftId = `draft-h1-${disagreement}`;
      const firstBase = ordinaryLandingReadEntry(
        draftId,
        "first accepted body",
        "same-operation",
        null,
      );
      const firstEntry: DraftCloudDocument = {
        ...firstBase,
        base: { ...firstBase.base, revision: 5 },
      };
      const contenderBase = ordinaryLandingReadEntry(
        draftId,
        "divergent live body",
        "same-operation",
        null,
      );
      const contender: DraftCloudDocument = {
        ...contenderBase,
        base: { ...contenderBase.base, revision: 5 },
      };
      const tombstone: DraftCloudTombstone = {
        draftId,
        base: firstEntry.base,
        operationId: "same-revision-delete",
      };
      const authoritative: OrdinaryFeedSnapshot =
        disagreement === "live/live"
          ? {
              scopeId: SCOPE_ID,
              snapshotSeq: 3,
              drafts: [contender],
              tombstones: [],
            }
          : {
              scopeId: SCOPE_ID,
              snapshotSeq: 3,
              drafts: [],
              tombstones: [tombstone],
            };
      let resolveFreshList: (snapshot: OrdinaryFeedSnapshot) => void = () =>
        undefined;
      const freshList = new Promise<OrdinaryFeedSnapshot>((resolve) => {
        resolveFreshList = resolve;
      });
      let markFreshListStarted: () => void = () => undefined;
      const freshListStarted = new Promise<void>((resolve) => {
        markFreshListStarted = resolve;
      });
      let listCalls = 0;
      const subscriptions: OrdinaryReadSubscription[] = [];
      const port: OrdinaryDraftReadPort = {
        list: (_signal) => {
          listCalls += 1;
          if (listCalls === 1) {
            return Promise.resolve({
              scopeId: SCOPE_ID,
              snapshotSeq: 1,
              drafts: [firstEntry],
              tombstones: [],
            });
          }
          markFreshListStarted();
          return freshList;
        },
        subscribe: (frontier, _signal, receive, requestSnapshot) => {
          subscriptions.push({ frontier, receive, requestSnapshot });
        },
      };
      const feed = new OrdinaryDraftReadFeed(
        SCOPE_ID,
        port,
        createOrdinaryDraftReadSink(
          ordinaryBlobClient(() =>
            Promise.reject(
              new Error("hash-free ambiguity does not read blobs"),
            ),
          ),
        ),
      );
      const rowContent = () =>
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content;
      try {
        await feed.refresh();
        await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
        await vi.waitFor(() =>
          expect(rowContent()).toEqual(ordinaryText("first accepted body")),
        );
        const conflictSubscription = subscriptions[0];
        if (disagreement === "live/live") {
          conflictSubscription.receive({
            kind: "upsert",
            hasBinaryPayload: false,
            seq: 2,
            draft: contender,
          });
        } else {
          conflictSubscription.receive({
            kind: "delete",
            hasBinaryPayload: false,
            seq: 2,
            tombstone,
          });
        }
        await freshListStarted;
        await vi.waitFor(async () => {
          expect(
            (await ordinaryReadFeedRow(draftId))?.evidence?.ambiguous,
          ).toBe(true);
        });
        expect(rowContent()).toEqual(ordinaryText("first accepted body"));
        expect(
          readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
            (base) => base.draftId === draftId,
          ),
        ).toMatchObject({
          base: firstEntry.base,
          kind: "live",
          operationId: firstEntry.operationId,
          accepted: firstEntry.base,
          ambiguous: true,
        });

        resolveFreshList(authoritative);
        await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
        if (disagreement === "live/live") {
          await vi.waitFor(() =>
            expect(rowContent()).toEqual(ordinaryText("divergent live body")),
          );
        } else {
          await vi.waitFor(() => expect(rowContent()).toBeUndefined());
        }
        expect(
          readWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID)?.bases.find(
            (base) => base.draftId === draftId,
          ),
        ).toMatchObject({
          base: firstEntry.base,
          kind: disagreement === "live/live" ? "live" : "tombstone",
          operationId:
            disagreement === "live/live"
              ? contender.operationId
              : tombstone.operationId,
          accepted: firstEntry.base,
          ambiguous: false,
        });
      } finally {
        feed.close();
      }
    },
  );
});

describe("ordinary list conflict ordering", () => {
  it.each(["exact-first", "list-first"])(
    "asks for an authoritative list after a same-revision conflict in the %s order",
    async (order) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const listed = ordinaryLandingReadEntry(
        "list-conflict",
        "listed body",
        "same-op",
        null,
      );
      const exact = ordinaryLandingReadEntry(
        "list-conflict",
        "exact body",
        "same-op",
        null,
      );
      const initialStarted = Promise.withResolvers<void>();
      const firstList = Promise.withResolvers<DraftsListResponseV30>();
      const freshStarted = Promise.withResolvers<void>();
      const freshList = Promise.withResolvers<DraftsListResponseV30>();
      let lists = 0;
      const subscribed = Promise.withResolvers<void>();
      const response = {
        scopeId: SCOPE_ID,
        snapshotSeq: 3,
        drafts: [listed],
        tombstones: [],
      };
      const feed = new OrdinaryDraftReadFeed(
        SCOPE_ID,
        {
          list() {
            lists += 1;
            if (lists === 1) {
              initialStarted.resolve();
              return firstList.promise;
            }
            freshStarted.resolve();
            return freshList.promise;
          },
          subscribe() {
            if (lists === 2) subscribed.resolve();
          },
        },
        createOrdinaryDraftReadSink(
          ordinaryBlobClient(() =>
            Promise.reject(new Error("hash-free conflict fixture")),
          ),
        ),
      );
      feed.bindPeer(HOST_ID);
      const firstRefresh = feed.refresh();
      await initialStarted.promise;
      try {
        if (order === "list-first") {
          firstList.resolve(response);
          await firstRefresh;
        }
        await feed.rememberPlacementEvidence(exact.draftId, {
          kind: "live",
          draft: {
            base: exact.base,
            operationId: exact.operationId,
            entry: exact,
          },
        });
        if (order === "exact-first") firstList.resolve(response);
        await freshStarted.promise;
        expect(
          (await ordinaryReadFeedRow(listed.draftId))?.evidence?.ambiguous,
        ).toBe(true);
        freshList.resolve(response);
        await subscribed.promise;
        expect(await ordinaryReadFeedRow(listed.draftId)).toMatchObject({
          evidence: { ambiguous: false },
          pending: null,
          acceptedEntry: listed,
        });
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find(({ id }) => id === listed.draftId)?.content,
        ).toEqual(listed.head.portable.content);
        expect(lists).toBe(2);
      } finally {
        feed.close();
      }
    },
  );
});

describe("ordinary draft restart persistence", () => {
  it("restores same-base ambiguity before a fresh list resolves the head", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const draftId = "draft-restarted-same-base-divergence";
    const firstBase = ordinaryLandingReadEntry(
      draftId,
      "accepted before restart",
      "same-operation-after-restart",
      null,
    );
    const firstEntry: DraftCloudDocument = {
      ...firstBase,
      base: { ...firstBase.base, revision: 5 },
    };
    const contenderBase = ordinaryLandingReadEntry(
      draftId,
      "resolved after restart",
      "same-operation-after-restart",
      null,
    );
    const contender: DraftCloudDocument = {
      ...contenderBase,
      base: { ...contenderBase.base, revision: 5 },
    };
    let resolveFirstRefresh: (snapshot: OrdinaryFeedSnapshot) => void = () =>
      undefined;
    const firstRefresh = new Promise<OrdinaryFeedSnapshot>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    let markFirstRefreshStarted: () => void = () => undefined;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    let firstListCalls = 0;
    const firstSubscriptions: OrdinaryReadSubscription[] = [];
    const firstPort: OrdinaryDraftReadPort = {
      list: (_signal) => {
        firstListCalls += 1;
        if (firstListCalls === 1)
          return Promise.resolve({
            scopeId: SCOPE_ID,
            snapshotSeq: 1,
            drafts: [firstEntry],
            tombstones: [],
          });
        markFirstRefreshStarted();
        return firstRefresh;
      },
      subscribe: (frontier, _signal, receive, requestSnapshot) => {
        firstSubscriptions.push({ frontier, receive, requestSnapshot });
      },
    };
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free restart does not read blobs")),
    );
    const firstFeed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      firstPort,
      createOrdinaryDraftReadSink(client),
    );
    try {
      await firstFeed.refresh();
      await vi.waitFor(() => expect(firstSubscriptions).toHaveLength(1));
      await vi.waitFor(() =>
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((row) => row.id === draftId)?.content,
        ).toEqual(ordinaryText("accepted before restart")),
      );
      firstSubscriptions[0].receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 2,
        draft: contender,
      });
      await firstRefreshStarted;
      await vi.waitFor(async () => {
        expect((await ordinaryReadFeedRow(draftId))?.evidence?.ambiguous).toBe(
          true,
        );
      });
      expect(
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content,
      ).toEqual(ordinaryText("accepted before restart"));
    } finally {
      firstFeed.close();
      resolveFirstRefresh({
        scopeId: SCOPE_ID,
        snapshotSeq: 1,
        drafts: [firstEntry],
        tombstones: [],
      });
    }

    resetDraftMirrorCoordinatorForTests();
    let resolveRestartedList: (snapshot: OrdinaryFeedSnapshot) => void = () =>
      undefined;
    const restartedList = new Promise<OrdinaryFeedSnapshot>((resolve) => {
      resolveRestartedList = resolve;
    });
    let markRestartedListStarted: () => void = () => undefined;
    const restartedListStarted = new Promise<void>((resolve) => {
      markRestartedListStarted = resolve;
    });
    const restartedSubscriptions: OrdinaryReadSubscription[] = [];
    const restartedPort: OrdinaryDraftReadPort = {
      list: (_signal) => {
        markRestartedListStarted();
        return restartedList;
      },
      subscribe: (frontier, _signal, receive, requestSnapshot) => {
        restartedSubscriptions.push({ frontier, receive, requestSnapshot });
      },
    };
    const restartedFeed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      restartedPort,
      createOrdinaryDraftReadSink(client),
    );
    try {
      const refresh = restartedFeed.refresh();
      await restartedListStarted;
      await vi.waitFor(async () => {
        expect((await ordinaryReadFeedRow(draftId))?.evidence?.ambiguous).toBe(
          true,
        );
      });
      expect(
        useLandingDraftStore.getState().drafts.find((row) => row.id === draftId)
          ?.content,
      ).toEqual(ordinaryText("accepted before restart"));

      resolveRestartedList({
        scopeId: SCOPE_ID,
        snapshotSeq: 3,
        drafts: [contender],
        tombstones: [],
      });
      await refresh;
      await vi.waitFor(() => expect(restartedSubscriptions).toHaveLength(1));
      await vi.waitFor(() =>
        expect(
          useLandingDraftStore
            .getState()
            .drafts.find((row) => row.id === draftId)?.content,
        ).toEqual(ordinaryText("resolved after restart")),
      );
      await vi.waitFor(async () => {
        const row = await ordinaryReadFeedRow(draftId);
        expect(row?.evidence?.base).toEqual(contender.base);
        expect(row?.evidence?.kind).toBe("live");
        expect(typeof row?.evidence?.identity).toBe("string");
        expect(row?.evidence?.ambiguous).toBe(false);
      });
    } finally {
      restartedFeed.close();
      resetDraftMirrorCoordinatorForTests();
    }
  });

  it("restores an original chat head under a dirty released occupant", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const chatId = "chat-original-id-occupied-restore";
    const draftId = "draft-original-id-occupied-restore";
    const entry = ordinaryReadEntryAtRevision(
      draftId,
      chatId,
      "original accepted body",
      { operationId: "original-accepted-head", revision: 1 },
    );
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("hash-free restore does not read blobs")),
    );
    const { port, subscriptions } = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [entry], tombstones: [] },
    ]);
    const originalFeed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      port,
      createOrdinaryDraftReadSink(client),
    );
    await originalFeed.refresh();
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
        draftId,
      ),
    );
    await vi.waitFor(async () => {
      expect((await ordinaryReadFeedRow(draftId))?.editor).toMatchObject({
        surface: "chat",
        slot: chatId,
        dirty: false,
      });
    });
    originalFeed.close();

    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    useComposerDraftStore.setState({ drafts: {}, ordinaryRecoveryDrafts: {} });
    useComposerDraftStore
      .getState()
      .setSnapshot(chatId, ordinaryText("dirty released occupant"), null);
    useComposerDraftStore.getState().bindTarget(chatId, "epic-read-feed");
    const occupantId = useComposerDraftStore.getState().drafts[chatId]?.draftId;
    if (occupantId === null || occupantId === undefined)
      throw new Error("released occupant had no identity");
    expect(composerDraftIsDirty(occupantId)).toBe(true);

    resetDraftMirrorCoordinatorForTests();
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const { port: restartedPort, subscriptions: restartedSubscriptions } =
      createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 2, drafts: [entry], tombstones: [] },
      ]);
    const peer: OrdinaryDraftPeer = {
      hostId: "host-original-id-occupied-restore",
      scopeId: SCOPE_ID,
      client,
      read: { port: restartedPort },
      editingBase: (_draftId: string) => entry.base,
      readCurrent: (_draftId: string, _signal: AbortSignal) =>
        Promise.resolve({ kind: "absent" }),
      upsert: (_request: OrdinaryDraftUpsert, _signal: AbortSignal) =>
        Promise.resolve({
          status: "committed",
          current: { kind: "absent" },
        }),
      settle: (
        _snapshot: OrdinaryDraftSnapshot,
        _receipt: PlacedOrdinaryDraft,
      ) => true,
    };
    const detach = attachOrdinaryDraftPeer(peer);
    try {
      await vi.waitFor(() => expect(restartedSubscriptions).toHaveLength(1));
      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
          occupantId,
        );
        expect(
          useComposerDraftStore.getState().drafts[chatId]?.content,
        ).toEqual(ordinaryText("dirty released occupant"));
        expect(
          useComposerDraftStore.getState().ordinaryRecoveryDrafts[draftId],
        ).toEqual(entry);
      });
      await useComposerDraftStore.persist.rehydrate();
      expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
        occupantId,
      );
      expect(useComposerDraftStore.getState().drafts[chatId]?.content).toEqual(
        ordinaryText("dirty released occupant"),
      );
      expect(
        useComposerDraftStore.getState().ordinaryRecoveryDrafts[draftId],
      ).toEqual(entry);
      await vi.waitFor(async () => {
        expect(await ordinaryReadFeedRow(draftId)).toMatchObject({
          accepted: entry.base,
          editor: { surface: "chat", slot: chatId },
          recovery: entry,
        });
      });
    } finally {
      detach();
      resetDraftMirrorCoordinatorForTests();
    }
  });
});

describe("atomic ordinary snapshots", () => {
  it("replays a snapshot after stopping between rows and restores its landing editor offline", async () => {
    const auth = {
      status: "signed-in" as const,
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    };
    useAuthStore.setState(auth);
    const first = ordinaryLandingReadEntry(
      "atomic-first",
      "first landing body",
      "atomic-first",
      null,
    );
    const secondBase = ordinaryLandingReadEntry(
      "atomic-second",
      "second landing body",
      "atomic-second",
      null,
    );
    const bytes = pngBytes(42);
    const hash = await sha256Hex(bytes);
    const second = draftCloudDocumentSchema.parse({
      ...secondBase,
      head: {
        ...secondBase.head,
        portable: {
          ...secondBase.head.portable,
          content: ordinaryImageContent(
            "second landing body",
            "atomic-image",
            "atomic.png",
            {
              hash,
              size: bytes.byteLength,
            },
          ),
          blobHashes: [hash],
        },
      },
    });
    const snapshot = {
      scopeId: SCOPE_ID,
      snapshotSeq: 7,
      drafts: [first, second],
      tombstones: [],
    };
    const downloadStarted = Promise.withResolvers<void>();
    const download = Promise.withResolvers<ReadBlobReply>();
    const interrupted = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      createOrdinaryReadHarness([snapshot]).port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() => {
          downloadStarted.resolve();
          return download.promise;
        }),
      ),
    );
    interrupted.bindPeer(HOST_ID);
    const refreshing = interrupted.refresh();
    await downloadStarted.promise;
    const partition = await ordinaryReadFeedPartition();
    const before = await readOrdinaryDraftPartition(partition);
    expect(before).toEqual({ rows: [], cursors: [] });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    interrupted.close();
    const blob = { ok: true as const, bytesBase64: bytesToBase64(bytes) };
    download.resolve(blob);
    await refreshing;
    expect(await readOrdinaryDraftPartition(partition)).toEqual(before);

    resetDraftMirrorCoordinatorForTests();
    const replay = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      createOrdinaryReadHarness([snapshot]).port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() => Promise.resolve(blob)),
      ),
    );
    replay.bindPeer(HOST_ID);
    await replay.refresh();
    replay.close();
    const committed = await readOrdinaryDraftPartition(partition);
    expect(committed.cursors).toEqual([{ partition, peerId: HOST_ID, seq: 7 }]);
    expect(
      committed.rows
        .map((row) => ({
          draftId: row.draftId,
          recovery: row.recovery,
          surface: row.editor?.surface,
          slot: row.editor?.slot,
        }))
        .sort((a, b) => a.draftId.localeCompare(b.draftId)),
    ).toEqual(
      [first, second].map(({ draftId }) => ({
        draftId,
        recovery: null,
        surface: "landing",
        slot: draftId,
      })),
    );

    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    resetDraftMirrorCoordinatorForTests();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    useAuthStore.setState(auth);
    await loadWindowOrdinaryDraftScope("read-feed-owner", SCOPE_ID);
    bindOrdinaryDraftRecoveryScope(SCOPE_ID);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.map(({ id, content }) => ({ id, content })),
    ).toEqual(
      expect.arrayContaining(
        [first, second].map((entry) => ({
          id: entry.draftId,
          content: entry.head.portable.content,
        })),
      ),
    );
    expect(Array.from((await ordinaryReadFeedBytes(hash)) ?? [])).toEqual(
      Array.from(bytes),
    );
  });

  it("reopens an unfinished equal-base image entry at its durable tail cursor", async () => {
    const auth = {
      status: "signed-in" as const,
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    };
    useAuthStore.setState(auth);
    const base = ordinaryLandingReadEntry(
      "bare-then-complete",
      "equal head",
      "matching-op",
      null,
    );
    const bytes = pngBytes(34);
    const hash = await sha256Hex(bytes);
    const complete = draftCloudDocumentSchema.parse({
      ...base,
      head: {
        ...base.head,
        portable: {
          ...base.head.portable,
          content: ordinaryImageContent(
            "equal head",
            "unfinished-image",
            "unfinished.png",
            {
              hash,
              size: bytes.byteLength,
            },
          ),
          blobHashes: [hash],
        },
      },
    });
    const first = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 3, drafts: [], tombstones: [] },
    ]);
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<ReadBlobReply>();
    const feed = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      first.port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() => {
          started.resolve();
          return reply.promise;
        }),
      ),
    );
    feed.bindPeer(HOST_ID);
    await feed.refresh();
    expect(
      await feed.rememberPlacementEvidence(base.draftId, {
        kind: "live",
        draft: { base: base.base, operationId: base.operationId },
      }),
    ).toBe(true);
    expect(
      (await ordinaryReadFeedRow(base.draftId))?.evidence?.identity,
    ).toBeNull();
    first.subscriptions[0].receive({
      kind: "upsert",
      hasBinaryPayload: false,
      seq: 4,
      draft: complete,
    });
    await started.promise;
    const partition = await ordinaryReadFeedPartition();
    const before = await readOrdinaryDraftPartition(partition);
    expect(before.cursors).toEqual([{ partition, peerId: HOST_ID, seq: 4 }]);
    expect(before.rows[0]).toMatchObject({
      editor: null,
      pending: { entry: complete, reason: "held" },
    });
    feed.close();
    const blob = { ok: true as const, bytesBase64: bytesToBase64(bytes) };
    reply.resolve(blob);
    resetDraftMirrorCoordinatorForTests();
    const resumed = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 4, drafts: [], tombstones: [] },
    ]);
    const replay = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      resumed.port,
      createOrdinaryDraftReadSink(
        ordinaryBlobClient(() => Promise.resolve(blob)),
      ),
    );
    replay.bindPeer(HOST_ID);
    try {
      await replay.refresh();
      expect(resumed.subscriptions[0].frontier.afterSeq).toBe(4);
      await vi.waitFor(async () => {
        expect(await ordinaryReadFeedRow(complete.draftId)).toMatchObject({
          editor: { surface: "landing", slot: complete.draftId },
          pending: null,
          roots: [hash],
        });
      });
      expect(
        useLandingDraftStore
          .getState()
          .drafts.find(({ id }) => id === complete.draftId)?.content,
      ).toEqual(complete.head.portable.content);
    } finally {
      replay.close();
    }
  });

  it("refuses a lower snapshot with an unseen row across A to B to A", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "read-feed-owner", username: "reader" },
    });
    const original = ordinaryLandingReadEntry(
      "cursor-original",
      "accepted",
      "cursor-original",
      null,
    );
    const unseen = ordinaryLandingReadEntry(
      "cursor-never-seen",
      "stale unpublished row",
      "cursor-never-seen",
      null,
    );
    const client = ordinaryBlobClient(() =>
      Promise.reject(new Error("text only")),
    );
    const sink = createOrdinaryDraftReadSink(client);
    const sourceA = createOrdinaryReadHarness([
      { scopeId: SCOPE_ID, snapshotSeq: 3, drafts: [original], tombstones: [] },
      { scopeId: SCOPE_ID, snapshotSeq: 4, drafts: [unseen], tombstones: [] },
    ]);
    const a = new OrdinaryDraftReadFeed(SCOPE_ID, sourceA.port, sink);
    a.bindPeer("peer-a");
    await a.refresh();
    a.close();
    const b = new OrdinaryDraftReadFeed(
      SCOPE_ID,
      createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [], tombstones: [] },
      ]).port,
      sink,
    );
    b.bindPeer("peer-b");
    b.inherit(a, "peer-a", "peer-b");
    await b.refresh();
    b.close();
    const partition = await ordinaryReadFeedPartition();
    // Another connection has accepted an empty snapshot at 8 while A's module
    // still holds 3. Use real IDB requests and the package's unmodified factory.
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(ORDINARY_DRAFT_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("second database connection refused"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = connection.transaction("cursors", "readwrite");
        tx.objectStore("cursors").put({ partition, peerId: "peer-a", seq: 8 });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error("second connection write refused"));
      });
    } finally {
      connection.close();
    }

    const returnedA = new OrdinaryDraftReadFeed(SCOPE_ID, sourceA.port, sink);
    returnedA.bindPeer("peer-a");
    returnedA.inherit(b, "peer-b", "peer-a");
    try {
      await returnedA.refresh();
      expect(sourceA.subscriptions.at(-1)?.frontier).toEqual({
        scopeId: SCOPE_ID,
        afterSeq: 8,
      });
      expect(await ordinaryReadFeedRow(unseen.draftId)).toBeUndefined();
      expect(
        useLandingDraftStore.getState().drafts.map(({ id }) => id),
      ).toEqual([original.draftId]);
    } finally {
      returnedA.close();
    }
  });
});

describe("ordinary candidate release eligibility", () => {
  it.each(["before-release", "during-release"])(
    "retries a withheld candidate when the editor frees %s",
    async (timing) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "read-feed-owner", username: "reader" },
      });
      const harness = createOrdinaryReadHarness([
        { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
      ]);
      const firstStarted = Promise.withResolvers<void>();
      const finishFirstPrepare = Promise.withResolvers<void>();
      const releasing = Promise.withResolvers<void>();
      const finishRelease = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<string>();
      let eligibility: string | undefined = "original";
      let attempts = 0;
      const feed = new OrdinaryDraftReadFeed(SCOPE_ID, harness.port, {
        localOccurrence: () => eligibility,
        async prepare(_scopeId, entry) {
          attempts += 1;
          if (attempts > 1) {
            return {
              commit: () => committed.resolve(entry.draftId),
              release() {},
            };
          }
          eligibility = undefined;
          firstStarted.resolve();
          await finishFirstPrepare.promise;
          return {
            commit() {
              throw new Error("superseded editor cannot commit");
            },
            release() {
              releasing.resolve();
              return finishRelease.promise;
            },
          };
        },
      });
      try {
        await feed.refresh();
        const draft = ordinaryLandingReadEntry(
          "eligibility-race",
          "body",
          "candidate",
          null,
        );
        harness.subscriptions[0].receive({
          kind: "upsert",
          hasBinaryPayload: false,
          seq: 1,
          draft,
        });
        await firstStarted.promise;
        const free = () => {
          eligibility = "freed";
          feed.retryEligible();
        };
        if (timing === "before-release") free();
        finishFirstPrepare.resolve();
        await releasing.promise;
        if (timing === "during-release") free();
        finishRelease.resolve();
        expect(await committed.promise).toBe(draft.draftId);
        expect(attempts).toBe(2);
      } finally {
        feed.close();
      }
    },
  );
});
