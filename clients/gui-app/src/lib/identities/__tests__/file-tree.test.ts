/**
 * Pure coverage of `buildIdentityFileTree`'s grouping, pending badge,
 * tombstone skip, media-type/byteLength carry-through and sort, plus the
 * preview-type predicates and byte-length formatter.
 */
import { describe, expect, it } from "vitest";
import {
  buildIdentityFileTree,
  formatByteLength,
  identityFileGroupOf,
  isPreviewableImage,
  isPreviewableText,
} from "@/lib/identities/file-tree";
import type {
  IdentityDocumentProjection,
  IdentityDocumentsSlice,
  IdentityFileProjection,
  IdentityFilesSlice,
} from "@/stores/identities/open-identity/types";
import type { AgentIdentityFileRow } from "@traycer/protocol/host/agent-identity/state-subscribe";

function documentsSlice(paths: readonly string[]): IdentityDocumentsSlice {
  const byPath: Record<string, IdentityDocumentProjection> = {};
  for (const path of paths) {
    byPath[path] = {
      path,
      shardRoomId: "shard-a",
      fragmentName: "doc",
      updatedAt: 1000,
      provenance: "agent",
    };
  }
  return { byPath, allPaths: [...paths].sort() };
}

function blobEntry(
  overrides: Partial<AgentIdentityFileRow["entry"]>,
): AgentIdentityFileRow["entry"] {
  return {
    v: 1,
    kind: "blob",
    current: {
      sha256: "a".repeat(64),
      byteLength: 2048,
      mediaType: "application/octet-stream",
      createdAt: 1000,
      createdBy: "user-1",
      producer: { type: "agent", chatId: "chat-1" },
    },
    versions: [],
    status: "available",
    derivedFrom: [],
    deletedAt: null,
    executable: false,
    ...overrides,
  };
}

function filesSlice(
  entries: Readonly<Record<string, AgentIdentityFileRow["entry"]>>,
): IdentityFilesSlice {
  const byPath: Record<string, IdentityFileProjection> = {};
  for (const [path, entry] of Object.entries(entries)) {
    byPath[path] = { path, entry };
  }
  return { byPath, allPaths: Object.keys(entries).sort() };
}

const EMPTY_DOCUMENTS: IdentityDocumentsSlice = { byPath: {}, allPaths: [] };
const EMPTY_FILES: IdentityFilesSlice = { byPath: {}, allPaths: [] };

describe("identityFileGroupOf", () => {
  it("groups a root-level markdown file as soul", () => {
    expect(identityFileGroupOf("SOUL.md")).toBe("soul");
  });

  it("groups memories/** as memories", () => {
    expect(identityFileGroupOf("memories/x.md")).toBe("memories");
  });

  it("groups skills/** as skills", () => {
    expect(identityFileGroupOf("skills/y/SKILL.md")).toBe("skills");
  });

  it("groups anything else with a folder as other", () => {
    expect(identityFileGroupOf("bin/tool")).toBe("other");
  });
});

describe("buildIdentityFileTree - grouping", () => {
  it("sorts documents and blobs into their groups", () => {
    const documents = documentsSlice([
      "SOUL.md",
      "memories/x.md",
      "skills/y/SKILL.md",
    ]);
    const files = filesSlice({ "bin/tool": blobEntry({}) });

    const tree = buildIdentityFileTree(documents, files);
    const byGroup = new Map(tree.map((group) => [group.id, group]));

    expect(byGroup.get("soul")?.files.map((f) => f.path)).toEqual(["SOUL.md"]);
    expect(byGroup.get("memories")?.files.map((f) => f.path)).toEqual([
      "memories/x.md",
    ]);
    expect(byGroup.get("skills")?.files.map((f) => f.path)).toEqual([
      "skills/y/SKILL.md",
    ]);
    expect(byGroup.get("other")?.files.map((f) => f.path)).toEqual([
      "bin/tool",
    ]);
  });

  it("returns all four groups even when some are empty", () => {
    const tree = buildIdentityFileTree(EMPTY_DOCUMENTS, EMPTY_FILES);
    expect(tree.map((group) => group.id)).toEqual([
      "soul",
      "memories",
      "skills",
      "other",
    ]);
    expect(tree.every((group) => group.files.length === 0)).toBe(true);
  });
});

