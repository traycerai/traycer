import type {
  DraftCloudDocument,
  DraftCloudTombstone,
} from "@traycer/protocol/host/drafts";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { createOrdinaryDraftReadSink } from "@/lib/drafts/draft-mirror-coordinator";
import {
  ORDINARY_DRAFT_DB_NAME,
  holdOrdinaryDraftImages,
  readOrdinaryDraftBytes,
  readOrdinaryDraftPartition,
  recoverAbandonedOrdinaryDraftStages,
  resolveOrdinaryDraftScope,
} from "@/lib/drafts/ordinary-draft-db";
import { useAuthStore } from "@/stores/auth/auth-store";
import { waitForOrdinaryDraftEditorWrite } from "@/stores/composer/composer-canvas-persistence";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import type { OrdinaryDraftStorageFixture } from "../../../browser-tests/support/ordinary-draft-storage";
import { sha256Hex } from "@/lib/composer/landing-image-store";

const DRAFT = "1ada7a7f-b8af-4427-885a-af81209d01bc";
const OWNER = "browser-draft-fixture";
const SCOPE = "browser-storage";
const BASE = { revision: 1, ownerEpoch: 1, headSha256: "a".repeat(64) };
const signal = new AbortController().signal;
const noBlob = (): Promise<never> =>
  Promise.reject(new Error("Text fixture requested an image"));

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function landing(): DraftCloudDocument {
  return {
    draftId: DRAFT,
    base: BASE,
    operationId: "browser-initial",
    head: {
      dialect: "draft/v1",
      schemaVersion: { major: 1, minor: 1 },
      kind: "draft",
      surfaceKind: "landing",
      hostLocal: { hostId: "browser-fixture-host", workspace: null },
      target: { epicId: null, chatId: null, blockId: null },
      lastTouchedAt: 1,
      portable: {
        content: content("before"),
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
        annotations: [],
      },
    },
  };
}

async function partition(): Promise<string> {
  const scope = await resolveOrdinaryDraftScope(OWNER, SCOPE);
  if (scope === null) throw new Error("Fixture scope unavailable");
  return scope.partition;
}

