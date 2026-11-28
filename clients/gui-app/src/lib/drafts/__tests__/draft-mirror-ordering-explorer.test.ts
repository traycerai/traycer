import "fake-indexeddb/auto";
import * as ordinaryDraftDb from "@/lib/drafts/ordinary-draft-db";
import * as ordinaryDraftScope from "@/lib/drafts/ordinary-draft-scope";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DraftCloudDocument,
  DraftCloudTombstone,
  DraftsListResponseV30,
  DraftsSubscribeServerFrameV20,
} from "@traycer/protocol/host";
import { draftCloudDocumentSchema } from "@traycer/protocol/host/drafts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachOrdinaryDraftPeer,
  captureOrdinaryDraftSnapshot,
  placeOrdinaryDraft,
  resetDraftMirrorCoordinatorForTests,
  settleOrdinaryDraftIfCurrent,
  type OrdinaryDraftPeer,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  ORDINARY_DRAFT_DB_NAME,
  resolveOrdinaryDraftScope,
  type OrdinaryDraftPartition,
  type OrdinaryDraftRow,
} from "@/lib/drafts/ordinary-draft-db";
import {
  type OrdinaryDraftHeadEvidence,
  type OrdinaryDraftReadPort,
  type OrdinaryDraftSnapshot,
} from "@/lib/drafts/draft-mirror-session";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import * as composerDraftStore from "@/stores/composer/composer-draft-store";
import {
  ordinaryDraftEditorWriteIsPending,
  setOrdinaryDraftScopeBinding,
  waitForOrdinaryDraftEditorWrite,
} from "@/stores/composer/composer-canvas-persistence";
import {
  deleteDatabaseWhenClosed,
  installFreshIndexedDb,
} from "@/lib/composer/__tests__/fake-idb";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

const OWNER_ID = "ordering-explorer-owner";
const HOST_ID = "ordering-explorer-peer";
const SCOPE_ID = "scp_orderingexplorerscope00001";

type ReadFrame = DraftsSubscribeServerFrameV20;

interface ReadSubscription {
  readonly frontier: { readonly scopeId: string; readonly afterSeq: number };
  readonly signal: AbortSignal;
  readonly receive: (frame: ReadFrame) => void;
  readonly requestSnapshot: () => void;
}

interface SubscriptionTracker {
  readonly subscriptions: ReadSubscription[];
  readonly notify: (subscription: ReadSubscription) => void;
  readonly waitFor: (
    predicate: (subscription: ReadSubscription) => boolean,
  ) => Promise<ReadSubscription>;
}

function subscriptionTracker(): SubscriptionTracker {
  const subscriptions: ReadSubscription[] = [];
  const waiters: Array<{
    readonly predicate: (subscription: ReadSubscription) => boolean;
    readonly resolve: (subscription: ReadSubscription) => void;
  }> = [];
  return {
    subscriptions,
    notify(subscription) {
      subscriptions.push(subscription);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(subscription)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(subscription);
      }
    },
    waitFor(predicate) {
      const existing = subscriptions.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      const signal = Promise.withResolvers<ReadSubscription>();
      waiters.push({ predicate, resolve: signal.resolve });
      return signal.promise;
    },
  };
}

function documentContent(text: string): JsonContent {
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
              id: "ordering-image",
              fileName: "ordering.png",
              mimeType: "image/png",
              size,
              b64content: null,
              hash,
              byHashEligible: true,
            },
          },
        ],
      },
    ],
  };
}

function landingEntry(input: {
  readonly draftId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly content: JsonContent;
  readonly blobHashes?: readonly string[];
}): DraftCloudDocument {
  const { draftId, revision, operationId, content, blobHashes = [] } = input;
  return draftCloudDocumentSchema.parse({
    draftId,
    base: {
      headSha256: String(revision).repeat(64),
      ownerEpoch: 1,
      revision,
    },
    operationId,
    head: {
      dialect: "draft/v1",
      lastTouchedAt: revision,
      target: { epicId: null, chatId: null, blockId: null },
      hostLocal: { hostId: HOST_ID, workspace: null },
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: "landing",
      portable: {
        content,
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [...blobHashes],
        closed: false,
        annotations: [],
      },
    },
  });
}

function composerEntry(input: {
  readonly draftId: string;
  readonly chatId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly text: string;
  readonly content?: JsonContent;
  readonly blobHashes?: readonly string[];
}): DraftCloudDocument {
  return draftCloudDocumentSchema.parse({
    draftId: input.draftId,
    base: {
      headSha256: String(input.revision).repeat(64),
      ownerEpoch: 1,
      revision: input.revision,
    },
    operationId: input.operationId,
    head: {
      dialect: "draft/v1",
      lastTouchedAt: input.revision,
      target: {
        epicId: "epic-ordering-explorer",
        chatId: input.chatId,
        blockId: null,
      },
      hostLocal: { hostId: HOST_ID, workspace: null },
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: "chat-composer",
      portable: {
        content: input.content ?? documentContent(input.text),
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [...(input.blobHashes ?? [])],
        closed: false,
        annotations: [],
      },
    },
  });
}

function tombstone(draftId: string, revision: number): DraftCloudTombstone {
  return {
    draftId,
    base: {
      headSha256: "b".repeat(64),
      ownerEpoch: 1,
      revision,
    },
    operationId: `delete-${revision}`,
  };
}

function pngBytes(tag: number): Uint8Array<ArrayBuffer> {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=";
  const decoded = atob(encoded);
  const png = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Uint8Array([...png, tag]);
}

function readHash(params: unknown): string {
  if (
    typeof params !== "object" ||
    params === null ||
    !("sha256" in params) ||
    typeof params.sha256 !== "string"
  )
    throw new Error("blob request omitted its digest");
  return params.sha256;
}

function blobClient(
  respond: (
    hash: string,
    signal: AbortSignal | undefined,
  ) => Promise<
    | { readonly ok: true; readonly bytesBase64: string }
    | {
        readonly ok: false;
        readonly reason: "missing";
      }
  >,
): DraftBlobClient {
  const request = (async (method: string, params: unknown) => {
    if (method !== "drafts.readBlob")
      throw new Error(`unexpected blob request ${method}`);
    return respond(readHash(params), undefined);
  }) as DraftBlobClient["request"];
  const requestWithOptions = (async (
    method: string,
    params: unknown,
    options: { readonly signal: AbortSignal | undefined },
  ) => {
    if (method !== "drafts.readBlob")
      throw new Error(`unexpected blob request ${method}`);
    return respond(readHash(params), options.signal);
  }) as DraftBlobClient["requestWithOptions"];
  return { request, requestWithOptions };
}

interface AttachedPeer {
  readonly subscriptions: ReadSubscription[];
  readonly waitForSubscription: SubscriptionTracker["waitFor"];
  readonly detach: () => void;
}

function attachPeer(input: {
  readonly snapshots: readonly DraftsListResponseV30[];
  readonly client: DraftBlobClient;
  readonly beforeList?: (snapshot: DraftsListResponseV30) => Promise<void>;
  readonly onSubscribe?: (subscription: ReadSubscription) => void;
  readonly peerOverrides?: Partial<
    Omit<OrdinaryDraftPeer, "hostId" | "scopeId" | "client" | "read">
  >;
}): AttachedPeer {
  const snapshots = [...input.snapshots];
  const tracker = subscriptionTracker();
  const port: OrdinaryDraftReadPort = {
    list: async (_signal) => {
      const snapshot = snapshots.shift();
      if (snapshot === undefined) throw new Error("snapshot script exhausted");
      await input.beforeList?.(snapshot);
      return snapshot;
    },
    subscribe: (frontier, signal, receive, requestSnapshot) => {
      const subscription = { frontier, signal, receive, requestSnapshot };
      tracker.notify(subscription);
      input.onSubscribe?.(subscription);
    },
  };
  const peer: OrdinaryDraftPeer = {
    hostId: HOST_ID,
    scopeId: SCOPE_ID,
    client: input.client,
    read: { port },
    editingBase: (_draftId) => null,
    readCurrent: (_draftId, _signal) => Promise.resolve({ kind: "absent" }),
    upsert: (_request, _signal) =>
      Promise.resolve({ status: "committed", current: { kind: "absent" } }),
    settle: (_snapshot, _receipt) => true,
    ...input.peerOverrides,
  };
  return {
    subscriptions: tracker.subscriptions,
    waitForSubscription: tracker.waitFor,
    detach: attachOrdinaryDraftPeer(peer),
  };
}

interface IsolatedRendererFeed {
  readonly subscriptions: ReadSubscription[];
  readonly waitForSubscription: SubscriptionTracker["waitFor"];
  readonly visibleContent: (draftId: string) => JsonContent | undefined;
  readonly composerDraftId: (chatId: string) => string | null | undefined;
  readonly composerContent: (chatId: string) => JsonContent | undefined;
  readonly recoveryEntry: (draftId: string) => DraftCloudDocument | undefined;
  readonly captureSnapshot: (draftId: string) => OrdinaryDraftSnapshot | null;
  readonly occupyComposerSlot: (
    chatId: string,
    draftId: string,
    text: string,
  ) => void;
  readonly releaseComposerSlot: (chatId: string) => void;
  readonly edit: (draftId: string, text: string) => void;
  readonly waitForEditorWrite: (
    partition: string,
    draftId: string,
  ) => Promise<boolean>;
  readonly close: () => void;
}

