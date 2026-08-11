/** Raw record load/codec validation: corrupt rows, schema and reference checks. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import {
  DB_NAME,
  bytesOf,
  entryRow,
  installFreshIndexedDb,
  loadRepo,
  openDb,
  requestToPromise,
  textDoc,
  textEntry,
  textSnapshot,
  transactionComplete,
} from "./prompt-stash-repository-test-helpers";

describe("prompt-stash-repository codec", () => {
  beforeEach(() => {
    vi.resetModules();
    installFreshIndexedDb();
  });

  it("loads empty when nothing is stored and surfaces identifiable corrupt rows as unavailable", async () => {
    const repo = await loadRepo();
    expect(await repo.loadPromptStashSnapshot()).toEqual({
      rows: [],
      revision: 0,
    });

    const older = textEntry("old", 100, "old");
    const newer: PromptStashEntry = {
      id: "new",
      createdAt: 200,
      content: textDoc("new"),
      blobHashes: [],
    };
    await repo.savePromptStashSnapshot(textSnapshot(older));
    await repo.savePromptStashSnapshot(textSnapshot(newer));

    // Inject a malformed row through a raw write. Empty-id records have no
    // recoverable identity and stay invisible; an identifiable broken record
    // surfaces as unavailable rather than disappearing.
    const db = await openDb(DB_NAME, undefined, undefined);
    try {
      const tx = db.transaction("entries", "readwrite");
      await requestToPromise(
        tx.objectStore("entries").put({
          id: "",
          createdAt: 50,
          content: textDoc("bad"),
          blobHashes: [],
        }),
      );
      await requestToPromise(
        tx.objectStore("entries").put({ notAnEntry: true, id: "x" }),
      );
      await transactionComplete(tx);
    } finally {
      db.close();
    }

    const loaded = await repo.loadPromptStashSnapshot();
    expect(loaded.rows).toEqual([
      entryRow(newer),
      entryRow(older),
      { kind: "unavailable", id: "x", createdAt: 0, content: null },
    ]);
    expect(loaded.revision).toBe(2);
  });
  describe("schema and reference validation at load", () => {
    /** Fixed canonical hashes - format-valid, not real digests. */
    const HASH_A =
      "1111111111111111111111111111111111111111111111111111111111111111";
    const HASH_B =
      "2222222222222222222222222222222222222222222222222222222222222222";

    function validImageAttrs(
      overrides: Record<string, unknown>,
    ): Record<string, unknown> {
      return {
        id: "img-1",
        fileName: "shot.png",
        hash: HASH_A,
        b64content: null,
        mimeType: "image/png",
        size: 3,
        ...overrides,
      };
    }

    function docWithImage(attrs: Record<string, unknown>): JsonContent {
      return {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "copyable text" },
              {
                type: "imageAttachment",
                attrs,
              },
            ],
          },
        ],
      };
    }

    async function seedRawEntry(record: {
      readonly id: string;
      readonly createdAt: number;
      readonly content: unknown;
      readonly blobHashes: unknown;
      readonly seedBlob: boolean;
    }): Promise<void> {
      const db = await openDb(DB_NAME, undefined, undefined);
      try {
        const storeNames = record.seedBlob
          ? (["entries", "blobs"] as const)
          : (["entries"] as const);
        const tx = db.transaction([...storeNames], "readwrite");
        await requestToPromise(
          tx.objectStore("entries").put({
            id: record.id,
            createdAt: record.createdAt,
            content: record.content,
            blobHashes: record.blobHashes,
          }),
        );
        if (record.seedBlob) {
          await requestToPromise(
            tx.objectStore("blobs").put({
              hash: HASH_A,
              bytes: bytesOf([1, 2, 3]),
              byteLength: 3,
              mimeType: "image/png",
            }),
          );
        }
        await transactionComplete(tx);
      } finally {
        db.close();
      }
    }

    it("surfaces unknown node type as unavailable with best-effort content", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content = {
        type: "doc",
        content: [
          {
            type: "unknownNode",
            content: [{ type: "text", text: "still copyable" }],
          },
        ],
      };
      await seedRawEntry({
        id: "unknown-node",
        createdAt: 1,
        content,
        blobHashes: [],
        seedBlob: false,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows).toEqual([
        {
          kind: "unavailable",
          id: "unknown-node",
          createdAt: 1,
          content,
        },
      ]);
    });

    it("surfaces unknown mark type as unavailable", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "marked",
                marks: [{ type: "unknownMark" }],
              },
            ],
          },
        ],
      };
      await seedRawEntry({
        id: "unknown-mark",
        createdAt: 1,
        content,
        blobHashes: [],
        seedBlob: false,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows).toEqual([
        {
          kind: "unavailable",
          id: "unknown-mark",
          createdAt: 1,
          content,
        },
      ]);
    });

    it.each([
      {
        name: "empty id",
        attrs: validImageAttrs({ id: "" }),
      },
      {
        name: "missing id",
        attrs: validImageAttrs({ id: undefined }),
      },
      {
        name: "empty fileName",
        attrs: validImageAttrs({ fileName: "" }),
      },
      {
        name: "missing fileName",
        attrs: validImageAttrs({ fileName: undefined }),
      },
      {
        name: "non-canonical mimeType",
        attrs: validImageAttrs({ mimeType: "image/svg+xml" }),
      },
      {
        name: "size zero",
        attrs: validImageAttrs({ size: 0 }),
      },
      {
        name: "size negative",
        attrs: validImageAttrs({ size: -1 }),
      },
      {
        name: "size non-integer",
        attrs: validImageAttrs({ size: 1.5 }),
      },
      {
        name: "b64content present",
        attrs: validImageAttrs({ b64content: "abc" }),
      },
      {
        name: "hash uppercase hex",
        attrs: validImageAttrs({
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      },
      {
        name: "hash wrong length",
        attrs: validImageAttrs({ hash: "abcd" }),
      },
      {
        name: "hash non-hex chars",
        attrs: validImageAttrs({
          hash: "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
        }),
      },
      {
        name: "hash missing",
        attrs: validImageAttrs({ hash: null }),
      },
    ] as const)(
      "surfaces invalid image attrs ($name) as unavailable",
      async ({ name, attrs }) => {
        const repo = await loadRepo();
        await repo.loadPromptStashSnapshot();
        // Drop undefined keys so the field is truly absent from attrs.
        const content = docWithImage(
          Object.fromEntries(
            Object.entries(attrs).filter(([, value]) => value !== undefined),
          ),
        );
        await seedRawEntry({
          id: `bad-img-${name.replace(/\s+/g, "-")}`,
          createdAt: 1,
          content,
          blobHashes: [HASH_A],
          seedBlob: true,
        });
        const loaded = await repo.loadPromptStashSnapshot();
        expect(loaded.rows).toHaveLength(1);
        const row = loaded.rows[0];
        expect(row.kind).toBe("unavailable");
        if (row.kind === "unavailable") {
          expect(row.content).toEqual(content);
        }
      },
    );

    it("surfaces duplicate blobHashes as unavailable", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content = docWithImage(validImageAttrs({}));
      await seedRawEntry({
        id: "dup-hashes",
        createdAt: 1,
        content,
        blobHashes: [HASH_A, HASH_A],
        seedBlob: true,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows[0]?.kind).toBe("unavailable");
    });

    it("surfaces non-canonical blobHashes entry as unavailable", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content = docWithImage(validImageAttrs({ hash: "not-canonical" }));
      await seedRawEntry({
        id: "noncanon-hashes",
        createdAt: 1,
        content,
        blobHashes: ["not-canonical"],
        seedBlob: false,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows[0]?.kind).toBe("unavailable");
    });

    it("surfaces extra blobHashes not referenced by any image node as unavailable", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content = docWithImage(validImageAttrs({ hash: HASH_A }));
      await seedRawEntry({
        id: "extra-hash",
        createdAt: 1,
        content,
        blobHashes: [HASH_A, HASH_B],
        seedBlob: true,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows[0]?.kind).toBe("unavailable");
      if (loaded.rows[0]?.kind === "unavailable") {
        expect(loaded.rows[0].content).toEqual(content);
      }
    });

    it("surfaces blobHashes missing a content-referenced hash as unavailable", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      // Content references HASH_A; blobHashes is empty (missing).
      const content = docWithImage(validImageAttrs({ hash: HASH_A }));
      await seedRawEntry({
        id: "missing-declared",
        createdAt: 1,
        content,
        blobHashes: [],
        seedBlob: true,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows[0]?.kind).toBe("unavailable");
    });

    it("loads a fully valid mention/slash/list/marks/image document as entry", async () => {
      const repo = await loadRepo();
      await repo.loadPromptStashSnapshot();
      const content: JsonContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "slashCommand",
                attrs: {
                  commandName: "implement",
                  harnessId: "claude",
                  kind: "slash-command",
                  description: "Implement",
                  argumentHint: null,
                  path: null,
                  trigger: "/",
                },
              },
              { type: "text", text: " " },
              {
                type: "text",
                text: "bold",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: " and " },
              {
                type: "text",
                text: "linked",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "https://example.com", target: "_blank" },
                  },
                ],
              },
              { type: "text", text: " " },
              {
                type: "mention",
                attrs: {
                  id: "file:src/a.ts",
                  label: "a.ts",
                  mentionType: "file",
                  mentionCategory: "workspace",
                },
              },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "item one" }],
                  },
                ],
              },
            ],
          },
          {
            type: "orderedList",
            attrs: { start: 1 },
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "item two" }],
                  },
                ],
              },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: validImageAttrs({}),
              },
            ],
          },
        ],
      };
      const entry: PromptStashEntry = {
        id: "rich-valid",
        createdAt: 10,
        content,
        blobHashes: [HASH_A],
      };
      await seedRawEntry({
        id: entry.id,
        createdAt: entry.createdAt,
        content: entry.content,
        blobHashes: entry.blobHashes,
        seedBlob: true,
      });
      const loaded = await repo.loadPromptStashSnapshot();
      expect(loaded.rows).toEqual([entryRow(entry)]);
    });
  });
});