interface DeliveryCut {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/** Queue a real conflicting transaction ahead of the renderer's delivery read. */
function holdDeliveryAfterCommit(): DeliveryCut {
  const reached = Promise.withResolvers<void>();
  const prototype = IDBDatabase.prototype;
  const native = Object.getOwnPropertyDescriptor(prototype, "transaction");
  const original: unknown = native?.value;
  if (native === undefined || typeof original !== "function")
    throw new Error("IndexedDB transaction method unavailable");
  const open = (
    database: IDBDatabase,
    names: string | string[],
    mode: IDBTransactionMode | undefined,
    options: IDBTransactionOptions | undefined,
  ): IDBTransaction => {
    const transaction: unknown = Reflect.apply(original, database, [
      names,
      mode,
      options,
    ]);
    if (!(transaction instanceof IDBTransaction))
      throw new Error("Invalid IndexedDB transaction");
    return transaction;
  };
  let paused = true;
  prototype.transaction = function (
    names: string | string[],
    mode: IDBTransactionMode | undefined,
    options: IDBTransactionOptions | undefined,
  ) {
    const write = open(this, names, mode, options);
    if (
      this.name !== ORDINARY_DRAFT_DB_NAME ||
      mode !== "readwrite" ||
      typeof names === "string" ||
      !names.includes("cursors")
    )
      return write;
    Object.defineProperty(prototype, "transaction", native);
    write.addEventListener(
      "complete",
      () => {
        const waiting = open(this, ["drafts"], "readwrite", undefined);
        const store = waiting.objectStore("drafts");
        const keepWaiting = () => {
          if (!paused) return;
          store.getKey(["test-lock", "test-lock"]).onsuccess = keepWaiting;
        };
        keepWaiting();
        reached.resolve();
      },
      { once: true },
    );
    return write;
  };
  return {
    reached: reached.promise,
    release: () => {
      paused = false;
    },
  };
}

let pending: {
  readonly cut: DeliveryCut;
  readonly complete: Promise<void>;
} | null = null;

const browser: OrdinaryDraftStorageFixture = {
  async beginTombstone(): Promise<void> {
    const input = document.querySelector("textarea");
    if (input === null) throw new Error("Fixture editor unavailable");
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: OWNER, username: "fixture" },
    });
    const sink = createOrdinaryDraftReadSink({
      request: noBlob,
      requestWithOptions: noBlob,
    });
    const initial = await sink.prepare(SCOPE, landing(), signal);
    if (initial === null) throw new Error("Fixture initial draft unavailable");
    await initial.commit();
    await initial.release();
    const runtime = draftRuntimeRegistry.getOrHydrate(DRAFT);
    if (runtime === null) throw new Error("Fixture draft runtime unavailable");
    input.value = "before";
    input.addEventListener("input", (event) => {
      if (event.isTrusted) runtime.setSnapshot(content(input.value), null);
    });
    const tombstone: DraftCloudTombstone = {
      draftId: DRAFT,
      base: { ...BASE, revision: 2 },
      operationId: "browser-delete",
    };
    const selected = await sink.prepare(SCOPE, tombstone, signal);
    if (selected === null) throw new Error("Fixture tombstone unavailable");
    const cut = holdDeliveryAfterCommit();
    const complete = (async () => {
      try {
        await selected.commit();
      } finally {
        await selected.release();
      }
    })();
    pending = { cut, complete };
    await cut.reached;
  },
  async finishTombstone(): Promise<unknown> {
    if (pending === null) throw new Error("No tombstone is in flight");
    pending.cut.release();
    await pending.complete;
    const id = await partition();
    if (!(await waitForOrdinaryDraftEditorWrite(id, DRAFT)))
      throw new Error("Fixture edit was withheld");
    const { rows } = await readOrdinaryDraftPartition(id);
    const row = rows.find(({ draftId }) => draftId === DRAFT);
    return {
      editor: row?.editor?.value,
      pending: row?.pending?.reason,
      evidence: row?.evidence?.base.revision,
    };
  },
  async stage(bytes: number, tag: number): Promise<readonly string[]> {
    const first = Uint8Array.of(tag);
    const second = new Uint8Array(bytes).fill(tag + 1);
    const batch = new Map<string, Uint8Array<ArrayBuffer>>(
      await Promise.all(
        [first, second].map(
          async (blob) => [await sha256Hex(blob), blob] as const,
        ),
      ),
    );
    const hold = await holdOrdinaryDraftImages({
      partition: await partition(),
      images: batch,
      signal,
    }).catch(() => null);
    if (hold === null) return [];
    return [...batch.keys()];
  },
  async recover(hashes: readonly string[]): Promise<readonly boolean[]> {
    const id = await partition();
    await recoverAbandonedOrdinaryDraftStages(id);
    return Promise.all(
      hashes.map(
        async (hash) => (await readOrdinaryDraftBytes(id, hash)) !== undefined,
      ),
    );
  },
  async quota(bytes: number): Promise<readonly boolean[]> {
    const first = Uint8Array.of(23);
    const second = new Uint8Array(bytes).fill(24);
    const entries = await Promise.all(
      [first, second].map(
        async (blob) => [await sha256Hex(blob), blob] as const,
      ),
    );
    const id = await partition();
    const hold = await holdOrdinaryDraftImages({
      partition: id,
      images: new Map(entries),
      signal,
    }).catch(() => null);
    await hold?.release();
    const stored = await Promise.all(
      entries.map(
        async ([hash]) =>
          (await readOrdinaryDraftBytes(id, hash)) !== undefined,
      ),
    );
    return [hold === null, ...stored];
  },
};

window.ordinaryDraftBrowser = browser;