async function attachIsolatedRendererFeed(input: {
  readonly peerId: string;
  readonly snapshot: DraftsListResponseV30;
  readonly client: DraftBlobClient;
  readonly initialComposer?: {
    readonly chatId: string;
    readonly draftId: string;
    readonly text: string;
  };
}): Promise<IsolatedRendererFeed> {
  vi.resetModules();
  const [
    coordinatorModule,
    authModule,
    landingModule,
    composerModule,
    canvasPersistenceModule,
  ] = await Promise.all([
    import("@/lib/drafts/draft-mirror-coordinator"),
    import("@/stores/auth/auth-store"),
    import("@/stores/home/landing-draft-store"),
    import("@/stores/composer/composer-draft-store"),
    import("@/stores/composer/composer-canvas-persistence"),
  ]);
  authModule.useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
  const tracker = subscriptionTracker();
  const port: OrdinaryDraftReadPort = {
    list: (_signal) => Promise.resolve(input.snapshot),
    subscribe: (frontier, signal, receive, requestSnapshot) => {
      tracker.notify({ frontier, signal, receive, requestSnapshot });
    },
  };
  const peer: OrdinaryDraftPeer = {
    hostId: input.peerId,
    scopeId: SCOPE_ID,
    client: input.client,
    read: { port },
    editingBase: () => null,
    readCurrent: () => Promise.resolve({ kind: "absent" }),
    upsert: () =>
      Promise.resolve({ status: "committed", current: { kind: "absent" } }),
    settle: () => true,
  };
  if (input.initialComposer !== undefined) {
    const { chatId, draftId, text } = input.initialComposer;
    const state = composerModule.useComposerDraftStore.getState();
    state.setSnapshot(chatId, documentContent(text), null);
    composerModule.useComposerDraftStore
      .getState()
      .bindTarget(chatId, "epic-ordering-explorer");
    const draft =
      composerModule.useComposerDraftStore.getState().drafts[chatId];
    if (draft === undefined)
      throw new Error("initial composer was not created");
    composerModule.useComposerDraftStore.setState((current) => ({
      drafts: {
        ...current.drafts,
        [chatId]: {
          ...draft,
          draftId,
          hostRevision: 1,
          ownerHostId: input.peerId,
          origin: "own",
          syncedGeneration: draft.generation,
        },
      },
    }));
  }
  const detach = coordinatorModule.attachOrdinaryDraftPeer(peer);
  return {
    subscriptions: tracker.subscriptions,
    waitForSubscription: tracker.waitFor,
    visibleContent: (draftId) =>
      landingModule.useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === draftId)?.content,
    composerDraftId: (chatId) =>
      composerModule.useComposerDraftStore.getState().drafts[chatId]?.draftId,
    composerContent: (chatId) =>
      composerModule.useComposerDraftStore.getState().drafts[chatId]?.content,
    recoveryEntry: (draftId) =>
      composerModule.useComposerDraftStore.getState().ordinaryRecoveryDrafts[
        draftId
      ],
    captureSnapshot: (draftId) =>
      coordinatorModule.captureOrdinaryDraftSnapshot(draftId),
    occupyComposerSlot: (chatId, draftId, text) => {
      const state = composerModule.useComposerDraftStore.getState();
      state.setSnapshot(chatId, documentContent(text), null);
      composerModule.useComposerDraftStore
        .getState()
        .bindTarget(chatId, "epic-ordering-explorer");
      const draft =
        composerModule.useComposerDraftStore.getState().drafts[chatId];
      if (draft === undefined)
        throw new Error("isolated composer was not created");
      composerModule.useComposerDraftStore.setState((current) => ({
        drafts: {
          ...current.drafts,
          [chatId]: {
            ...draft,
            draftId,
            hostRevision: 1,
            ownerHostId: input.peerId,
            origin: "own",
            syncedGeneration: draft.generation,
          },
        },
      }));
    },
    releaseComposerSlot: (chatId) => {
      composerModule.useComposerDraftStore.setState((state) => {
        const drafts = { ...state.drafts };
        delete drafts[chatId];
        return { drafts };
      });
    },
    edit: (draftId, text) => {
      const content = documentContent(text);
      const state = landingModule.useLandingDraftStore.getState();
      if (state.drafts.some((draft) => draft.id === draftId)) {
        state.setDraftContent(draftId, content, null);
        return;
      }
      state.createDraftWithId(draftId, null);
      landingModule.useLandingDraftStore
        .getState()
        .setDraftContent(draftId, content, null);
    },
    waitForEditorWrite: (partition, draftId) =>
      canvasPersistenceModule.waitForOrdinaryDraftEditorWrite(
        partition,
        draftId,
      ),
    close: () => {
      detach();
      canvasPersistenceModule.setOrdinaryDraftScopeBinding(null);
    },
  };
}

function openDatabaseConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ORDINARY_DRAFT_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("second database connection failed"));
  });
}

function readPartitionOnConnection(
  connection: IDBDatabase,
  partition: string,
): Promise<OrdinaryDraftPartition> {
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(
      ["drafts", "cursors"],
      "readonly",
    );
    const drafts = transaction
      .objectStore("drafts")
      .index("partition")
      .getAll(partition);
    const cursors = transaction
      .objectStore("cursors")
      .index("partition")
      .getAll(partition);
    let rows: OrdinaryDraftRow[] = [];
    let savedCursors: OrdinaryDraftPartition["cursors"] = [];
    drafts.onsuccess = () => {
      rows = drafts.result as OrdinaryDraftRow[];
    };
    cursors.onsuccess = () => {
      savedCursors = cursors.result as OrdinaryDraftPartition["cursors"];
    };
    transaction.oncomplete = () => resolve({ rows, cursors: savedCursors });
    transaction.onabort = () =>
      reject(new Error("second database read aborted"));
  });
}

function readImageOnConnection(
  connection: IDBDatabase,
  partition: string,
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction("images", "readonly");
    const request = transaction.objectStore("images").get([partition, hash]);
    request.onsuccess = () => {
      const image = request.result as
        | { readonly bytes: Uint8Array<ArrayBuffer> }
        | undefined;
      resolve(image?.bytes);
    };
    transaction.onabort = () => reject(new Error("second image read aborted"));
  });
}

async function waitForCommittedCursor(
  connection: IDBDatabase,
  partition: string,
  peerId: string,
  seq: number,
): Promise<void> {
  await vi.waitFor(async () => {
    const durable = await readPartitionOnConnection(connection, partition);
    expect(
      durable.cursors.find((cursor) => cursor.peerId === peerId)?.seq,
    ).toBe(seq);
  });
}

function visibleLandingContent(draftId: string): JsonContent | undefined {
  return useLandingDraftStore
    .getState()
    .drafts.find((draft) => draft.id === draftId)?.content;
}

function editLandingDraft(draftId: string, text: string): void {
  const content = documentContent(text);
  const state = useLandingDraftStore.getState();
  if (state.drafts.some((draft) => draft.id === draftId)) {
    state.setDraftContent(draftId, content, null);
    return;
  }
  state.createDraftWithId(draftId, null);
  useLandingDraftStore.getState().setDraftContent(draftId, content, null);
}

function seedCleanComposerAt(
  chatId: string,
  draftId: string,
  text: string,
  ordinaryProjection: boolean,
): void {
  useComposerDraftStore
    .getState()
    .setSnapshot(chatId, documentContent(text), null);
  useComposerDraftStore.getState().bindTarget(chatId, "epic-ordering-explorer");
  const draft = useComposerDraftStore.getState().drafts[chatId];
  if (draft === undefined) throw new Error("composer draft was not created");
  useComposerDraftStore.setState((state) => ({
    drafts: {
      ...state.drafts,
      [chatId]: {
        ...draft,
        draftId,
        hostRevision: 1,
        ownerHostId: HOST_ID,
        origin: "own",
        syncedGeneration: draft.generation,
        ...(ordinaryProjection
          ? { ordinaryCloudProjection: true as const }
          : {}),
      },
    },
  }));
}

function composerDraftContent(chatId: string): JsonContent | undefined {
  return useComposerDraftStore.getState().drafts[chatId]?.content;
}

function isJsonContent(value: unknown): value is JsonContent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "doc"
  );
}

function editorContent(
  row: OrdinaryDraftRow | undefined,
): JsonContent | undefined {
  const value = row?.editor?.value;
  if (typeof value !== "object" || value === null || !("value" in value))
    return undefined;
  const draft = value.value;
  if (typeof draft !== "object" || draft === null || !("content" in draft))
    return undefined;
  return isJsonContent(draft.content) ? draft.content : undefined;
}

interface CausalEvent {
  readonly id: string;
  readonly after: readonly string[];
}

function enumerateTopologicalOrders(
  events: readonly CausalEvent[],
): readonly (readonly string[])[] {
  const completed: string[][] = [];
  const visit = (order: readonly string[]): void => {
    if (order.length === events.length) {
      completed.push([...order]);
      return;
    }
    const ready = events.filter(
      ({ id, after }) =>
        !order.includes(id) &&
        after.every((predecessor) => order.includes(predecessor)),
    );
    for (const event of ready) visit([...order, event.id]);
  };
  visit([]);
  return completed;
}

type P1Cut =
  | "before-classification"
  | "during-blob-read"
  | "after-blob-read"
  | "after-image-stage"
  | "before-row-decision"
  | "after-row-decision"
  | "final-guard"
  | "after-final-guard"
  | "commit-before-delivery"
  | "after-delivery";

interface P1Schedule {
  readonly cut: P1Cut;
  readonly order: readonly string[];
}

/** One already-shown head, one image-backed frame and one local input. */
const P1_CAUSAL_EVENTS: readonly CausalEvent[] = [
  { id: "initial-head-shown", after: [] },
  { id: "local-keystroke", after: ["initial-head-shown"] },
  {
    id: "frame-classified-and-blob-read-started",
    after: ["initial-head-shown"],
  },
  {
    id: "blob-read-returned",
    after: ["frame-classified-and-blob-read-started"],
  },
  { id: "image-stage-committed", after: ["blob-read-returned"] },
  { id: "row-batch-entered", after: ["image-stage-committed"] },
  { id: "row-decided", after: ["row-batch-entered"] },
  { id: "eligibility-check-started", after: ["row-decided"] },
  { id: "eligibility-check-returned", after: ["eligibility-check-started"] },
  { id: "batch-committed", after: ["eligibility-check-returned"] },
  { id: "row-delivery-completed", after: ["batch-committed"] },
];

