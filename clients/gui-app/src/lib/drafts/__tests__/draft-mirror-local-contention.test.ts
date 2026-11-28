import "fake-indexeddb/auto";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  DraftCloudDocument,
  DraftsListResponseV30,
  DraftsSubscribeServerFrameV20,
} from "@traycer/protocol/host";
import { draftCloudDocumentSchema } from "@traycer/protocol/host/drafts";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import { browserAnnotationRecordSchema } from "@traycer/protocol/persistence/epic/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrdinaryDraftEditor, OrdinaryDraftRow } from "@/lib/drafts/ordinary-draft-db";
import type { OrdinaryDraftSnapshot } from "@/lib/drafts/draft-mirror-session";
import type { DraftBlobClient } from "@/lib/drafts/draft-blob-transport";
import type { OrdinaryScopeProjection } from "@/lib/drafts/ordinary-draft-scope";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import {
  deleteDatabaseWhenClosed,
  installFreshIndexedDb,
} from "@/lib/composer/__tests__/fake-idb";
import {
  ORDINARY_DRAFT_DB_NAME,
  type OrdinaryDraftPartition,
} from "@/lib/drafts/ordinary-draft-db";

const OWNER_ID = "local-contention-owner";
const HOST_ID = "local-contention-host";
const SCOPE_ID = "scp_localcontentionscope0001";
const DRAFT_ID = "local-contention-draft";
const CHAT_ID = "local-contention-chat";
const EPIC_ID = "epic-local-contention";

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
  readonly waitFor: () => Promise<ReadSubscription>;
}

interface LocalPayload {
  readonly content: JsonContent;
  readonly annotations: readonly BrowserAnnotationRecord[];
}

interface EditorWriteGate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly arm: () => void;
}

interface ActiveEditorWriteGate extends EditorWriteGate {
  readonly wait: () => Promise<void>;
}

interface Renderer {
  readonly waitForSubscription: () => Promise<ReadSubscription>;
  readonly waitForEditorWrite: (
    partition: string,
    draftId: string,
  ) => Promise<boolean>;
  readonly captureSnapshot: () => OrdinaryDraftSnapshot | null;
  readonly visiblePayload: () => LocalPayload | undefined;
  readonly recoveryPayload: () => LocalPayload | undefined;
  readonly editorWriteGate: EditorWriteGate;
  readonly edit: (edit: RendererEdit) => Promise<void>;
  readonly close: () => void;
}

interface RendererEdit {
  readonly kind: "text" | "annotation" | "image";
  readonly renderer: "left" | "right";
  readonly payload: LocalPayload;
  readonly imageBytes: Uint8Array<ArrayBuffer> | null;
  readonly imageHash: string | null;
}

interface ContentionSchedule {
  readonly left: RendererEdit["kind"];
  readonly right: RendererEdit["kind"];
  readonly order: "left-first" | "right-first";
}

interface ScheduleFixture {
  readonly initial: DraftCloudDocument;
  readonly edits: readonly [RendererEdit, RendererEdit];
  readonly left: Renderer;
  readonly right: Renderer;
  readonly database: IDBDatabase;
  readonly partition: string;
}

const PAIRINGS: readonly Pick<ContentionSchedule, "left" | "right">[] = [
  { left: "text", right: "annotation" },
  { left: "text", right: "image" },
  { left: "annotation", right: "image" },
  { left: "text", right: "text" },
];

const SCHEDULES: readonly ContentionSchedule[] = PAIRINGS.flatMap((pair) => [
  { ...pair, order: "left-first" },
  { ...pair, order: "right-first" },
]);

