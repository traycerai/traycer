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
  resetDraftMirrorCoordinatorForTests,
  type OrdinaryDraftPeer,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  ORDINARY_DRAFT_DB_NAME,
  resolveOrdinaryDraftScope,
  type OrdinaryDraftPartition,
  type OrdinaryDraftRow,
} from "@/lib/drafts/ordinary-draft-db";
import type { OrdinaryDraftReadPort } from "@/lib/drafts/draft-mirror-session";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
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

function attachPeer(input: {
  readonly snapshots: readonly DraftsListResponseV30[];
  readonly client: DraftBlobClient;
}): {
  readonly subscriptions: ReadSubscription[];
  readonly detach: () => void;
} {
  const snapshots = [...input.snapshots];
  const subscriptions: ReadSubscription[] = [];
  const port: OrdinaryDraftReadPort = {
    list: (_signal) => {
      const snapshot = snapshots.shift();
      return snapshot === undefined
        ? Promise.reject(new Error("snapshot script exhausted"))
        : Promise.resolve(snapshot);
    },
    subscribe: (frontier, signal, receive, requestSnapshot) => {
      subscriptions.push({ frontier, signal, receive, requestSnapshot });
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
  };
  return { subscriptions, detach: attachOrdinaryDraftPeer(peer) };
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

describe("ordinary draft ordering explorer", () => {
  it.each([
    { cut: "before-classification" as const },
    { cut: "after-row-decision" as const },
    { cut: "final-guard" as const },
    { cut: "commit-before-delivery" as const },
    { cut: "after-delivery" as const },
  ])(
    "keeps a local keystroke at $cut across snapshot and tail delivery",
    async ({ cut }) => {
      const draftId = `ordering-${cut}`;
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
        ],
        client,
      });
      const connection = await openDatabaseConnection();
      let partition = "";
      let edited = false;
      const edit = () => {
        if (edited) return;
        edited = true;
        editLandingDraft(draftId, `local at ${cut}`);
      };
      const cutReached = Promise.withResolvers<void>();

      try {
        await vi.waitFor(() => expect(attached.subscriptions).toHaveLength(1));
        await vi.waitFor(() =>
          expect(visibleLandingContent(draftId)).toEqual(
            first.head.portable.content,
          ),
        );
        const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
        if (scope === null)
          throw new Error("ordinary test scope was unavailable");
        partition = scope.partition;

        if (cut === "before-classification") {
          edit();
          attached.subscriptions[0].receive({
            kind: "upsert",
            hasBinaryPayload: false,
            seq: 2,
            draft: next,
          });
        } else {
          if (cut === "after-row-decision" || cut === "final-guard") {
            const writeBatch = ordinaryDraftDb.writeOrdinaryDraftBatch;
            vi.spyOn(
              ordinaryDraftDb,
              "writeOrdinaryDraftBatch",
            ).mockImplementation((input) =>
              writeBatch({
                ...input,
                rows: input.rows.map((row) => {
                  if (row.draftId !== draftId || row.stageId === null)
                    return row;
                  if (cut === "after-row-decision")
                    return {
                      ...row,
                      decide(previous) {
                        const decided = row.decide(previous);
                        edit();
                        cutReached.resolve();
                        return decided;
                      },
                    };
                  return {
                    ...row,
                    isCurrent() {
                      edit();
                      cutReached.resolve();
                      return row.isCurrent?.() ?? true;
                    },
                  };
                }),
              }),
            );
          }
          if (cut === "commit-before-delivery") {
            const publish = ordinaryDraftScope.publishOrdinaryDraftEntries;
            vi.spyOn(
              ordinaryDraftScope,
              "publishOrdinaryDraftEntries",
            ).mockImplementation(async (input) => {
              const rows = await publish(input);
              if (
                input.entries.some(
                  (candidate) =>
                    candidate.entry.draftId === draftId &&
                    candidate.stageId !== null,
                )
              ) {
                edit();
                cutReached.resolve();
              }
              return rows;
            });
          }
          attached.subscriptions[0].receive({
            kind: "upsert",
            hasBinaryPayload: false,
            seq: 2,
            draft: next,
          });
          await vi.waitFor(() => expect(blobCalls).toBeGreaterThan(0));
          await downloadStarted.promise;
          downloadReply.resolve({
            ok: true,
            bytesBase64: bytesToBase64(imageBytes),
          });
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

        await vi.waitFor(async () => {
          const durable = await readPartitionOnConnection(
            connection,
            partition,
          );
          const row = durable.rows.find(
            (candidate) => candidate.draftId === draftId,
          );
          expect(row?.editor?.dirty).toBe(true);
          expect(editorContent(row)).toEqual(
            documentContent(`local at ${cut}`),
          );
        });
        const durable = await readPartitionOnConnection(connection, partition);
        const row = durable.rows.find(
          (candidate) => candidate.draftId === draftId,
        );
        const visible = visibleLandingContent(draftId);
        expect(visible).toEqual(documentContent(`local at ${cut}`));
        expect(editorContent(row)).toEqual(visible);
        expect(durable.cursors).toContainEqual({
          partition,
          peerId: HOST_ID,
          seq: 2,
        });
        if (cut === "after-delivery") {
          expect(row?.accepted).toEqual(next.base);
          expect(row?.pending).toBeNull();
          const storedImage = await readImageOnConnection(
            connection,
            partition,
            imageHash,
          );
          expect(Array.from(storedImage ?? [])).toEqual(Array.from(imageBytes));
        } else {
          expect(row?.accepted).toEqual(first.base);
          expect(row?.pending?.entry).toEqual(next);
          expect(
            await readImageOnConnection(connection, partition, imageHash),
          ).toBeUndefined();
        }
        expect(attached.subscriptions[0].signal.aborted).toBe(false);
        const currentContent = visibleLandingContent(draftId);
        attached.subscriptions[0].receive({
          kind: "upsert",
          hasBinaryPayload: false,
          seq: 1,
          draft: first,
        });
        expect(visibleLandingContent(draftId)).toEqual(currentContent);
        expect(attached.subscriptions[0].signal.aborted).toBe(false);
        if (cut === "before-classification") expect(blobCalls).toBe(0);
        else expect(blobCalls).toBeGreaterThan(0);
      } finally {
        connection.close();
        attached.detach();
      }
    },
  );

  it("keeps a local landing edit and durable body when a peer tombstone crosses it", async () => {
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
    try {
      await vi.waitFor(() => expect(attached.subscriptions).toHaveLength(1));
      await vi.waitFor(() =>
        expect(visibleLandingContent(draftId)).toEqual(
          initial.head.portable.content,
        ),
      );
      const scope = await resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID);
      if (scope === null)
        throw new Error("ordinary test scope was unavailable");
      editLandingDraft(draftId, "keystroke before remote delete");
      const remoteDelete = tombstone(draftId, 2);
      attached.subscriptions[0].receive({
        kind: "delete",
        hasBinaryPayload: false,
        seq: 11,
        tombstone: remoteDelete,
      });
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
          documentContent("keystroke before remote delete"),
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
        documentContent("keystroke before remote delete"),
      );
      expect(attached.subscriptions[0].signal.aborted).toBe(false);
    } finally {
      connection.close();
      attached.detach();
    }
  });
});