function p1CutForOrder(order: readonly string[]): P1Cut {
  const keystrokeIndex = order.indexOf("local-keystroke");
  const previous = order[keystrokeIndex - 1];
  if (previous === "initial-head-shown") return "before-classification";
  switch (previous) {
    case "frame-classified-and-blob-read-started":
      return "during-blob-read";
    case "blob-read-returned":
      return "after-blob-read";
    case "image-stage-committed":
      return "after-image-stage";
    case "row-batch-entered":
      return "before-row-decision";
    case "row-decided":
      return "after-row-decision";
    case "eligibility-check-started":
      return "final-guard";
    case "eligibility-check-returned":
      return "after-final-guard";
    case "batch-committed":
      return "commit-before-delivery";
    case "row-delivery-completed":
      return "after-delivery";
    default:
      throw new Error("local keystroke was not ordered after the first head");
  }
}

const P1_SCHEDULES: readonly P1Schedule[] = enumerateTopologicalOrders(
  P1_CAUSAL_EVENTS,
)
  .filter((order) => order.includes("local-keystroke"))
  .map((order) => ({ cut: p1CutForOrder(order), order }));

function expectOneEditorPerSlot(rows: readonly OrdinaryDraftRow[]): void {
  const holders = new Map<string, string>();
  for (const row of rows) {
    const editor = row.recovery === null ? row.editor : null;
    if (editor === null) continue;
    const slot = `${editor.surface}:${editor.slot}`;
    expect(holders.has(slot)).toBe(false);
    holders.set(slot, row.draftId);
  }
}

beforeEach(() => {
  installFreshIndexedDb();
  resetDraftMirrorCoordinatorForTests();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
});

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
    resumeDraftId: null,
  });
  useComposerDraftStore.setState({ drafts: {}, ordinaryRecoveryDrafts: {} });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  vi.restoreAllMocks();
});

function editDuringPublication(
  cut: P1Cut,
  draftId: string,
  edit: () => void,
): void {
  if (cut === "commit-before-delivery") {
    const publish = ordinaryDraftScope.publishOrdinaryDraftEntries;
    vi.spyOn(
      ordinaryDraftScope,
      "publishOrdinaryDraftEntries",
    ).mockImplementation(async (input) => {
      const rows = await publish(input);
      if (
        input.entries.some(
          ({ entry, stageId }) => entry.draftId === draftId && stageId !== null,
        )
      )
        edit();
      return rows;
    });
    return;
  }
  if (
    cut === "before-classification" ||
    cut === "during-blob-read" ||
    cut === "after-blob-read" ||
    cut === "after-delivery"
  )
    return;

  if (cut === "after-image-stage") {
    const holdImages = ordinaryDraftDb.holdOrdinaryDraftImages;
    vi.spyOn(ordinaryDraftDb, "holdOrdinaryDraftImages").mockImplementation(
      async (input) => {
        const held = await holdImages(input);
        edit();
        return held;
      },
    );
    return;
  }

  const writeBatch = ordinaryDraftDb.writeOrdinaryDraftBatch;
  vi.spyOn(ordinaryDraftDb, "writeOrdinaryDraftBatch").mockImplementation(
    (input) =>
      writeBatch({
        ...input,
        rows: input.rows.map((row) => {
          if (row.draftId !== draftId || row.stageId === null) return row;
          if (cut === "before-row-decision") {
            return {
              ...row,
              decide(previous) {
                edit();
                return row.decide(previous);
              },
            };
          }
          if (cut === "after-row-decision") {
            return {
              ...row,
              decide(previous) {
                const decided = row.decide(previous);
                edit();
                return decided;
              },
            };
          }
          return {
            ...row,
            isCurrent() {
              if (cut === "final-guard") edit();
              if (cut === "after-final-guard") {
                const eligible = row.isCurrent?.() ?? true;
                edit();
                return eligible;
              }
              edit();
              return row.isCurrent?.() ?? true;
            },
          };
        }),
      }),
  );
}