describe("buildIdentityFileTree - blob fields", () => {
  it("marks a pending blob as pending", () => {
    const files = filesSlice({
      "logo.png": blobEntry({ status: "pending" }),
    });
    const tree = buildIdentityFileTree(EMPTY_DOCUMENTS, files);
    const entry = tree
      .flatMap((group) => group.files)
      .find((f) => f.path === "logo.png");
    expect(entry?.pending).toBe(true);
    expect(entry?.status).toBe("pending");
  });

  it("does not mark an available blob as pending", () => {
    const files = filesSlice({
      "logo.png": blobEntry({ status: "available" }),
    });
    const tree = buildIdentityFileTree(EMPTY_DOCUMENTS, files);
    const entry = tree
      .flatMap((group) => group.files)
      .find((f) => f.path === "logo.png");
    expect(entry?.pending).toBe(false);
  });

  it("skips a tombstoned (deletedAt non-null) blob entirely", () => {
    const files = filesSlice({
      "gone.png": blobEntry({ deletedAt: 5000 }),
      "here.png": blobEntry({}),
    });
    const tree = buildIdentityFileTree(EMPTY_DOCUMENTS, files);
    const paths = tree.flatMap((group) => group.files).map((f) => f.path);
    expect(paths).toEqual(["here.png"]);
  });

  it("carries the manifest media type and byte length for a blob", () => {
    const files = filesSlice({
      "logo.png": blobEntry({
        current: {
          sha256: "b".repeat(64),
          byteLength: 4096,
          mediaType: "image/png",
          createdAt: 1000,
          createdBy: "user-1",
          producer: { type: "agent", chatId: "chat-1" },
        },
      }),
    });
    const tree = buildIdentityFileTree(EMPTY_DOCUMENTS, files);
    const entry = tree
      .flatMap((group) => group.files)
      .find((f) => f.path === "logo.png");
    expect(entry?.mediaType).toBe("image/png");
    expect(entry?.byteLength).toBe(4096);
    expect(entry?.kind).toBe("blob");
  });

  it("a document carries the markdown media type and a null byte length", () => {
    const documents = documentsSlice(["SOUL.md"]);
    const tree = buildIdentityFileTree(documents, EMPTY_FILES);
    const entry = tree
      .flatMap((group) => group.files)
      .find((f) => f.path === "SOUL.md");
    expect(entry?.mediaType).toBe("text/markdown");
    expect(entry?.byteLength).toBeNull();
    expect(entry?.kind).toBe("document");
  });
});

describe("buildIdentityFileTree - sort", () => {
  it("sorts entries within a group by path", () => {
    const documents = documentsSlice(["Z.md", "A.md"]);
    const tree = buildIdentityFileTree(documents, EMPTY_FILES);
    const soul = tree.find((group) => group.id === "soul");
    expect(soul?.files.map((f) => f.path)).toEqual(["A.md", "Z.md"]);
  });
});

describe("isPreviewableImage", () => {
  it("accepts common raster and vector image types", () => {
    expect(isPreviewableImage("image/png")).toBe(true);
    expect(isPreviewableImage("image/jpeg")).toBe(true);
    expect(isPreviewableImage("image/svg+xml")).toBe(true);
  });

  it("rejects a non-image media type", () => {
    expect(isPreviewableImage("application/pdf")).toBe(false);
  });
});

describe("isPreviewableText", () => {
  it("accepts every text/* media type", () => {
    expect(isPreviewableText("text/plain")).toBe(true);
    expect(isPreviewableText("text/markdown")).toBe(true);
  });

  it("accepts known structured-text application types", () => {
    expect(isPreviewableText("application/json")).toBe(true);
    expect(isPreviewableText("application/x-yaml")).toBe(true);
  });

  it("rejects a binary media type", () => {
    expect(isPreviewableText("image/png")).toBe(false);
    expect(isPreviewableText("application/octet-stream")).toBe(false);
  });
});

describe("formatByteLength", () => {
  it("formats sub-1024 byte counts as bytes", () => {
    expect(formatByteLength(512)).toBe("512 B");
  });

  it("formats sub-1MB counts as kilobytes with one decimal", () => {
    expect(formatByteLength(2048)).toBe("2.0 KB");
  });

  it("formats megabyte-scale counts as megabytes with one decimal", () => {
    expect(formatByteLength(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
