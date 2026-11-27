import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBIndex as FakeIDBIndex } from "fake-indexeddb";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { PERSIST_PREFIX } from "@/lib/persist";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import type {
  OrdinaryDraftCursor,
  OrdinaryDraftRow,
} from "@/lib/drafts/ordinary-draft-db";

const DATABASE = `${PERSIST_PREFIX}:ordinary-drafts`;

type OrdinaryDraftDbWindow = typeof import("@/lib/drafts/ordinary-draft-db");
type LandingImageWindow = typeof import("@/lib/composer/landing-image-store");

async function loadOrdinaryWindow(): Promise<OrdinaryDraftDbWindow> {
  vi.resetModules();
  return import("@/lib/drafts/ordinary-draft-db");
}

async function loadLandingWindow(): Promise<LandingImageWindow> {
  vi.resetModules();
  return import("@/lib/composer/landing-image-store");
}

function editorRow(input: {
  readonly partition: string;
  readonly draftId: string;
  readonly slot: string;
  readonly text: string;
  readonly occurrence: string;
  readonly dirty: boolean;
}): OrdinaryDraftRow {
  const base = {
    headSha256: "a".repeat(64),
    ownerEpoch: 1,
    revision: 1,
  };
  return {
    partition: input.partition,
    draftId: input.draftId,
    evidence: {
      base,
      kind: "live",
      operationId: `operation-${input.draftId}`,
      identity: `identity-${input.draftId}`,
      ambiguous: false,
    },
    accepted: base,
    editor: {
      surface: "chat",
      slot: input.slot,
      value: { text: input.text },
      occurrence: input.occurrence,
      dirty: input.dirty,
    },
    recovery: null,
    roots: [],
  };
}

function cursor(
  partition: string,
  peerId: string,
  seq: number,
): OrdinaryDraftCursor {
  return { partition, peerId, seq };
}

function openOrdinaryDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("ordinary test database open failed"));
  });
}

async function rawOrdinaryPut(
  storeName: "images" | "stages",
  value: unknown,
): Promise<void> {
  const database = await openOrdinaryDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("ordinary test write failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("ordinary test write aborted"));
    });
  } finally {
    database.close();
  }
}

async function rawOrdinaryGet(
  storeName: "images" | "stages",
  key: IDBValidKey,
): Promise<unknown> {
  const database = await openOrdinaryDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("ordinary test read failed"));
    });
  } finally {
    database.close();
  }
}

function numbers(bytes: ArrayLike<number> | undefined): number[] | undefined {
  return bytes === undefined ? undefined : Array.from(bytes);
}

