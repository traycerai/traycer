import { draftCloudDocumentSchema } from "@traycer/protocol/host/drafts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("rolls back queued writes when reserving the stage marker fails", async () => {
    const first = await loadOrdinaryWindow();
    const scope = await first.resolveOrdinaryDraftScope("owner-a", "scope-a");
    if (scope === null) throw new Error("ordinary scope was not created");
    const second = await loadOrdinaryWindow();
    const stageId = "stage-already-held";
    const bytes = new Uint8Array([31, 32, 33]);
    await first.stageOrdinaryDraftBytes({
      partition: scope.partition,
      stageId,
      images: new Map([["shared", bytes]]),
    });
    await expect(
      second.stageOrdinaryDraftBytes({
        partition: scope.partition,
        stageId,
        images: new Map([
          ["shared", bytes],
          ["new", new Uint8Array([41, 42, 43])],
        ]),
      }),
    ).rejects.toThrow("Ordinary draft transaction refused");
    expect(
      await first.readOrdinaryDraftBytes(scope.partition, "new"),
    ).toBeUndefined();
    expect(
      numbers(await first.readOrdinaryDraftBytes(scope.partition, "shared")),
    ).toEqual([31, 32, 33]);
    await first.releaseOrdinaryDraftStage(scope.partition, stageId);
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

  it.each(["publish-first", "release-first"])(
    "serializes shared-byte publication and stage release with %s",
    async (order) => {
      const first = await loadOrdinaryWindow();
      const scope = await first.resolveOrdinaryDraftScope("owner-a", "scope-a");
      if (scope === null) throw new Error("ordinary scope was not created");
      const second = await loadOrdinaryWindow();
      const bytes = new Uint8Array([4, 5, 6, 7]);
      const images = new Map<string, ImageBytes>([["shared", bytes]]);
      await first.stageOrdinaryDraftBytes({
        partition: scope.partition,
        stageId: "retired",
        images,
      });
      await second.stageOrdinaryDraftBytes({
        partition: scope.partition,
        stageId: "competing",
        images,
      });
      const row = editorRow({
        partition: scope.partition,
        draftId: "competing",
        slot: "chat",
        text: "competing publication",
        occurrence: "competing-version",
        dirty: false,
      });
      const publish = () =>
        second.writeOrdinaryDraftRow({
          partition: scope.partition,
          draftId: row.draftId,
          cursor: null,
          stageId: "competing",
          signal: null,
          decide: () => ({ ...row, roots: ["shared"] }),
        });
      const release = () =>
        first.releaseOrdinaryDraftStage(scope.partition, "retired");
      await (order === "publish-first"
        ? Promise.all([publish(), release()])
        : Promise.all([release(), publish()]));
      expect(
        numbers(
          await first.readRootedOrdinaryDraftBytes(scope.partition, "shared"),
        ),
      ).toEqual([4, 5, 6, 7]);
      expect(
        await rawOrdinaryGet("stages", [scope.partition, "retired"]),
      ).toBeUndefined();
    },
  );

  it.each(["move-first", "delete-first"])(
    "keeps the recovery move fenced by the current row with %s",
    async (order) => {
      const first = await loadOrdinaryWindow();
      const firstScope = await import("@/lib/drafts/ordinary-draft-scope");
      const projection = await firstScope.openOrdinaryScopeProjection(
        "owner-a",
        "scope-a",
      );
      if (projection === null)
        throw new Error("ordinary scope was not created");
      const { partition } = projection.scope;
      const second = await loadOrdinaryWindow();
      const draftId = "recovery-race";
      const hash = "a".repeat(64);
      const bytes = new Uint8Array([21, 22, 23]);
      const live = draftCloudDocumentSchema.parse({
        draftId,
        base: { headSha256: "b".repeat(64), revision: 1, ownerEpoch: 1 },
        operationId: "recover",
        head: {
          dialect: "draft/v1",
          schemaVersion: { major: 1, minor: 1 },
          kind: "draft",
          surfaceKind: "chat-composer",
          lastTouchedAt: 1,
          target: { chatId: "chat", epicId: "epic", blockId: null },
          hostLocal: { hostId: "host", workspace: null },
          portable: {
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "imageAttachment",
                      attrs: {
                        id: "image",
                        hash,
                        mimeType: "image/png",
                        size: bytes.byteLength,
                        fileName: "image.png",
                        b64content: null,
                        byHashEligible: true,
                      },
                    },
                  ],
                },
              ],
            },
            selection: null,
            annotations: [],
            blobHashes: [hash],
            runSettings: null,
            composerMode: "chat",
            closed: false,
          },
        },
      });
      const row = editorRow({
        partition,
        draftId,
        slot: "chat",
        text: "moved",
        occurrence: "moved-editor",
        dirty: false,
      });
      const editor = row.editor;
      if (editor === null) throw new Error("recovery editor is missing");
      await first.stageOrdinaryDraftBytes({
        partition,
        stageId: "recovery-stage",
        images: new Map([[hash, bytes]]),
      });
      await first.writeOrdinaryDraftRow({
        partition,
        draftId,
        stageId: "recovery-stage",
        cursor: null,
        signal: null,
        decide: () => ({
          ...row,
          evidence: firstScope.ordinaryEvidenceOf(live),
          accepted: live.base,
          acceptedEntry: live,
          editor: null,
          recovery: live,
          roots: [hash],
        }),
      });
      const move = () =>
        firstScope.moveOrdinaryDraftRecovery({
          projection,
          entry: live,
          editor,
          isFree: () => true,
        });
      const deletedBase = {
        ...live.base,
        revision: 2,
        headSha256: "c".repeat(64),
      };
      const tombstone = () =>
        second.writeOrdinaryDraftRow({
          partition,
          draftId,
          stageId: null,
          cursor: null,
          signal: null,
          decide(previous) {
            if (previous === undefined) return undefined;
            return {
              ...previous,
              evidence: {
                base: deletedBase,
                kind: "tombstone",
                operationId: "delete",
                identity: "delete",
                ambiguous: false,
              },
              accepted: deletedBase,
              acceptedEntry: null,
              editor: null,
              recovery: null,
              roots: [],
            };
          },
        });

      expect(
        numbers(await first.readRootedOrdinaryDraftBytes(partition, hash)),
      ).toEqual(Array.from(bytes));
      if (order === "move-first") {
        expect(await move()).toMatchObject({
          editor,
          recovery: null,
          roots: [hash],
        });
        expect(
          numbers(await second.readRootedOrdinaryDraftBytes(partition, hash)),
        ).toEqual(Array.from(bytes));
        await tombstone();
      } else {
        await tombstone();
        await expect(move()).rejects.toThrow(
          "Ordinary draft transaction refused",
        );
      }
      expect(
        await first.readOrdinaryDraftRow(partition, draftId),
      ).toMatchObject({
        accepted: deletedBase,
        editor: null,
        recovery: null,
        roots: [],
      });
      expect(
        await first.readOrdinaryDraftBytes(partition, hash),
      ).toBeUndefined();
    },
  );

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

  it.each([true, false])(
    "handles active and abandoned markers with Web Locks available = %s",
    async (locksAvailable) => {
      const heldNames = new Set<string>();
      vi.stubGlobal("navigator", {
        locks: locksAvailable
          ? {
              async request(
                name: string,
                options: LockOptions,
                grant: (
                  lock: { readonly name: string } | null,
                ) => Promise<void>,
              ): Promise<void> {
                if (heldNames.has(name)) {
                  if (options.ifAvailable !== true)
                    throw new Error("unexpected lock contention");
                  await grant(null);
                  return;
                }
                heldNames.add(name);
                try {
                  await grant({ name });
                } finally {
                  heldNames.delete(name);
                }
              },
            }
          : undefined,
      });
      const first = await loadOrdinaryWindow();
      const scope = await first.resolveOrdinaryDraftScope("owner-a", "scope-a");
      if (scope === null) throw new Error("ordinary scope was not created");
      const second = await loadOrdinaryWindow();
      const signal = new AbortController().signal;
      const active = await first.holdOrdinaryDraftImages({
        partition: scope.partition,
        images: new Map([["active", new Uint8Array([1, 2, 3])]]),
        signal,
      });
      try {
        await first.stageOrdinaryDraftBytes({
          partition: scope.partition,
          stageId: "crashed",
          images: new Map([["abandoned", new Uint8Array([4, 5, 6])]]),
        });
        await second.recoverAbandonedOrdinaryDraftStages(scope.partition);
        expect(
          numbers(
            await second.readOrdinaryDraftBytes(scope.partition, "active"),
          ),
        ).toEqual([1, 2, 3]);
        const abandoned = await second.readOrdinaryDraftBytes(
          scope.partition,
          "abandoned",
        );
        const marker = await rawOrdinaryGet("stages", [
          scope.partition,
          "crashed",
        ]);
        if (locksAvailable) {
          expect(abandoned).toBeUndefined();
          expect(marker).toBeUndefined();
        } else {
          expect(numbers(abandoned)).toEqual([4, 5, 6]);
          expect(marker).toMatchObject({ id: "crashed" });
        }
      } finally {
        await active.release();
      }
    },
  );
});