describe("ordinary draft ordering explorer", () => {
  it("enumerates each single-keystroke insertion around the awaited read path", () => {
    expect(P1_SCHEDULES).toHaveLength(10);
    expect(new Set(P1_SCHEDULES.map(({ cut }) => cut))).toEqual(
      new Set<P1Cut>([
        "before-classification",
        "during-blob-read",
        "after-blob-read",
        "after-image-stage",
        "before-row-decision",
        "after-row-decision",
        "final-guard",
        "after-final-guard",
        "commit-before-delivery",
        "after-delivery",
      ]),
    );
    for (const { order } of P1_SCHEDULES) {
      expect(order[0]).toBe("initial-head-shown");
      expect(order).toHaveLength(P1_CAUSAL_EVENTS.length);
      for (const { id, after } of P1_CAUSAL_EVENTS) {
        for (const predecessor of after)
          expect(order.indexOf(predecessor)).toBeLessThan(order.indexOf(id));
      }
    }
  });

  it("P2-1 keeps the storage-only slot holder when input brackets row decide", async () => {
    type ScheduleOrder = "before-decide" | "after-decide";
    interface ScheduleResult {
      readonly cursor: number | undefined;
      readonly accepted: OrdinaryDraftRow["accepted"];
      readonly pending: OrdinaryDraftRow["pending"];
      readonly editorSlot: string | undefined;
      readonly editorContent: JsonContent | undefined;
      readonly unrelatedAccepted: OrdinaryDraftRow["accepted"];
      readonly plannedSlot: string | null;
      readonly heldSlot: string | undefined;
      readonly visibleContent: JsonContent | undefined;
    }
    const run = async (order: ScheduleOrder): Promise<ScheduleResult> => {
      setOrdinaryDraftScopeBinding(null);
      resetDraftMirrorCoordinatorForTests();
      installFreshIndexedDb();
      useComposerDraftStore.setState({
        drafts: {},
        ordinaryRecoveryDrafts: {},
      });
      useLandingDraftStore.setState({
        drafts: [],
        activeDraftId: null,
        resumeDraftId: null,
      });

      const draftId = "ordering-slot-arbitration-A";
      const holderId = "ordering-slot-arbitration-B";
      const unrelatedId = "ordering-slot-arbitration-unrelated";
      const slotX = "ordering-chat-X";
      const slotY = "ordering-chat-Y";
      const first = composerEntry({
        draftId,
        chatId: slotX,
        revision: 1,
        operationId: "slot-A-first-head",
        text: "A accepted at X",
      });
      const holder = composerEntry({
        draftId: holderId,
        chatId: slotY,
        revision: 1,
        operationId: "slot-B-storage-head",
        text: "B owns Y in storage",
      });
      const candidate = composerEntry({
        draftId,
        chatId: slotY,
        revision: 2,
        operationId: "slot-A-candidate-at-Y",
        text: "candidate A body",
      });
      const unrelated = landingEntry({
        draftId: unrelatedId,
        revision: 1,
        operationId: "slot-unrelated-head",
        content: documentContent("unrelated row in same snapshot"),
      });
      let connection: IDBDatabase | undefined;
      let firstFeed: AttachedPeer | undefined;
      let secondRenderer: IsolatedRendererFeed | undefined;
      let activeFeed: AttachedPeer | undefined;
      try {
        seedCleanComposerAt(slotX, draftId, "A accepted at X", true);
        firstFeed = attachPeer({
          snapshots: [
            {
              scopeId: SCOPE_ID,
              snapshotSeq: 1,
              drafts: [first],
              tombstones: [],
            },
          ],
          client: blobClient(() => Promise.reject(new Error("text-only row"))),
        });
        const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (scope === null)
          throw new Error("ordinary test scope was unavailable");
        const observer = await openDatabaseConnection();
        connection = observer;
        await waitForCommittedCursor(observer, scope.partition, HOST_ID, 1);
        const initialRows = await readPartitionOnConnection(
          observer,
          scope.partition,
        );
        expect(
          initialRows.rows.find((row) => row.draftId === draftId),
        ).toMatchObject({
          accepted: first.base,
          editor: { surface: "chat", slot: slotX },
        });
        await vi.waitFor(() =>
          expect(useComposerDraftStore.getState().drafts[slotX]?.draftId).toBe(
            draftId,
          ),
        );
        firstFeed.detach();
        firstFeed = undefined;
        setOrdinaryDraftScopeBinding(null);

        secondRenderer = await attachIsolatedRendererFeed({
          peerId: HOST_ID,
          snapshot: {
            scopeId: SCOPE_ID,
            snapshotSeq: 2,
            drafts: [holder],
            tombstones: [],
          },
          client: blobClient(() => Promise.reject(new Error("text-only row"))),
        });
        await secondRenderer.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === 2,
        );
        await waitForCommittedCursor(observer, scope.partition, HOST_ID, 2);
        expect(secondRenderer.composerDraftId(slotY)).toBe(holderId);
        const beforeMove = await readPartitionOnConnection(
          observer,
          scope.partition,
        );
        expect(
          beforeMove.rows.find((row) => row.draftId === draftId)?.editor,
        ).toMatchObject({ surface: "chat", slot: slotX, dirty: false });
        expect(
          beforeMove.rows.find((row) => row.draftId === holderId)?.editor,
        ).toMatchObject({ surface: "chat", slot: slotY });

        useComposerDraftStore.setState({ drafts: {} });
        seedCleanComposerAt(slotY, draftId, "A accepted at X", false);
        activeFeed = attachPeer({
          snapshots: [
            {
              scopeId: SCOPE_ID,
              snapshotSeq: 2,
              drafts: [first],
              tombstones: [],
            },
            {
              scopeId: SCOPE_ID,
              snapshotSeq: 3,
              drafts: [candidate, unrelated],
              tombstones: [],
            },
          ],
          client: blobClient(() => Promise.reject(new Error("text-only row"))),
        });
        await activeFeed.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === 2,
        );
        const beforeCandidate = await readPartitionOnConnection(
          observer,
          scope.partition,
        );
        expect(
          beforeCandidate.rows.find((row) => row.draftId === draftId)?.editor,
        ).toMatchObject({ surface: "chat", slot: slotX, dirty: false });
        let plannedSlot: string | null = null;
        let inputDraftId: string | null = null;
        let editCount = 0;
        const writeBatch = ordinaryDraftDb.writeOrdinaryDraftBatch;
        const buildEditor = composerDraftStore.buildOrdinaryComposerEditor;
        const batchFinished = Promise.withResolvers<"committed" | "refused">();
        vi.spyOn(
          composerDraftStore,
          "buildOrdinaryComposerEditor",
        ).mockImplementation((document, projection, roots, retiring) => {
          const editor = buildEditor(document, projection, roots, retiring);
          if (document.draftId === draftId) plannedSlot = editor?.slot ?? null;
          return editor;
        });
        function monitorSlotDecision(): void {
          const noteInput = (): void => {
            editCount += 1;
            useComposerDraftStore
              .getState()
              .setSnapshot(
                slotY,
                documentContent("same accepted keystroke"),
                null,
              );
            inputDraftId =
              useComposerDraftStore.getState().drafts[slotY]?.draftId ?? null;
          };
          vi.spyOn(
            ordinaryDraftDb,
            "writeOrdinaryDraftBatch",
          ).mockImplementation((input) => {
            if (input.cursor?.seq !== 3) return writeBatch(input);
            const rows = input.rows.map((row) => {
              if (row.draftId !== draftId) return row;
              if (order === "before-decide") noteInput();
              return {
                ...row,
                decide(previous: OrdinaryDraftRow | undefined) {
                  const decided = row.decide(previous);
                  if (decided?.draftId === draftId && decided.editor !== null)
                    plannedSlot ??= decided.editor.slot;
                  if (order === "after-decide") noteInput();
                  return decided;
                },
              };
            });
            const writing = writeBatch({ ...input, rows });
            void writing.then(
              () => batchFinished.resolve("committed"),
              () => batchFinished.resolve("refused"),
            );
            return writing;
          });
        }

        monitorSlotDecision();

        const subscription = await activeFeed.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === 2,
        );
        subscription.requestSnapshot();
        const terminal = await batchFinished.promise;
        expect(terminal).toBe("committed");
        await waitForCommittedCursor(observer, scope.partition, HOST_ID, 3);
        await activeFeed.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === 3,
        );
        expect(editCount).toBe(1);
        expect(plannedSlot).toBe(slotY);
        expect(composerDraftContent(slotY)).toEqual(
          documentContent("same accepted keystroke"),
        );
        expect(inputDraftId).toBe(draftId);
        expect(
          window.localStorage.getItem("traycer-gui-app:composer-drafts"),
        ).toContain("same accepted keystroke");

        return await readOutcome(scope.partition);

        async function readOutcome(partition: string): Promise<ScheduleResult> {
          const durable = await readPartitionOnConnection(observer, partition);
          const rowA = durable.rows.find((row) => row.draftId === draftId);
          const rowB = durable.rows.find((row) => row.draftId === holderId);
          const otherRow = durable.rows.find(
            (row) => row.draftId === unrelatedId,
          );
          const result: ScheduleResult = {
            cursor: durable.cursors.find((cursor) => cursor.peerId === HOST_ID)
              ?.seq,
            accepted: rowA?.accepted ?? null,
            pending: rowA?.pending,
            editorSlot: rowA?.editor?.slot,
            editorContent: editorContent(rowA),
            unrelatedAccepted: otherRow?.accepted ?? null,
            plannedSlot,
            heldSlot: rowA?.editor?.slot,
            visibleContent: composerDraftContent(slotY),
          };
          expect(rowA?.accepted).toEqual(first.base);
          expect(rowA?.editor?.slot).toBe(slotX);
          expect(rowB?.editor?.slot).toBe(slotY);
          expect(
            durable.rows.filter(
              (row) =>
                row.editor?.surface === "chat" && row.editor.slot === slotY,
            ),
          ).toHaveLength(1);
          expect(result.visibleContent).toEqual(
            documentContent("same accepted keystroke"),
          );
          return result;
        }
      } finally {
        firstFeed?.detach();
        activeFeed?.detach();
        secondRenderer?.close();
        setOrdinaryDraftScopeBinding(null);
        connection?.close();
        vi.restoreAllMocks();
      }
    };

    const beforeDecide = await run("before-decide");
    expect(beforeDecide.cursor).toBe(3);
    expect(beforeDecide.pending?.entry).toMatchObject({
      draftId: "ordering-slot-arbitration-A",
      base: { revision: 2 },
    });
    expect(beforeDecide.unrelatedAccepted).toEqual(
      landingEntry({
        draftId: "ordering-slot-arbitration-unrelated",
        revision: 1,
        operationId: "slot-unrelated-head",
        content: documentContent("unrelated row in same snapshot"),
      }).base,
    );
    const afterDecide = await run("after-decide");
    expect(afterDecide.cursor).toBe(3);
    expect(afterDecide.accepted).toEqual(beforeDecide.accepted);
    expect(afterDecide.pending?.entry).toEqual(beforeDecide.pending?.entry);
    expect(afterDecide.editorSlot).toBe("ordering-chat-X");
    expect(afterDecide.editorContent).toEqual(
      documentContent("A accepted at X"),
    );
    expect(afterDecide.unrelatedAccepted).toEqual(
      beforeDecide.unrelatedAccepted,
    );
    expect(afterDecide).toEqual(beforeDecide);
  });

  it.each(
    P1_SCHEDULES.flatMap((schedule) =>
      (["tail", "snapshot"] as const).map((flow) => ({
        ...schedule,
        flow,
      })),
    ),
  )(
    "P1-a preserves a local keystroke at $cut during $flow delivery",
    async ({ cut, flow }) => {
      const draftId = "ordering-single-keystroke";
      const imageBytes = pngBytes(19);
      const imageHash = await sha256Hex(imageBytes);
      const first = landingEntry({
        draftId,
        revision: 1,
        operationId: "first-head",
        content: documentContent("first durable body"),
      });
      const next = landingEntry({
        draftId,
        revision: 2,
        operationId: "image-head",
        content: imageContent(
          "new cloud body",
          imageHash,
          imageBytes.byteLength,
        ),
        blobHashes: [imageHash],
      });
      const unrelated = landingEntry({
        draftId: `${draftId}-unrelated`,
        revision: 1,
        operationId: "unrelated-snapshot-operation",
        content: documentContent("independent snapshot row"),
      });
      const downloadStarted = Promise.withResolvers<void>();
      const downloadReply = Promise.withResolvers<{
        readonly ok: true;
        readonly bytesBase64: string;
      }>();
      let blobCalls = 0;
      const client = blobClient((hash) => {
        if (hash !== imageHash) throw new Error("unexpected image hash");
        blobCalls += 1;
        downloadStarted.resolve();
        return cut === "before-classification"
          ? Promise.reject(
              new Error("dirty local editor does not classify image"),
            )
          : downloadReply.promise;
      });
      const attached = attachPeer({
        snapshots: [
          {
            scopeId: SCOPE_ID,
            snapshotSeq: 1,
            drafts: [first],
            tombstones: [],
          },
          ...(flow === "snapshot"
            ? [
                {
                  scopeId: SCOPE_ID,
                  snapshotSeq: 2,
                  drafts: [next, unrelated],
                  tombstones: [],
                },
              ]
            : []),
        ],
        client,
      });
      const connection = await openDatabaseConnection();
      let partition = "";
      let edited = false;
      const localText =
        cut === "after-delivery"
          ? "local edit after the next copy was shown"
          : "same local keystroke before next delivery";
      const inputBase = cut === "after-delivery" ? next.base : first.base;
      const edit = () => {
        if (edited) return;
        edited = true;
        editLandingDraft(draftId, localText);
        expect(visibleLandingContent(draftId)).toEqual(
          documentContent(localText),
        );
        expect(captureOrdinaryDraftSnapshot(draftId)?.base).toEqual(inputBase);
      };
      const cutReached = Promise.withResolvers<void>();

      async function driveCut(receiveNext: () => void): Promise<void> {
        if (cut === "before-classification") {
          edit();
          receiveNext();
        } else {
          editDuringPublication(cut, draftId, () => {
            edit();
            cutReached.resolve();
          });
          receiveNext();
          await vi.waitFor(() => expect(blobCalls).toBeGreaterThan(0));
          await downloadStarted.promise;
          if (cut === "during-blob-read") {
            edit();
            cutReached.resolve();
          }
          downloadReply.resolve({
            ok: true,
            bytesBase64: bytesToBase64(imageBytes),
          });
          if (cut === "after-blob-read") {
            edit();
            cutReached.resolve();
          }
          if (cut === "after-delivery") {
            await vi.waitFor(async () => {
              expect(visibleLandingContent(draftId)).toEqual(
                next.head.portable.content,
              );
              expect(
                Array.from(
                  (await readImageOnConnection(
                    connection,
                    partition,
                    imageHash,
                  )) ?? [],
                ),
              ).toEqual(Array.from(imageBytes));
            });
            edit();
          } else {
            await vi.waitFor(() => expect(edited).toBe(true));
            await cutReached.promise;
          }
        }
      }

      try {
        await vi.waitFor(() =>
          expect(visibleLandingContent(draftId)).toEqual(
            first.head.portable.content,
          ),
        );
        const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (scope === null)
          throw new Error("ordinary test scope was unavailable");
        partition = scope.partition;
        await waitForCommittedCursor(connection, partition, HOST_ID, 1);

        const receiveNext = () => {
          const initial = attached.subscriptions[0];
          if (flow === "snapshot") initial.requestSnapshot();
          else
            initial.receive({
              kind: "upsert",
              hasBinaryPayload: false,
              seq: 2,
              draft: next,
            });
        };
        await driveCut(receiveNext);

        if (flow === "snapshot") {
          await waitForCommittedCursor(connection, partition, HOST_ID, 2);
        }
        await vi.waitFor(async () => {
          const durable = await readPartitionOnConnection(
            connection,
            partition,
          );
          const row = durable.rows.find(
            (candidate) => candidate.draftId === draftId,
          );
          expect(row?.editor?.dirty).toBe(true);
          expect(editorContent(row)).toEqual(documentContent(localText));
        });
        const durable = await readPartitionOnConnection(connection, partition);
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        const visible = visibleLandingContent(draftId);
        expect(visible).toEqual(documentContent(localText));
        expect(editorContent(row)).toEqual(visible);
        expect(captureOrdinaryDraftSnapshot(draftId)?.base).toEqual(inputBase);
        expect(durable.cursors).toContainEqual({
          partition,
          peerId: HOST_ID,
          seq: 2,
        });
        expectOneEditorPerSlot(durable.rows);
        const normalizedOutcome = {
          accepted: row?.accepted,
          inputBase: captureOrdinaryDraftSnapshot(draftId)?.base,
          pendingEntry: row?.pending?.entry ?? null,
          cursor: durable.cursors.find((cursor) => cursor.peerId === HOST_ID)
            ?.seq,
          editorText: editorContent(row),
        };
        expect(normalizedOutcome).toEqual(
          cut === "after-delivery"
            ? {
                accepted: next.base,
                inputBase: next.base,
                pendingEntry: null,
                cursor: 2,
                editorText: documentContent(localText),
              }
            : {
                accepted: first.base,
                inputBase: first.base,
                pendingEntry: next,
                cursor: 2,
                editorText: documentContent(localText),
              },
        );
        async function assertImageCustody(): Promise<void> {
          if (cut === "after-delivery") {
            expect(row?.accepted).toEqual(next.base);
            expect(row?.pending).toBeNull();
            const storedImage = await readImageOnConnection(
              connection,
              partition,
              imageHash,
            );
            expect(Array.from(storedImage ?? [])).toEqual(
              Array.from(imageBytes),
            );
          } else {
            expect(row?.accepted).toEqual(first.base);
            expect(row?.pending?.entry).toEqual(next);
            expect(
              await readImageOnConnection(connection, partition, imageHash),
            ).toBeUndefined();
          }
        }
        await assertImageCustody();
        if (flow === "snapshot") {
          expect(
            durable.rows.find(({ draftId }) => draftId === unrelated.draftId),
          ).toMatchObject({
            accepted: unrelated.base,
            pending: null,
            editor: { surface: "landing", slot: unrelated.draftId },
          });
          expect(visibleLandingContent(unrelated.draftId)).toEqual(
            unrelated.head.portable.content,
          );
        }
        const currentSubscription = attached.subscriptions.at(-1);
        if (currentSubscription === undefined)
          throw new Error("ordinary feed went away");
        expect(currentSubscription.signal.aborted).toBe(false);
        const currentContent = visibleLandingContent(draftId);
        currentSubscription.receive({
          kind: "upsert",
          hasBinaryPayload: false,
          seq: 1,
          draft: first,
        });
        expect(visibleLandingContent(draftId)).toEqual(currentContent);
        expect(currentSubscription.signal.aborted).toBe(false);
        expect(blobCalls > 0).toBe(cut !== "before-classification");
      } finally {
        connection.close();
        attached.detach();
      }
    },
  );

  it("keeps a clear reset epoch and empty composer through staged delivery", async () => {
    const draftId = "ordering-clear-during-staged-snapshot";
    const chatId = "ordering-clear-chat";
    const initial = composerEntry({
      draftId,
      chatId,
      revision: 1,
      operationId: "clear-first-head",
      text: "accepted composer text",
    });
    const imageBytes = pngBytes(23);
    const imageHash = await sha256Hex(imageBytes);
    const next = composerEntry({
      draftId,
      chatId,
      revision: 2,
      operationId: "clear-next-head",
      text: "next cloud composer text",
      content: imageContent(
        "next cloud composer text",
        imageHash,
        imageBytes.byteLength,
      ),
      blobHashes: [imageHash],
    });
    const downloadStarted = Promise.withResolvers<void>();
    const releaseDownload = Promise.withResolvers<{
      readonly ok: true;
      readonly bytesBase64: string;
    }>();
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [initial],
          tombstones: [],
        },
        { scopeId: SCOPE_ID, snapshotSeq: 2, drafts: [next], tombstones: [] },
      ],
      client: blobClient((hash) => {
        if (hash !== imageHash)
          throw new Error("unexpected composer image hash");
        downloadStarted.resolve();
        return releaseDownload.promise;
      }),
    });
    const connection = await openDatabaseConnection();
    try {
      await vi.waitFor(() =>
        expect(composerDraftContent(chatId)).toEqual(
          initial.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 1);
      const initialState = useComposerDraftStore.getState().drafts[chatId];
      if (initialState === undefined)
        throw new Error("initial composer state was not delivered");
      const initialResetEpoch = initialState.resetEpoch;
      const currentSubscription = await attached.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 1,
      );
      currentSubscription.requestSnapshot();
      await downloadStarted.promise;

      useComposerDraftStore.getState().clearDraft(chatId);
      const cleared = useComposerDraftStore.getState().drafts[chatId];
      if (cleared === undefined)
        throw new Error("cleared composer disappeared");
      const clearedContent = cleared.content;
      expect(cleared.resetEpoch).toBe(initialResetEpoch + 1);
      expect(clearedContent).not.toEqual(initial.head.portable.content);
      expect(captureOrdinaryDraftSnapshot(draftId)?.base).toEqual(initial.base);
      await expect(
        waitForOrdinaryDraftEditorWrite(scope.partition, draftId),
      ).resolves.toBe(true);

      const beforeRelease = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      expect(beforeRelease.cursors).toContainEqual({
        partition: scope.partition,
        peerId: HOST_ID,
        seq: 1,
      });
      expect(
        beforeRelease.rows.find((row) => row.draftId === draftId),
      ).toMatchObject({
        accepted: initial.base,
        editor: { surface: "chat", slot: chatId, dirty: true },
      });
      expect(
        beforeRelease.rows.find((row) => row.draftId === draftId)?.pending,
      ).toBeNull();
      expect(
        editorContent(
          beforeRelease.rows.find((row) => row.draftId === draftId),
        ),
      ).toEqual(clearedContent);

      releaseDownload.resolve({
        ok: true,
        bytesBase64: bytesToBase64(imageBytes),
      });
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 2);

      const durable = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      const row = durable.rows.find(
        (candidate) => candidate.draftId === draftId,
      );
      expect(durable.cursors).toContainEqual({
        partition: scope.partition,
        peerId: HOST_ID,
        seq: 2,
      });
      expect(row?.accepted).toEqual(initial.base);
      expect(row?.pending?.entry).toEqual(next);
      expect(row?.editor).toMatchObject({
        surface: "chat",
        slot: chatId,
        dirty: true,
      });
      expect(editorContent(row)).toEqual(clearedContent);
      expect(composerDraftContent(chatId)).toEqual(clearedContent);
      expect(useComposerDraftStore.getState().drafts[chatId]?.resetEpoch).toBe(
        cleared.resetEpoch,
      );
      expect(
        await readImageOnConnection(connection, scope.partition, imageHash),
      ).toBeUndefined();
      expectOneEditorPerSlot(durable.rows);
    } finally {
      releaseDownload.resolve({
        ok: true,
        bytesBase64: bytesToBase64(imageBytes),
      });
      connection.close();
      attached.detach();
    }
  });

  it("hydrates a durable recovery after restart and moves it when the slot frees", async () => {
    const draftId = "ordering-recovery-restart";
    const chatId = "ordering-recovery-chat";
    const occupantId = "ordering-recovery-local-occupant";
    const recovery = composerEntry({
      draftId,
      chatId,
      revision: 1,
      operationId: "recovery-head",
      text: "recovered composer body",
    });
    seedCleanComposerAt(chatId, occupantId, "still open local composer", false);
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [recovery],
          tombstones: [],
        },
      ],
      client: blobClient(() => Promise.reject(new Error("text-only recovery"))),
    });
    const connection = await openDatabaseConnection();
    let restartedRenderer: IsolatedRendererFeed | undefined;
    try {
      await vi.waitFor(() =>
        expect(
          useComposerDraftStore.getState().ordinaryRecoveryDrafts[draftId],
        ).toEqual(recovery),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 1);
      const parked = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      expect(parked.rows.find((row) => row.draftId === draftId)).toMatchObject({
        accepted: recovery.base,
        editor: null,
        recovery,
      });
      expect(useComposerDraftStore.getState().drafts[chatId]?.draftId).toBe(
        occupantId,
      );

      attached.detach();
      setOrdinaryDraftScopeBinding(null);
      useComposerDraftStore.setState({
        drafts: {},
        ordinaryRecoveryDrafts: {},
      });
      restartedRenderer = await attachIsolatedRendererFeed({
        peerId: HOST_ID,
        snapshot: {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [recovery],
          tombstones: [],
        },
        client: blobClient(() =>
          Promise.reject(new Error("text-only recovery")),
        ),
        initialComposer: {
          chatId,
          draftId: occupantId,
          text: "still open local composer after restart",
        },
      });
      await restartedRenderer.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 1,
      );
      expect(restartedRenderer.recoveryEntry(draftId)).toEqual(recovery);
      expect(restartedRenderer.composerDraftId(chatId)).toBe(occupantId);

      restartedRenderer.releaseComposerSlot(chatId);
      await vi.waitFor(async () => {
        const durable = await readPartitionOnConnection(
          connection,
          scope.partition,
        );
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        expect(row?.accepted).toEqual(recovery.base);
        expect(row?.pending).toBeNull();
        expect(row?.recovery).toBeNull();
        expect(row?.editor).toMatchObject({
          surface: "chat",
          slot: chatId,
          dirty: false,
        });
        expect(editorContent(row)).toEqual(recovery.head.portable.content);
        expect(restartedRenderer?.composerDraftId(chatId)).toBe(draftId);
        expect(restartedRenderer?.composerContent(chatId)).toEqual(
          recovery.head.portable.content,
        );
        expect(restartedRenderer?.recoveryEntry(draftId)).toBeUndefined();
        expect(durable.cursors).toContainEqual({
          partition: scope.partition,
          peerId: HOST_ID,
          seq: 1,
        });
        expectOneEditorPerSlot(durable.rows);
      });
    } finally {
      connection.close();
      attached.detach();
      restartedRenderer?.close();
    }
  });

  it("P1-a keeps a second tab's accepted edit before committed-row delivery", async () => {
    const draftId = "ordering-second-tab-before-delivery";
    const first = landingEntry({
      draftId,
      revision: 1,
      operationId: "second-tab-first-head",
      content: documentContent("first copy shown in both tabs"),
    });
    const imageBytes = pngBytes(61);
    const imageHash = await sha256Hex(imageBytes);
    const next = landingEntry({
      draftId,
      revision: 2,
      operationId: "second-tab-next-head",
      content: imageContent(
        "unshown next copy",
        imageHash,
        imageBytes.byteLength,
      ),
      blobHashes: [imageHash],
    });
    const deliveryReadStarted = Promise.withResolvers<void>();
    const releaseDeliveryRead = Promise.withResolvers<void>();
    let shouldHoldDeliveryRead = false;
    const readDelivery = ordinaryDraftDb.readOrdinaryDraftRowsForDelivery;
    vi.spyOn(
      ordinaryDraftDb,
      "readOrdinaryDraftRowsForDelivery",
    ).mockImplementation(async (partition, draftIds, deliver) => {
      if (shouldHoldDeliveryRead && draftIds.includes(draftId)) {
        shouldHoldDeliveryRead = false;
        deliveryReadStarted.resolve();
        await releaseDeliveryRead.promise;
      }
      return readDelivery(partition, draftIds, deliver);
    });
    const attached = attachPeer({
      snapshots: [
        { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [first], tombstones: [] },
        { scopeId: SCOPE_ID, snapshotSeq: 2, drafts: [next], tombstones: [] },
      ],
      client: blobClient((hash) => {
        if (hash !== imageHash) throw new Error("unexpected image hash");
        return Promise.resolve({
          ok: true,
          bytesBase64: bytesToBase64(imageBytes),
        });
      }),
    });
    let secondTab: IsolatedRendererFeed | undefined;
    const connection = await openDatabaseConnection();
    try {
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          first.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 1);
      secondTab = await attachIsolatedRendererFeed({
        peerId: HOST_ID,
        snapshot: {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [],
          tombstones: [],
        },
        client: blobClient(() => Promise.reject(new Error("text-only row"))),
      });
      await secondTab.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 1,
      );
      expect(secondTab.visibleContent(draftId)).toEqual(
        first.head.portable.content,
      );

      shouldHoldDeliveryRead = true;
      const firstSubscription = attached.subscriptions.at(-1);
      if (firstSubscription === undefined)
        throw new Error("ordinary feed was not subscribed after commit");
      firstSubscription.requestSnapshot();
      await deliveryReadStarted.promise;
      expect(visibleLandingContent(draftId)).toEqual(
        first.head.portable.content,
      );
      secondTab.edit(draftId, "accepted second-tab keystroke");
      const secondWriteCommitted = await secondTab.waitForEditorWrite(
        scope.partition,
        draftId,
      );
      releaseDeliveryRead.resolve();
      await attached.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 2,
      );

      const durable = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      const row = durable.rows.find(
        (candidate) => candidate.draftId === draftId,
      );
      expect(secondWriteCommitted).toBe(true);
      expect(row?.accepted).toEqual(first.base);
      expect(row?.pending?.entry).toEqual(next);
      expect(row?.editor?.dirty).toBe(true);
      expect(editorContent(row)).toEqual(
        documentContent("accepted second-tab keystroke"),
      );
      expect(secondTab.visibleContent(draftId)).toEqual(
        documentContent("accepted second-tab keystroke"),
      );
      expect(visibleLandingContent(draftId)).toEqual(
        documentContent("accepted second-tab keystroke"),
      );
    } finally {
      releaseDeliveryRead.resolve();
      connection.close();
      attached.detach();
      secondTab?.close();
    }
  });

  it("P2-3 preserves the newer edit across receipt delivery and restart hydration", async () => {
    const draftId = "ordering-receipt-before-newer-edit";
    const operationId = "receipt-committed-head";
    const initial = landingEntry({
      draftId,
      revision: 1,
      operationId: "receipt-initial-head",
      content: documentContent("initial accepted body"),
    });
    const receiptHead = landingEntry({
      draftId,
      revision: 2,
      operationId,
      content: documentContent("submitted body accepted by peer"),
    });
    let current: OrdinaryDraftHeadEvidence = {
      kind: "live",
      draft: {
        base: initial.base,
        operationId: initial.operationId,
        entry: initial,
      },
    };
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [initial],
          tombstones: [],
        },
      ],
      client: blobClient(() => Promise.reject(new Error("text-only row"))),
      peerOverrides: {
        editingBase: () => initial.base,
        readCurrent: () => Promise.resolve(current),
        upsert: (request) => {
          current = {
            kind: "live",
            draft: {
              base: receiptHead.base,
              operationId: request.operationId,
              write: request.draft,
            },
          };
          return Promise.resolve({ status: "committed", current });
        },
      },
    });
    const deliveryReadStarted = Promise.withResolvers<void>();
    const releaseDeliveryRead = Promise.withResolvers<void>();
    let shouldHoldDeliveryRead = false;
    const readDelivery = ordinaryDraftDb.readOrdinaryDraftRowsForDelivery;
    vi.spyOn(
      ordinaryDraftDb,
      "readOrdinaryDraftRowsForDelivery",
    ).mockImplementation(async (partition, draftIds, deliver) => {
      if (shouldHoldDeliveryRead && draftIds.includes(draftId)) {
        shouldHoldDeliveryRead = false;
        deliveryReadStarted.resolve();
        await releaseDeliveryRead.promise;
      }
      return readDelivery(partition, draftIds, deliver);
    });
    const connection = await openDatabaseConnection();
    let restartedRenderer: IsolatedRendererFeed | undefined;
    try {
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          initial.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 1);
      editLandingDraft(draftId, "submitted body accepted by peer");
      await vi.waitFor(async () => {
        const durable = await readPartitionOnConnection(
          connection,
          scope.partition,
        );
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        expect(row?.editor?.dirty).toBe(true);
        expect(editorContent(row)).toEqual(
          documentContent("submitted body accepted by peer"),
        );
      });
      const snapshot = captureOrdinaryDraftSnapshot(draftId);
      if (snapshot === null)
        throw new Error("ordinary receipt snapshot was unavailable");
      expect(snapshot.base).toEqual(initial.base);
      const receipt = await placeOrdinaryDraft(snapshot, operationId);
      if (receipt.status !== "placed")
        throw new Error("ordinary receipt was not placed");

      shouldHoldDeliveryRead = true;
      const settlement = settleOrdinaryDraftIfCurrent(snapshot, receipt);
      await deliveryReadStarted.promise;
      const afterReceiptCommit = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      expect(
        afterReceiptCommit.rows.find((row) => row.draftId === draftId)
          ?.accepted,
      ).toEqual(receiptHead.base);
      editLandingDraft(draftId, "newer edit before receipt delivery");
      await vi.waitFor(async () => {
        const durable = await readPartitionOnConnection(
          connection,
          scope.partition,
        );
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        expect(row?.editor?.dirty).toBe(true);
        expect(editorContent(row)).toEqual(
          documentContent("newer edit before receipt delivery"),
        );
      });
      const newerSnapshot = captureOrdinaryDraftSnapshot(draftId);
      if (newerSnapshot === null)
        throw new Error("newer ordinary snapshot was unavailable");
      expect(newerSnapshot.base).toEqual(initial.base);
      releaseDeliveryRead.resolve();
      expect(await settlement).toBe(false);

      const durable = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      const row = durable.rows.find(
        (candidate) => candidate.draftId === draftId,
      );
      expect(row?.accepted).toEqual(initial.base);
      expect(row?.evidence?.base).toEqual(receiptHead.base);
      expect(row?.evidence?.operationId).toBe(receiptHead.operationId);
      expect(row?.editor?.dirty).toBe(true);
      expect(editorContent(row)).toEqual(
        documentContent("newer edit before receipt delivery"),
      );
      const restartSnapshot = captureOrdinaryDraftSnapshot(draftId);
      if (restartSnapshot === null)
        throw new Error("ordinary restart snapshot was unavailable");
      expect(restartSnapshot.base).toEqual(initial.base);
      expect(visibleLandingContent(draftId)).toEqual(
        documentContent("newer edit before receipt delivery"),
      );

      attached.detach();
      setOrdinaryDraftScopeBinding(null);
      useLandingDraftStore.setState({
        drafts: [],
        activeDraftId: null,
        resumeDraftId: null,
      });
      useComposerDraftStore.setState({
        drafts: {},
        ordinaryRecoveryDrafts: {},
      });
      restartedRenderer = await attachIsolatedRendererFeed({
        peerId: HOST_ID,
        snapshot: {
          scopeId: SCOPE_ID,
          snapshotSeq: 2,
          drafts: [],
          tombstones: [],
        },
        client: blobClient(() => Promise.reject(new Error("text-only row"))),
      });
      await restartedRenderer.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 2,
      );
      const hydratedSnapshot = restartedRenderer.captureSnapshot(draftId);
      if (hydratedSnapshot === null)
        throw new Error("hydrated ordinary snapshot was unavailable");
      expect(restartedRenderer.visibleContent(draftId)).toEqual(
        documentContent("newer edit before receipt delivery"),
      );
      expect(hydratedSnapshot.base).toEqual(initial.base);
    } finally {
      releaseDeliveryRead.resolve();
      connection.close();
      attached.detach();
      restartedRenderer?.close();
    }
  });

  it("P2-4 keeps the higher second-writer cursor after a delayed old frame loads", async () => {
    const draftId = "ordering-second-writer-cursor";
    const first = landingEntry({
      draftId,
      revision: 1,
      operationId: "cursor-first",
      content: documentContent("first accepted body"),
    });
    const oldBytes = pngBytes(31);
    const oldHash = await sha256Hex(oldBytes);
    const oldFrame = landingEntry({
      draftId,
      revision: 2,
      operationId: "cursor-delayed-old-frame",
      content: imageContent("delayed old body", oldHash, oldBytes.byteLength),
      blobHashes: [oldHash],
    });
    const winningBytes = pngBytes(47);
    const winningHash = await sha256Hex(winningBytes);
    const winner = landingEntry({
      draftId,
      revision: 3,
      operationId: "cursor-second-writer-wins",
      content: imageContent(
        "second writer body",
        winningHash,
        winningBytes.byteLength,
      ),
      blobHashes: [winningHash],
    });
    let oldDownloadCalled = false;
    const oldDownload = Promise.withResolvers<{
      readonly ok: true;
      readonly bytesBase64: string;
    }>();
    let oldCommitWasReached = false;
    const releaseOldCommit = Promise.withResolvers<void>();
    const writeBatch = ordinaryDraftDb.writeOrdinaryDraftBatch;
    vi.spyOn(ordinaryDraftDb, "writeOrdinaryDraftBatch").mockImplementation(
      async (input) => {
        if (input.cursor?.peerId === HOST_ID && input.cursor.seq === 2) {
          oldCommitWasReached = true;
          await releaseOldCommit.promise;
        }
        return writeBatch(input);
      },
    );
    const firstSession = attachPeer({
      snapshots: [
        { scopeId: SCOPE_ID, snapshotSeq: 1, drafts: [first], tombstones: [] },
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 2,
          drafts: [oldFrame],
          tombstones: [],
        },
      ],
      client: blobClient((hash) => {
        if (hash !== oldHash) throw new Error("unexpected delayed image hash");
        oldDownloadCalled = true;
        return oldDownload.promise;
      }),
    });
    let secondSession: IsolatedRendererFeed | undefined;
    const connection = await openDatabaseConnection();
    try {
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          first.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 1);

      const firstSubscription = await firstSession.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 1,
      );
      expect(firstSubscription.frontier.afterSeq).toBe(1);
      expect(firstSubscription.signal.aborted).toBe(false);
      firstSubscription.requestSnapshot();
      await vi.waitFor(() => expect(oldDownloadCalled).toBe(true));
      oldDownload.resolve({
        ok: true,
        bytesBase64: bytesToBase64(oldBytes),
      });
      await vi.waitFor(() => expect(oldCommitWasReached).toBe(true));

      secondSession = await attachIsolatedRendererFeed({
        peerId: HOST_ID,
        snapshot: {
          scopeId: SCOPE_ID,
          snapshotSeq: 3,
          drafts: [winner],
          tombstones: [],
        },
        client: blobClient((hash) => {
          if (hash !== winningHash)
            throw new Error("unexpected winning image hash");
          return Promise.resolve({
            ok: true,
            bytesBase64: bytesToBase64(winningBytes),
          });
        }),
      });
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 3);
      await secondSession.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 3,
      );
      await vi.waitFor(() =>
        expect(secondSession?.visibleContent(draftId)).toEqual(
          winner.head.portable.content,
        ),
      );
      expect(visibleLandingContent(draftId)).toEqual(
        first.head.portable.content,
      );
      releaseOldCommit.resolve();
      await firstSession.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 3,
      );
      expect(visibleLandingContent(draftId)).toEqual(
        winner.head.portable.content,
      );

      const durable = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      const row = durable.rows.find(
        (candidate) => candidate.draftId === draftId,
      );
      expect(row?.accepted).toEqual(winner.base);
      expect(row?.acceptedEntry).toEqual(winner);
      expect(row?.pending).toBeNull();
      expect(editorContent(row)).toEqual(winner.head.portable.content);
      expect(visibleLandingContent(draftId)).toEqual(
        winner.head.portable.content,
      );
      expect(
        Array.from(
          (await readImageOnConnection(
            connection,
            scope.partition,
            winningHash,
          )) ?? [],
        ),
      ).toEqual(Array.from(winningBytes));
    } finally {
      connection.close();
      firstSession.detach();
      secondSession?.close();
    }
  });

  it.each(["before", "after", "across wipe"] as const)(
    "keeps queued editor removal across restart (%s)",
    async (order) => {
      const draftId = "ordering-remove-queued-editor";
      const initial = landingEntry({
        draftId,
        revision: 1,
        operationId: "remove-initial",
        content: documentContent("original draft"),
      });
      const client = blobClient(() =>
        Promise.reject(new Error("text-only row")),
      );
      const freshSnapshot = {
        scopeId: SCOPE_ID,
        snapshotSeq: 0,
        drafts: [],
        tombstones: [],
      };
      const listingAfterWipe = Promise.withResolvers<void>();
      const releaseList = Promise.withResolvers<void>();
      const attached = attachPeer({
        snapshots: [
          {
            scopeId: SCOPE_ID,
            snapshotSeq: 1,
            drafts: [initial],
            tombstones: [],
          },
          freshSnapshot,
        ],
        client,
        beforeList: async (snapshot) => {
          if (snapshot.snapshotSeq !== 0) return;
          listingAfterWipe.resolve();
          await releaseList.promise;
        },
      });
      const releaseEdit = Promise.withResolvers<void>();
      let restarted: IsolatedRendererFeed | undefined;
      try {
        await attached.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === 1,
        );
        expect(visibleLandingContent(draftId)).toEqual(
          initial.head.portable.content,
        );
        const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (scope === null) throw new Error("ordinary test scope unavailable");
        const writing = Promise.withResolvers<void>();
        const save = ordinaryDraftScope.saveOrdinaryDraftEditor;
        vi.spyOn(
          ordinaryDraftScope,
          "saveOrdinaryDraftEditor",
        ).mockImplementationOnce(async (input) => {
          writing.resolve();
          await releaseEdit.promise;
          return save(input);
        });

        editLandingDraft(draftId, "edit accepted before removal");
        await writing.promise;
        if (order === "after") {
          releaseEdit.resolve();
          expect(
            await waitForOrdinaryDraftEditorWrite(scope.partition, draftId),
          ).toBe(true);
        }
        if (order === "across wipe") {
          await deleteDatabaseWhenClosed(ORDINARY_DRAFT_DB_NAME);
          await listingAfterWipe.promise;
        }
        useLandingDraftStore.getState().deleteDraft(draftId);
        expect(visibleLandingContent(draftId)).toBeUndefined();
        releaseEdit.resolve();
        releaseList.resolve();
        const seq = order === "across wipe" ? 0 : 1;
        await attached.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === seq,
        );
        expect(
          await waitForOrdinaryDraftEditorWrite(scope.partition, draftId),
        ).toBe(true);

        const active = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (active === null) throw new Error("active test scope unavailable");
        expect(
          await waitForOrdinaryDraftEditorWrite(active.partition, draftId),
        ).toBe(true);

        attached.detach();
        restarted = await attachIsolatedRendererFeed({
          peerId: HOST_ID,
          snapshot: {
            scopeId: SCOPE_ID,
            snapshotSeq: seq,
            drafts: [],
            tombstones: [],
          },
          client,
        });
        await restarted.waitForSubscription(
          ({ frontier }) => frontier.afterSeq === seq,
        );
        expect(restarted.visibleContent(draftId)).toBeUndefined();
        expect(
          (
            await ordinaryDraftDb.readOrdinaryDraftRow(
              active.partition,
              draftId,
            )
          )?.editor ?? null,
        ).toBeNull();
      } finally {
        releaseEdit.resolve();
        releaseList.resolve();
        attached.detach();
        restarted?.close();
      }
    },
  );

  it("fences a pending receipt and old image download across a sibling wipe", async () => {
    const draftId = "ordering-wipe-pending-receipt";
    const initial = landingEntry({
      draftId,
      revision: 1,
      operationId: "wipe-receipt-initial",
      content: documentContent("shown before sibling wipe"),
    });
    const promotedBase = {
      ...initial.base,
      revision: 2,
      headSha256: "2".repeat(64),
    };
    const imageBytes = pngBytes(27);
    const hash = await sha256Hex(imageBytes);
    const incoming = landingEntry({
      draftId,
      revision: 3,
      operationId: "wipe-remote-image",
      content: imageContent("old pending image", hash, imageBytes.byteLength),
      blobHashes: [hash],
    });
    const downloadStarted = Promise.withResolvers<void>();
    const download = Promise.withResolvers<{
      readonly ok: true;
      readonly bytesBase64: string;
    }>();
    const acceptanceStarted = Promise.withResolvers<void>();
    const releaseAcceptance = Promise.withResolvers<void>();
    let current: OrdinaryDraftHeadEvidence = {
      kind: "live",
      draft: {
        base: initial.base,
        operationId: initial.operationId,
        entry: initial,
      },
    };
    const settle = vi.fn(() => true);
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [initial],
          tombstones: [],
        },
        { scopeId: SCOPE_ID, snapshotSeq: 0, drafts: [], tombstones: [] },
      ],
      client: blobClient((requested) => {
        if (requested !== hash) throw new Error("unexpected image hash");
        downloadStarted.resolve();
        return download.promise;
      }),
      peerOverrides: {
        readCurrent: () => Promise.resolve(current),
        upsert: (request) => {
          current = {
            kind: "live",
            draft: {
              base: promotedBase,
              operationId: request.operationId,
              write: request.draft,
            },
          };
          return Promise.resolve({ status: "committed", current });
        },
        settle,
      },
    });
    try {
      const original = await attached.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 1,
      );
      const snapshot = captureOrdinaryDraftSnapshot(draftId);
      if (snapshot === null)
        throw new Error("test receipt snapshot unavailable");
      const receipt = await placeOrdinaryDraft(
        snapshot,
        "wipe-pending-submission",
      );
      if (receipt.status !== "placed")
        throw new Error("test receipt unavailable");
      const accept = ordinaryDraftScope.acceptOrdinaryDraftAtBase;
      vi.spyOn(
        ordinaryDraftScope,
        "acceptOrdinaryDraftAtBase",
      ).mockImplementationOnce(async (input) => {
        acceptanceStarted.resolve();
        await releaseAcceptance.promise;
        return accept(input);
      });
      const settling = settleOrdinaryDraftIfCurrent(snapshot, receipt);
      await acceptanceStarted.promise;
      original.receive({
        kind: "upsert",
        hasBinaryPayload: false,
        seq: 2,
        draft: incoming,
      });
      await downloadStarted.promise;

      await deleteDatabaseWhenClosed(ORDINARY_DRAFT_DB_NAME);
      const reopened = await attached.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 0,
      );
      releaseAcceptance.resolve();
      download.resolve({ ok: true, bytesBase64: bytesToBase64(imageBytes) });
      expect(await settling).toBe(false);
      expect(settle).not.toHaveBeenCalled();
      expect(original.signal.aborted).toBe(true);
      expect(reopened.signal.aborted).toBe(false);
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null) throw new Error("new test scope unavailable");
      expect(
        (await ordinaryDraftDb.readOrdinaryDraftPartition(scope.partition))
          .rows,
      ).toEqual([]);
      expect(
        await ordinaryDraftDb.readOrdinaryDraftBytes(scope.partition, hash),
      ).toBeUndefined();
      expect(visibleLandingContent(draftId)).toEqual(
        initial.head.portable.content,
      );
    } finally {
      releaseAcceptance.resolve();
      download.resolve({ ok: true, bytesBase64: bytesToBase64(imageBytes) });
      attached.detach();
    }
  });

  it("P2-2 reopens after a sibling wipe and persists the still-visible editor", async () => {
    const draftId = "ordering-sibling-wipe-keeps-editor";
    const initial = landingEntry({
      draftId,
      revision: 1,
      operationId: "before-sibling-wipe",
      content: documentContent("visible before sibling wipe"),
    });
    const reopenedSubscription = Promise.withResolvers<ReadSubscription>();
    let afterWipe = false;
    let reopenedPartition: string | undefined;
    let beforeSnapshot: OrdinaryDraftPartition | undefined;
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 10,
          drafts: [initial],
          tombstones: [],
        },
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 1,
          drafts: [initial],
          tombstones: [],
        },
      ],
      client: blobClient(() => Promise.reject(new Error("text-only row"))),
      beforeList: async (snapshot) => {
        if (!afterWipe) return;
        expect(snapshot.snapshotSeq).toBe(1);
        const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (scope === null)
          throw new Error("ordinary test scope was unavailable after wipe");
        reopenedPartition = scope.partition;
        beforeSnapshot = await ordinaryDraftDb.readOrdinaryDraftPartition(
          scope.partition,
        );
      },
      onSubscribe: (subscription) => {
        if (afterWipe) reopenedSubscription.resolve(subscription);
      },
    });
    let connection: IDBDatabase | null = await openDatabaseConnection();
    try {
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          initial.head.portable.content,
        ),
      );
      const before = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (before === null)
        throw new Error("ordinary test scope was unavailable before wipe");
      await waitForCommittedCursor(connection, before.partition, HOST_ID, 10);
      const currentSubscription = attached.subscriptions.at(-1);
      if (currentSubscription === undefined)
        throw new Error("ordinary feed was not subscribed before wipe");
      expect(currentSubscription.signal.aborted).toBe(false);
      connection.close();
      connection = null;
      afterWipe = true;
      await deleteDatabaseWhenClosed(ORDINARY_DRAFT_DB_NAME);

      expect(visibleLandingContent(draftId)).toEqual(
        initial.head.portable.content,
      );
      expect(currentSubscription.signal.aborted).toBe(true);
      let timeoutId: number | undefined;
      const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeoutId = window.setTimeout(
          () => resolve({ kind: "timeout" }),
          1_500,
        );
      });
      const delivery = await Promise.race([
        reopenedSubscription.promise.then((subscription) => ({
          kind: "delivered" as const,
          subscription,
        })),
        timeout,
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      expect(delivery.kind).toBe("delivered");
      if (delivery.kind !== "delivered")
        throw new Error("existing feed did not reopen after sibling wipe");
      expect(delivery.subscription.frontier.afterSeq).toBe(1);
      expect(delivery.subscription.signal.aborted).toBe(false);
      expect(reopenedPartition).not.toBe(before.partition);
      expect(beforeSnapshot?.cursors).toEqual([]);
      expect(beforeSnapshot?.rows).toEqual([]);
      connection = await openDatabaseConnection();
      const reopened = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (reopened === null)
        throw new Error("ordinary test scope was unavailable after wipe");
      expect(reopened.partition).toBe(reopenedPartition);
      expect(visibleLandingContent(draftId)).toEqual(
        initial.head.portable.content,
      );
      editLandingDraft(draftId, "still visible after sibling wipe");
      await expect(
        waitForOrdinaryDraftEditorWrite(reopened.partition, draftId),
      ).resolves.toBe(true);
      await vi.waitFor(async () => {
        const durable = await ordinaryDraftDb.readOrdinaryDraftPartition(
          reopened.partition,
        );
        expect(durable.cursors).toContainEqual({
          partition: reopened.partition,
          peerId: HOST_ID,
          seq: 1,
        });
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        expect(row?.accepted).toEqual(initial.base);
        expect(row?.editor?.dirty).toBe(true);
        expect(editorContent(row)).toEqual(
          documentContent("still visible after sibling wipe"),
        );
        expect(durable.rows).toHaveLength(1);
      });
      expect(ordinaryDraftEditorWriteIsPending(before.partition, draftId)).toBe(
        false,
      );
    } finally {
      connection?.close();
      attached.detach();
    }
  });

  it("keeps a second-tab edit when a peer tombstone crosses its committed row", async () => {
    const draftId = "ordering-cross-tab-tombstone";
    const initial = landingEntry({
      draftId,
      revision: 1,
      operationId: "before-delete",
      content: documentContent("accepted body"),
    });
    const attached = attachPeer({
      snapshots: [
        {
          scopeId: SCOPE_ID,
          snapshotSeq: 10,
          drafts: [initial],
          tombstones: [],
        },
      ],
      client: blobClient(() => Promise.reject(new Error("text-only row"))),
    });
    const connection = await openDatabaseConnection();
    let secondTab: IsolatedRendererFeed | undefined;
    try {
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          initial.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 10);
      secondTab = await attachIsolatedRendererFeed({
        peerId: HOST_ID,
        snapshot: {
          scopeId: SCOPE_ID,
          snapshotSeq: 10,
          drafts: [],
          tombstones: [],
        },
        client: blobClient(() => Promise.reject(new Error("text-only row"))),
      });
      await secondTab.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 10,
      );
      secondTab.edit(draftId, "keystroke in the second tab before delete");
      await expect(
        secondTab.waitForEditorWrite(scope.partition, draftId),
      ).resolves.toBe(true);
      expect(secondTab.visibleContent(draftId)).toEqual(
        documentContent("keystroke in the second tab before delete"),
      );
      expect(visibleLandingContent(draftId)).toEqual(
        initial.head.portable.content,
      );

      const remoteDelete = tombstone(draftId, 2);
      const firstSubscription = await attached.waitForSubscription(
        ({ frontier }) => frontier.afterSeq === 10,
      );
      firstSubscription.receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 11,
        tombstone: remoteDelete,
      });
      await waitForCommittedCursor(connection, scope.partition, HOST_ID, 11);
      await vi.waitFor(async () => {
        const durable = await readPartitionOnConnection(
          connection,
          scope.partition,
        );
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        expect(row?.editor?.dirty).toBe(true);
        expect(editorContent(row)).toEqual(
          documentContent("keystroke in the second tab before delete"),
        );
        expect(row?.pending?.entry).toEqual(remoteDelete);
        expect(row?.evidence?.kind).toBe("tombstone");
        expect(durable.cursors).toContainEqual({
          partition: scope.partition,
          peerId: HOST_ID,
          seq: 11,
        });
      });
      expect(visibleLandingContent(draftId)).toEqual(
        initial.head.portable.content,
      );
      expect(secondTab.visibleContent(draftId)).toEqual(
        documentContent("keystroke in the second tab before delete"),
      );
      const durable = await readPartitionOnConnection(
        connection,
        scope.partition,
      );
      expectOneEditorPerSlot(durable.rows);
      expect(firstSubscription.signal.aborted).toBe(false);
    } finally {
      connection.close();
      attached.detach();
      secondTab?.close();
    }
  });
});
