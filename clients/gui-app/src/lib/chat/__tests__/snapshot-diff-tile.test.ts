import { describe, expect, it } from "vitest";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  makeSnapshotCumulativeBundleDiffTile,
  makeSnapshotCumulativeDiffTile,
  makeSnapshotHashDiffTile,
  makeSnapshotSegmentDiffTile,
  snapshotDiffTileId,
} from "@/lib/chat/snapshot-diff-tile";

const HOST = "host-1";

describe("snapshot diff tile factories", () => {
  it("derives a deterministic id and human name for a segment tile", () => {
    const tile = makeSnapshotSegmentDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      sourceBlockIds: ["blk-1"],
      filePath: "src/feature/app.ts",
    });
    expect(tile.type).toBe("snapshot-diff");
    expect(tile.name).toBe("app.ts · edit");
    expect(tile.id).toBe(snapshotDiffTileId(HOST, tile.diff));
  });

  it("names a cumulative tile after its file with a changes suffix", () => {
    const tile = makeSnapshotCumulativeDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "src/feature/app.ts",
    });
    expect(tile.name).toBe("app.ts · changes");
  });

  it("normalizes cumulative bundle file paths for stable identity", () => {
    const tile = makeSnapshotCumulativeBundleDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePaths: ["src/b.ts", "src/a.ts", "src/a.ts"],
    });
    expect(tile.name).toBe("2 files changed");
    expect(tile.diff).toEqual({
      kind: "snapshot-cumulative-bundle",
      chatId: "chat-1",
      filePaths: ["src/a.ts", "src/b.ts"],
    });
    expect(tile.id).toBe(
      makeSnapshotCumulativeBundleDiffTile({
        hostId: HOST,
        chatId: "chat-1",
        filePaths: ["src/a.ts", "src/b.ts"],
      }).id,
    );
  });

  it("normalizes cumulative bundle file paths when recomputing ids", () => {
    expect(
      snapshotDiffTileId(HOST, {
        kind: "snapshot-cumulative-bundle",
        chatId: "chat-1",
        filePaths: ["src/b.ts", "src/a.ts", "src/a.ts"],
      }),
    ).toBe(
      snapshotDiffTileId(HOST, {
        kind: "snapshot-cumulative-bundle",
        chatId: "chat-1",
        filePaths: ["src/a.ts", "src/b.ts"],
      }),
    );
  });

  it("names an artifact-hash tile after its title with a diff suffix", () => {
    const tile = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });
    expect(tile.type).toBe("snapshot-diff");
    expect(tile.name).toBe("Auth Spec · diff");
    expect(tile.diff).toEqual({
      kind: "snapshot-hash",
      chatId: "chat-1",
      filePath: "index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });
    expect(tile.id).toBe(snapshotDiffTileId(HOST, tile.diff));
  });

  it("falls back to the file basename when an artifact-hash tile has no title", () => {
    const tile = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "specs/index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: null,
    });
    expect(tile.name).toBe("index.md · diff");
  });

  it("keys an artifact-hash tile id on the hash pair, not the file path", () => {
    // The card passes "index.md" and the change row passes the absolute path
    // for the same edit; both must converge on one tile so they dedupe.
    const fromCard = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });
    const fromRow = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "/abs/epics/e/artifacts/auth/index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });
    expect(fromRow.id).toBe(fromCard.id);
  });

  it("keeps distinct artifact-hash tile ids by file path when both hashes are null", () => {
    // Degenerate (UI-unreachable) case: with no hashes, the id falls back to the
    // file path so two different artifacts don't collide into one `hash:<chat>::`
    // tile.
    const a = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "c1",
      filePath: "a/index.md",
      beforeHash: null,
      afterHash: null,
      title: null,
    });
    const b = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "c1",
      filePath: "b/index.md",
      beforeHash: null,
      afterHash: null,
      title: null,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("ids differ across segment, cumulative, chat, and source ids", () => {
    const ids = new Set([
      makeSnapshotSegmentDiffTile({
        hostId: HOST,
        chatId: "c1",
        sourceBlockIds: ["b1"],
        filePath: "a.ts",
      }).id,
      makeSnapshotSegmentDiffTile({
        hostId: HOST,
        chatId: "c1",
        sourceBlockIds: ["b2"],
        filePath: "a.ts",
      }).id,
      makeSnapshotSegmentDiffTile({
        hostId: HOST,
        chatId: "c2",
        sourceBlockIds: ["b1"],
        filePath: "a.ts",
      }).id,
      makeSnapshotCumulativeDiffTile({
        hostId: HOST,
        chatId: "c1",
        filePath: "a.ts",
      }).id,
      makeSnapshotCumulativeBundleDiffTile({
        hostId: HOST,
        chatId: "c1",
        filePaths: ["a.ts"],
      }).id,
      makeSnapshotHashDiffTile({
        hostId: HOST,
        chatId: "c1",
        filePath: "index.md",
        beforeHash: "h0",
        afterHash: "h1",
        title: null,
      }).id,
    ]);
    expect(ids.size).toBe(6);
  });
});

describe("snapshot diff tile schema round-trip", () => {
  it("survives serialize -> parse for a segment tile", () => {
    const tile = makeSnapshotSegmentDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      sourceBlockIds: ["blk-1"],
      filePath: "src/app.ts",
    });
    const parsed = parseTileRef(serializeTileRef(tile));
    expect(parsed).toEqual(tile);
  });

  it("survives serialize -> parse for a cumulative tile", () => {
    const tile = makeSnapshotCumulativeDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "src/app.ts",
    });
    const parsed = parseTileRef(serializeTileRef(tile));
    expect(parsed).toEqual(tile);
  });

  it("survives serialize -> parse for a cumulative bundle tile", () => {
    const tile = makeSnapshotCumulativeBundleDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePaths: ["src/app.ts", "src/other.ts"],
    });
    const parsed = parseTileRef(serializeTileRef(tile));
    expect(parsed).toEqual(tile);
  });

  it("survives serialize -> parse for an artifact-hash tile", () => {
    const tile = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });
    const parsed = parseTileRef(serializeTileRef(tile));
    expect(parsed).toEqual(tile);
  });

  it("round-trips an artifact-hash tile with null hashes (create / delete)", () => {
    const tile = makeSnapshotHashDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      filePath: "index.md",
      beforeHash: null,
      afterHash: "h1",
      title: null,
    });
    const parsed = parseTileRef(serializeTileRef(tile));
    expect(parsed).toEqual(tile);
  });

  it("recomputes the id on parse so persisted tiles self-heal dedup", () => {
    const tile = makeSnapshotSegmentDiffTile({
      hostId: HOST,
      chatId: "chat-1",
      sourceBlockIds: ["blk-1"],
      filePath: "src/app.ts",
    });
    // A persisted tile that carried a stale (random-uuid) id must re-derive
    // the deterministic id from its payload on rehydrate.
    const parsed = parseTileRef({
      id: "stale-uuid",
      type: "snapshot-diff",
      name: "app.ts · edit",
      hostId: HOST,
      diff: {
        kind: "snapshot-segment",
        chatId: "chat-1",
        sourceBlockIds: ["blk-1"],
        filePath: "src/app.ts",
      },
      view: {
        collapsedFilePaths: [],
      },
    });
    expect(parsed?.id).toBe(tile.id);
  });
});