function subscriptionTracker(): SubscriptionTracker {
  const subscriptions: ReadSubscription[] = [];
  const waiters: Array<(subscription: ReadSubscription) => void> = [];
  return {
    subscriptions,
    notify(subscription) {
      subscriptions.push(subscription);
      for (const resolve of waiters.splice(0)) resolve(subscription);
    },
    waitFor() {
      const existing = subscriptions.at(0);
      if (existing !== undefined) return Promise.resolve(existing);
      const deferred = Promise.withResolvers<ReadSubscription>();
      waiters.push(deferred.resolve);
      return deferred.promise;
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
              id: "contention-image",
              fileName: "contention.png",
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

function imageBytes(tag: number): Uint8Array<ArrayBuffer> {
  const encoded =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=";
  const decoded = atob(encoded);
  return new Uint8Array([
    ...Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    tag,
  ]);
}

function annotationRecord(
  annotationId: string,
  imageHash: string,
): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId,
    source: {
      kind: "canvas",
      artifactId: "artifact-contention",
      boardPath: "contention.canvas",
      canvasPage: null,
      artifactTitle: "Contention",
    },
    capturedAt: 1,
    comment: annotationId,
    counts: { elements: 1, regions: 0, strokes: 0 },
    elements: [],
    imageFileName: `${annotationId}.png`,
    imageHash,
    droppedElementCount: 0,
  };
}

function cloudEntry(): DraftCloudDocument {
  return draftCloudDocumentSchema.parse({
    draftId: DRAFT_ID,
    base: {
      headSha256: "1".repeat(64),
      ownerEpoch: 1,
      revision: 1,
    },
    operationId: "contention-initial-head",
    head: {
      dialect: "draft/v1",
      lastTouchedAt: 1,
      target: { epicId: EPIC_ID, chatId: CHAT_ID, blockId: null },
      hostLocal: { hostId: HOST_ID, workspace: null },
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: "chat-composer",
      portable: {
        content: documentContent("accepted initial body"),
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
        annotations: [],
      },
    },
  });
}

function blobClient(): DraftBlobClient {
  const reject = (): Promise<never> =>
    Promise.reject(new Error("unexpected blob request for an unreferenced image"));
  return {
    request: reject,
    requestWithOptions: reject,
  };
}

function createEditorWriteGate(): ActiveEditorWriteGate {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;
  return {
    entered: entered.promise,
    release: released.resolve,
    arm: () => {
      armed = true;
    },
    wait: async () => {
      if (!armed) return;
      armed = false;
      entered.resolve();
      await released.promise;
    },
  };
}

async function attachRenderer(): Promise<Renderer> {
  vi.resetModules();
  const scopeModule = await import("@/lib/drafts/ordinary-draft-scope");
  const originalSave = scopeModule.saveOrdinaryDraftEditor;
  const gate = createEditorWriteGate();
  vi.spyOn(scopeModule, "saveOrdinaryDraftEditor").mockImplementation(
    async (input: {
      readonly projection: OrdinaryScopeProjection;
      readonly source: OrdinaryDraftRow;
      readonly editor: OrdinaryDraftEditor | null;
      readonly roots: readonly string[];
    }) => {
      await gate.wait();
      return originalSave(input);
    },
  );
  const [coordinator, auth, composer, imageStore, persistence, database] =
    await Promise.all([
      import("@/lib/drafts/draft-mirror-coordinator"),
      import("@/stores/auth/auth-store"),
      import("@/stores/composer/composer-draft-store"),
      import("@/lib/composer/landing-image-store"),
      import("@/stores/composer/composer-canvas-persistence"),
      import("@/lib/drafts/ordinary-draft-db"),
    ]);
  auth.useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
  const tracker = subscriptionTracker();
  const port = {
    list: (_signal: AbortSignal) =>
      Promise.resolve<DraftsListResponseV30>({
        scopeId: SCOPE_ID,
        snapshotSeq: 1,
        drafts: [cloudEntry()],
        tombstones: [],
      }),
    subscribe: (
      frontier: ReadSubscription["frontier"],
      signal: AbortSignal,
      receive: (frame: ReadFrame) => void,
      requestSnapshot: () => void,
    ) => tracker.notify({ frontier, signal, receive, requestSnapshot }),
  };
  const detach = coordinator.attachOrdinaryDraftPeer({
    hostId: HOST_ID,
    scopeId: SCOPE_ID,
    client: blobClient(),
    read: { port },
    editingBase: () => null,
    readCurrent: () => Promise.resolve({ kind: "absent" }),
    upsert: () =>
      Promise.resolve({ status: "committed", current: { kind: "absent" } }),
    settle: () => true,
  });
  const visiblePayload = (): LocalPayload | undefined => {
    const draft = composer.useComposerDraftStore.getState().drafts[CHAT_ID];
    return draft === undefined
      ? undefined
      : { content: draft.content, annotations: draft.browserAnnotations };
  };
  return {
    waitForSubscription: tracker.waitFor,
    waitForEditorWrite: (partition, draftId) =>
      persistence.waitForOrdinaryDraftEditorWrite(partition, draftId),
    captureSnapshot: () => coordinator.captureOrdinaryDraftSnapshot(DRAFT_ID),
    visiblePayload,
    recoveryPayload: () => {
      const draft = composer.useComposerDraftStore.getState()
        .ordinaryRecoveryDrafts[DRAFT_ID];
      if (draft === undefined) return undefined;
      const portable: unknown = draft.head.portable;
      const content = contentFromPortable(portable);
      return content === undefined
        ? undefined
        : { content, annotations: annotationsFromPortable(portable) };
    },
    editorWriteGate: gate,
    edit: async (edit) => {
      if (edit.imageBytes !== null && edit.imageHash !== null) {
        if (
          !(await imageStore.putImageBytesAtHash(
            edit.imageHash,
            edit.imageBytes,
          ))
        )
          throw new Error("image bytes did not match their digest");
      }
      if (edit.kind === "text" || edit.kind === "image") {
        composer.useComposerDraftStore
          .getState()
          .setSnapshot(CHAT_ID, edit.payload.content, null);
      }
      if (edit.payload.annotations.length > 0)
        composer.useComposerDraftStore
          .getState()
          .addBrowserAnnotation(CHAT_ID, edit.payload.annotations[0]);
    },
    close: () => {
      detach();
      persistence.setOrdinaryDraftScopeBinding(null);
      database.resetOrdinaryDraftDatabaseForTests();
    },
  };
}

function openDatabaseConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ORDINARY_DRAFT_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("ordinary database open failed"));
  });
}