beforeEach(() => {
  installFreshIndexedDb();
  URL.createObjectURL = () => "blob:ordinary-test";
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ordinary draft IndexedDB partition", () => {
  it("preserves two connections' per-row edits and rejects a regressing peer cursor", async () => {
    const firstWindow = await loadOrdinaryWindow();
    const firstScope = await firstWindow.resolveOrdinaryDraftScope(
      "owner-a",
      "scope-a",
    );
    if (firstScope === null) throw new Error("ordinary scope was not created");
    const secondWindow = await loadOrdinaryWindow();
    const secondScope = await secondWindow.resolveOrdinaryDraftScope(
      "owner-a",
      "scope-a",
    );
    if (secondScope === null) throw new Error("ordinary scope was not reused");
    expect(secondScope.partition).toBe(firstScope.partition);
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    await Promise.all([
      firstWindow.stageOrdinaryDraftBytes({
        partition: firstScope.partition,
        stageId: "first-window-stage",
        images: new Map([[firstHash, new Uint8Array([1, 2, 3])]]),
      }),
      secondWindow.stageOrdinaryDraftBytes({
        partition: secondScope.partition,
        stageId: "second-window-stage",
        images: new Map([[secondHash, new Uint8Array([4, 5, 6])]]),
      }),
    ]);

    const firstRow = editorRow({
      partition: firstScope.partition,
      draftId: "draft-row-a",
      slot: "chat-a",
      text: "row a initial",
      occurrence: "a0",
      dirty: false,
    });
    const secondRow = editorRow({
      partition: firstScope.partition,
      draftId: "draft-row-b",
      slot: "chat-b",
      text: "row b initial",
      occurrence: "b0",
      dirty: false,
    });
    await Promise.all([
      firstWindow.writeOrdinaryDraftRow({
        partition: firstScope.partition,
        draftId: firstRow.draftId,
        cursor: cursor(firstScope.partition, "peer-a", 1),
        stageId: "first-window-stage",
        signal: null,
        decide: () => ({ ...firstRow, roots: [firstHash] }),
      }),
      secondWindow.writeOrdinaryDraftRow({
        partition: secondScope.partition,
        draftId: secondRow.draftId,
        cursor: cursor(secondScope.partition, "peer-b", 1),
        stageId: "second-window-stage",
        signal: null,
        decide: () => ({ ...secondRow, roots: [secondHash] }),
      }),
    ]);

    await Promise.all([
      firstWindow.writeOrdinaryDraftRow({
        partition: firstScope.partition,
        draftId: firstRow.draftId,
        cursor: cursor(firstScope.partition, "peer-a", 2),
        stageId: null,
        signal: null,
        decide: (previous) => {
          if (previous?.editor === null || previous === undefined)
            return undefined;
          return {
            ...previous,
            editor: {
              ...previous.editor,
              value: { text: "row a edited" },
              occurrence: "a1",
              dirty: true,
            },
          };
        },
      }),
      secondWindow.writeOrdinaryDraftRow({
        partition: secondScope.partition,
        draftId: secondRow.draftId,
        cursor: cursor(secondScope.partition, "peer-b", 2),
        stageId: null,
        signal: null,
        decide: (previous) => {
          if (previous?.editor === null || previous === undefined)
            return undefined;
          return {
            ...previous,
            editor: {
              ...previous.editor,
              value: { text: "row b edited" },
              occurrence: "b1",
              dirty: true,
            },
          };
        },
      }),
    ]);

    await expect(
      secondWindow.writeOrdinaryDraftRow({
        partition: secondScope.partition,
        draftId: firstRow.draftId,
        cursor: cursor(secondScope.partition, "peer-a", 1),
        stageId: null,
        signal: null,
        decide: (previous) => {
          if (previous?.editor === null || previous === undefined)
            return undefined;
          return {
            ...previous,
            editor: {
              ...previous.editor,
              value: { text: "regressing edit" },
              occurrence: "a-regressed",
              dirty: true,
            },
          };
        },
      }),
    ).rejects.toThrow("Ordinary draft transaction refused");

    const persisted = await secondWindow.readOrdinaryDraftPartition(
      secondScope.partition,
    );
    const byId = new Map(persisted.rows.map((row) => [row.draftId, row]));
    expect(byId.get(firstRow.draftId)?.editor).toEqual({
      surface: "chat",
      slot: "chat-a",
      value: { text: "row a edited" },
      occurrence: "a1",
      dirty: true,
    });
    expect(byId.get(secondRow.draftId)?.editor).toEqual({
      surface: "chat",
      slot: "chat-b",
      value: { text: "row b edited" },
      occurrence: "b1",
      dirty: true,
    });
    expect(persisted.cursors).toEqual([
      cursor(firstScope.partition, "peer-a", 2),
      cursor(secondScope.partition, "peer-b", 2),
    ]);
    expect(byId.get(firstRow.draftId)?.roots).toEqual([firstHash]);
    expect(byId.get(secondRow.draftId)?.roots).toEqual([secondHash]);
    expect(
      numbers(
        await secondWindow.readOrdinaryDraftBytes(
          secondScope.partition,
          firstHash,
        ),
      ),
    ).toEqual([1, 2, 3]);
    expect(
      numbers(
        await firstWindow.readOrdinaryDraftBytes(
          firstScope.partition,
          secondHash,
        ),
      ),
    ).toEqual([4, 5, 6]);
  });

  it("refuses to publish a row and cursor when one rooted byte is missing", async () => {
    const window = await loadOrdinaryWindow();
    const scope = await window.resolveOrdinaryDraftScope("owner-a", "scope-a");
    if (scope === null) throw new Error("ordinary scope was not created");
    const imageHash = "present-image-hash";
    const bytes = new Uint8Array([1, 2, 3]);
    const stageId = "complete-batch";
    await window.stageOrdinaryDraftBytes({
      partition: scope.partition,
      stageId,
      images: new Map<string, ImageBytes>([[imageHash, bytes]]),
    });
    const row = editorRow({
      partition: scope.partition,
      draftId: "draft-missing-byte",
      slot: "chat-missing-byte",
      text: "must not publish",
      occurrence: "missing-byte",
      dirty: false,
    });
    await expect(
      window.writeOrdinaryDraftRow({
        partition: scope.partition,
        draftId: row.draftId,
        cursor: cursor(scope.partition, "peer-a", 9),
        stageId,
        signal: null,
        decide: () => ({ ...row, roots: [imageHash, "missing-image-hash"] }),
      }),
    ).rejects.toThrow("Ordinary draft transaction refused");

    const persisted = await window.readOrdinaryDraftPartition(scope.partition);
    expect(persisted.rows).toEqual([]);
    expect(persisted.cursors).toEqual([]);
    expect(
      numbers(await window.readOrdinaryDraftBytes(scope.partition, imageHash)),
    ).toEqual([1, 2, 3]);
    expect(
      await window.readOrdinaryDraftBytes(
        scope.partition,
        "missing-image-hash",
      ),
    ).toBeUndefined();
    expect(
      await rawOrdinaryGet("stages", [scope.partition, stageId]),
    ).toMatchObject({
      partition: scope.partition,
      id: stageId,
      imageKeys: [`${scope.partition}:${imageHash}`],
    });
    await window.releaseOrdinaryDraftStage(scope.partition, stageId);
  });

  it("keeps a row published by another connection during an image sweep", async () => {
    const firstWindow = await loadOrdinaryWindow();
    const scope = await firstWindow.resolveOrdinaryDraftScope(
      "owner-a",
      "scope-a",
    );
    if (scope === null) throw new Error("ordinary scope was not created");
    const secondWindow = await loadOrdinaryWindow();
    const bytes = new Uint8Array([4, 5, 6, 7]);
    const imageHash = "swept-during-publish";
    await rawOrdinaryPut("images", {
      partition: scope.partition,
      hash: imageHash,
      bytes,
    });
    const row = editorRow({
      partition: scope.partition,
      draftId: "draft-during-sweep",
      slot: "chat-during-sweep",
      text: "published during sweep",
      occurrence: "sweep-publication",
      dirty: false,
    });
    const stageId = "stage-during-sweep";
    const published = new Promise<OrdinaryDraftRow>((resolve, reject) => {
      const getAllKeysSpy = vi.spyOn(FakeIDBIndex.prototype, "getAllKeys");
      getAllKeysSpy.mockImplementation(function (
        this: IDBIndex,
        query: IDBValidKey | IDBKeyRange | null | undefined,
      ) {
        const isSweepCandidates =
          this.name === "partition" &&
          this.objectStore.name === "images" &&
          this.objectStore.transaction.mode === "readonly";
        getAllKeysSpy.mockRestore();
        const request = this.getAllKeys(query);
        if (!isSweepCandidates) return request;
        request.addEventListener(
          "success",
          () => {
            void (async () => {
              await secondWindow.stageOrdinaryDraftBytes({
                partition: scope.partition,
                stageId,
                images: new Map<string, ImageBytes>([[imageHash, bytes]]),
              });
              const result = await secondWindow.writeOrdinaryDraftRow({
                partition: scope.partition,
                draftId: row.draftId,
                cursor: null,
                stageId,
                signal: null,
                decide: () => ({ ...row, roots: [imageHash] }),
              });
              resolve(result);
            })().catch((error: unknown) => {
              reject(
                error instanceof Error
                  ? error
                  : new Error("interleaved draft publish failed"),
              );
            });
          },
          { once: true },
        );
        return request;
      });
    });

    try {
      await firstWindow.sweepOrdinaryDraftImages(scope.partition);
      const committed = await published;
      expect(committed.draftId).toBe(row.draftId);
      const persisted = await firstWindow.readOrdinaryDraftPartition(
        scope.partition,
      );
      expect(persisted.rows.map((stored) => stored.draftId)).toEqual([
        row.draftId,
      ]);
      expect(persisted.rows[0]?.roots).toEqual([imageHash]);
      expect(
        numbers(
          await firstWindow.readOrdinaryDraftBytes(scope.partition, imageHash),
        ),
      ).toEqual([4, 5, 6, 7]);
      expect(
        await rawOrdinaryGet("stages", [scope.partition, stageId]),
      ).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps the released landing image database isolated from ordinary bytes", async () => {
    const landing = await loadLandingWindow();
    const landingBytes = new Uint8Array([8, 9, 10]);
    const landingHash = await landing.sha256Hex(landingBytes);
    await landing.putImage(landingBytes);
    const ordinaryBytes = new Uint8Array([11, 12, 13, 14]);
    const ordinaryHash = await landing.sha256Hex(ordinaryBytes);

    const ordinary = await loadOrdinaryWindow();
    const scope = await ordinary.resolveOrdinaryDraftScope(
      "owner-a",
      "scope-a",
    );
    if (scope === null) throw new Error("ordinary scope was not created");
    const stageId = "downgrade-isolation-stage";
    await ordinary.stageOrdinaryDraftBytes({
      partition: scope.partition,
      stageId,
      images: new Map<string, ImageBytes>([[ordinaryHash, ordinaryBytes]]),
    });
    const row = editorRow({
      partition: scope.partition,
      draftId: "draft-downgrade-isolation",
      slot: "landing",
      text: "ordinary draft image",
      occurrence: "ordinary-image",
      dirty: false,
    });
    await ordinary.writeOrdinaryDraftRow({
      partition: scope.partition,
      draftId: row.draftId,
      cursor: null,
      stageId,
      signal: null,
      decide: () => ({ ...row, roots: [ordinaryHash] }),
    });

    const uncommittedStage = "ordinary-stage-during-downgrade";
    await ordinary.stageOrdinaryDraftBytes({
      partition: scope.partition,
      stageId: uncommittedStage,
      images: new Map<string, ImageBytes>([[ordinaryHash, ordinaryBytes]]),
    });
    landing.releaseSession(landingHash);
    const releasedSweep = await import("@/lib/composer/landing-image-gc");
    releasedSweep.markLandingDraftsReady();
    await releasedSweep.reconcile();
    expect(await landing.getImageBytes(landingHash)).toBeUndefined();
    expect(await landing.getImageBytes(ordinaryHash)).toBeUndefined();
    const reopened = await loadOrdinaryWindow();
    expect(
      numbers(
        await reopened.readOrdinaryDraftBytes(scope.partition, ordinaryHash),
      ),
    ).toEqual([11, 12, 13, 14]);
    expect(
      await rawOrdinaryGet("stages", [scope.partition, uncommittedStage]),
    ).toBeDefined();
    expect(
      await ordinary.readOrdinaryDraftBytes(scope.partition, landingHash),
    ).toBeUndefined();
  });

  it("preserves a foreign stage marker without Web Locks", async () => {
    vi.stubGlobal("navigator", { locks: undefined });
    expect(Reflect.get(navigator, "locks")).toBeUndefined();
    const firstWindow = await loadOrdinaryWindow();
    const scope = await firstWindow.resolveOrdinaryDraftScope(
      "owner-a",
      "scope-a",
    );
    if (scope === null) throw new Error("ordinary scope was not created");
    const secondWindow = await loadOrdinaryWindow();
    const bytes = new Uint8Array([15, 16, 17]);
    const imageHash = "foreign-stage-image";
    const stageId = "foreign-window-stage";
    await firstWindow.stageOrdinaryDraftBytes({
      partition: scope.partition,
      stageId,
      images: new Map<string, ImageBytes>([[imageHash, bytes]]),
    });

    await secondWindow.sweepOrdinaryDraftImages(scope.partition);

    expect(
      numbers(
        await secondWindow.readOrdinaryDraftBytes(scope.partition, imageHash),
      ),
    ).toEqual([15, 16, 17]);
    expect(
      await rawOrdinaryGet("stages", [scope.partition, stageId]),
    ).toMatchObject({
      partition: scope.partition,
      id: stageId,
      imageKeys: [`${scope.partition}:${imageHash}`],
    });
    await firstWindow.releaseOrdinaryDraftStage(scope.partition, stageId);
    expect(
      await secondWindow.readOrdinaryDraftBytes(scope.partition, imageHash),
    ).toBeUndefined();
  });
});