function readPartition(
  database: IDBDatabase,
  partition: string,
): Promise<OrdinaryDraftPartition> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["drafts", "cursors"], "readonly");
    const drafts = transaction.objectStore("drafts").index("partition").getAll(partition);
    const cursors = transaction.objectStore("cursors").index("partition").getAll(partition);
    let rows: OrdinaryDraftRow[] = [];
    let savedCursors: OrdinaryDraftPartition["cursors"] = [];
    drafts.onsuccess = () => {
      rows = drafts.result as OrdinaryDraftRow[];
    };
    cursors.onsuccess = () => {
      savedCursors = cursors.result as OrdinaryDraftPartition["cursors"];
    };
    transaction.oncomplete = () => resolve({ rows, cursors: savedCursors });
    transaction.onabort = () => reject(new Error("ordinary database read aborted"));
  });
}

function readImage(
  database: IDBDatabase,
  partition: string,
  hash: string,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("images", "readonly");
    const request = transaction.objectStore("images").get([partition, hash]);
    request.onsuccess = () => {
      const image = request.result as
        | { readonly bytes: Uint8Array<ArrayBuffer> }
        | undefined;
      resolve(image?.bytes);
    };
    transaction.onabort = () => reject(new Error("ordinary image read aborted"));
  });
}

function payloadFromEditor(row: OrdinaryDraftRow): LocalPayload | undefined {
  const value = row.editor?.value;
  if (typeof value !== "object" || value === null || !("value" in value))
    return undefined;
  const editorValue = value.value;
  if (
    typeof editorValue !== "object" ||
    editorValue === null ||
    !("content" in editorValue)
  )
    return undefined;
  const content = editorValue.content;
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "doc"
  )
    return undefined;
  const annotations =
    "browserAnnotations" in editorValue
      ? annotationsFromPortable({ annotations: editorValue.browserAnnotations })
      : [];
  return { content: content as JsonContent, annotations };
}

function contentFromPortable(value: unknown): JsonContent | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    typeof value.content !== "object" ||
    value.content === null ||
    !("type" in value.content) ||
    value.content.type !== "doc"
  )
    return undefined;
  return value.content as JsonContent;
}

function annotationsFromPortable(value: unknown): BrowserAnnotationRecord[] {
  if (typeof value !== "object" || value === null || !("annotations" in value))
    return [];
  const annotations = value.annotations;
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((annotation) => {
    const parsed = browserAnnotationRecordSchema.safeParse(annotation);
    return parsed.success ? [parsed.data] : [];
  });
}

function durablePayloads(row: OrdinaryDraftRow): LocalPayload[] {
  const payloads = payloadFromEditor(row);
  const result = payloads === undefined ? [] : [payloads];
  if (row.recovery !== null) {
    const portable: unknown = row.recovery.head.portable;
    const content = contentFromPortable(portable);
    if (content === undefined) return result;
    result.push({
      content,
      annotations: annotationsFromPortable(portable),
    });
  }
  return result;
}

function pngFromEdit(kind: RendererEdit["kind"], renderer: RendererEdit["renderer"]): Uint8Array<ArrayBuffer> | null {
  return kind === "annotation" || kind === "image"
    ? imageBytes(renderer === "left" ? 41 : 73)
    : null;
}

async function createEdit(
  kind: RendererEdit["kind"],
  renderer: RendererEdit["renderer"],
): Promise<RendererEdit> {
  const bytes = pngFromEdit(kind, renderer);
  const hash = bytes === null ? null : await sha256Hex(bytes);
  const annotations =
    kind === "annotation" && hash !== null
      ? [annotationRecord(`annotation-${renderer}`, hash)]
      : [];
  let content: JsonContent;
  if (kind === "image" && hash !== null && bytes !== null) {
    content = imageContent(`accepted image edit ${renderer}`, hash, bytes.byteLength);
  } else if (kind === "text") {
    content = documentContent(`accepted text edit ${renderer}`);
  } else {
    content = documentContent("accepted initial body");
  }
  return {
    kind,
    renderer,
    payload: { content, annotations },
    imageBytes: bytes,
    imageHash: hash,
  };
}

function expectIntentPreserved(row: OrdinaryDraftRow, edit: RendererEdit): void {
  const actual = durablePayloads(row);
  if (edit.kind === "text") {
    const text = `accepted text edit ${edit.renderer}`;
    expect(actual.some(({ content }) => JSON.stringify(content).includes(text))).toBe(true);
  }
  if (edit.kind === "annotation") {
    const annotationId = `annotation-${edit.renderer}`;
    expect(
      actual.some((payload) =>
        payload.annotations.some(
          (annotation) => annotation.annotationId === annotationId,
        ),
      ),
    ).toBe(true);
  }
  if (edit.kind === "image") {
    expect(
      actual.some(({ content }) =>
        JSON.stringify(content).includes(edit.imageHash ?? ""),
      ),
    ).toBe(true);
  }
}

function expectIntentsPreserved(
  row: OrdinaryDraftRow,
  edits: readonly [RendererEdit, RendererEdit],
): void {
  for (const edit of edits) expectIntentPreserved(row, edit);
}

async function readDurableRow(
  database: IDBDatabase,
  partition: string,
): Promise<OrdinaryDraftRow> {
  const durable = await readPartition(database, partition);
  const row = durable.rows.find((candidate) => candidate.draftId === DRAFT_ID);
  if (row === undefined) throw new Error("ordinary editor row was not durable");
  return row;
}

async function runSchedule(schedule: ContentionSchedule): Promise<void> {
  const initial = cloudEntry();
  const leftEdit = await createEdit(schedule.left, "left");
  const rightEdit = await createEdit(schedule.right, "right");
  const expectedEdits: [RendererEdit, RendererEdit] = [leftEdit, rightEdit];
  const left = await attachRenderer();
  const right = await attachRenderer();
  let restarted: Renderer | undefined;
  let database: IDBDatabase | undefined;
  let partition = "";
  try {
    await Promise.all([left.waitForSubscription(), right.waitForSubscription()]);
    const scope = await import("@/lib/drafts/ordinary-draft-db").then((db) =>
      db.resolveOrdinaryDraftScope(OWNER_ID, SCOPE_ID),
    );
    if (scope === null) throw new Error("ordinary contention scope unavailable");
    partition = scope.partition;
    database = await openDatabaseConnection();
    expect(left.captureSnapshot()?.base).toEqual(initial.base);
    expect(right.captureSnapshot()?.base).toEqual(initial.base);
    expect(left.visiblePayload()?.content).toEqual(initial.head.portable.content);
    expect(right.visiblePayload()?.content).toEqual(initial.head.portable.content);

    left.editorWriteGate.arm();
    right.editorWriteGate.arm();
    await Promise.all([
      left.edit(leftEdit),
      right.edit(rightEdit),
    ]);
    expect(left.visiblePayload()).toEqual(leftEdit.payload);
    expect(right.visiblePayload()).toEqual(rightEdit.payload);
    expect(left.captureSnapshot()?.base).toEqual(initial.base);
    expect(right.captureSnapshot()?.base).toEqual(initial.base);
    await Promise.all([
      left.editorWriteGate.entered,
      right.editorWriteGate.entered,
    ]);

    const first = schedule.order === "left-first" ? left : right;
    const second = schedule.order === "left-first" ? right : left;
    const firstEdit = schedule.order === "left-first" ? leftEdit : rightEdit;
    const secondEdit = schedule.order === "left-first" ? rightEdit : leftEdit;
    first.editorWriteGate.release();
    await expect(first.waitForEditorWrite(partition, DRAFT_ID)).resolves.toBe(true);
    const afterFirst = await readDurableRow(database, partition);
    expect(afterFirst.accepted).toEqual(initial.base);
    expect(durablePayloads(afterFirst)).toContainEqual(firstEdit.payload);

    second.editorWriteGate.release();
    await expect(second.waitForEditorWrite(partition, DRAFT_ID)).resolves.toBe(true);
    const finalRow = await readDurableRow(database, partition);
    expect(finalRow.accepted).toEqual(initial.base);
    expect(finalRow.editor?.surface).toBe("chat");
    expect(finalRow.editor?.slot).toBe(CHAT_ID);
    expect(finalRow.editor?.dirty).toBe(true);
    expectIntentsPreserved(finalRow, expectedEdits);
    expect(finalRow.roots).toEqual(
      expect.arrayContaining(
        expectedEdits.flatMap((edit) =>
          edit.imageHash === null ? [] : [edit.imageHash],
        ),
      ),
    );
    const occupied = (await readPartition(database, partition)).rows.filter(
      (row) => row.editor?.surface === "chat" && row.editor.slot === CHAT_ID,
    );
    expect(occupied).toHaveLength(1);
    for (const edit of expectedEdits) {
      if (edit.imageHash === null || edit.imageBytes === null) continue;
      expect(Array.from(await readImage(database, partition, edit.imageHash))).toEqual(
        Array.from(edit.imageBytes),
      );
    }
    expect(second.visiblePayload()).toEqual(secondEdit.payload);

    left.close();
    right.close();
    restarted = await attachRenderer();
    await restarted.waitForSubscription();
    const reopenedRow = await readDurableRow(database, partition);
    expect(reopenedRow.accepted).toEqual(initial.base);
    expectIntentsPreserved(reopenedRow, expectedEdits);
    for (const edit of expectedEdits) {
      if (edit.imageHash === null || edit.imageBytes === null) continue;
      expect(Array.from(await readImage(database, partition, edit.imageHash))).toEqual(
        Array.from(edit.imageBytes),
      );
    }
    expect(restarted.captureSnapshot()?.base).toEqual(initial.base);
    const recoveredPayloads = [
      restarted.visiblePayload(),
      restarted.recoveryPayload(),
    ].filter((payload): payload is LocalPayload => payload !== undefined);
    for (const edit of expectedEdits) {
      if (edit.kind === "text")
        expect(
          recoveredPayloads.some(({ content }) =>
            JSON.stringify(content).includes(
              `accepted text edit ${edit.renderer}`,
            ),
          ),
        ).toBe(true);
      if (edit.kind === "annotation")
        expect(
          recoveredPayloads.some((payload) =>
            payload.annotations.some(
              (annotation) =>
                annotation.annotationId === `annotation-${edit.renderer}`,
            ),
          ),
        ).toBe(true);
      if (edit.kind === "image")
        expect(
          recoveredPayloads.some(({ content }) =>
            JSON.stringify(content).includes(edit.imageHash ?? ""),
          ),
        ).toBe(true);
    }
  } finally {
    left.editorWriteGate.release();
    right.editorWriteGate.release();
    left.close();
    right.close();
    restarted?.close();
    database?.close();
  }
}

beforeEach(async () => {
  installFreshIndexedDb();
  vi.resetModules();
  const [coordinator, database, auth] = await Promise.all([
    import("@/lib/drafts/draft-mirror-coordinator"),
    import("@/lib/drafts/ordinary-draft-db"),
    import("@/stores/auth/auth-store"),
  ]);
  coordinator.resetDraftMirrorCoordinatorForTests();
  database.resetOrdinaryDraftDatabaseForTests();
  auth.useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteDatabaseWhenClosed(ORDINARY_DRAFT_DB_NAME);
});

describe("ordinary draft local contention", () => {
  it("enumerates both commit orders for all edit pairings", () => {
    expect(PAIRINGS).toHaveLength(4);
    expect(SCHEDULES).toHaveLength(8);
    expect(SCHEDULES.filter(({ left, right }) => left === right)).toHaveLength(2);
  });

  it.each(SCHEDULES)(
    "$left then $right, committing $order, preserves both local intents",
    async (schedule) => runSchedule(schedule),
  );
});
