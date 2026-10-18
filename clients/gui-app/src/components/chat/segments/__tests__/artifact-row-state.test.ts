import { describe, expect, it } from "vitest";
import type { ToolCallArtifactStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import {
  artifactManifestsEqual,
  selectArtifactRowState,
} from "@/components/chat/segments/artifact-row-state";

const STAMP_SHA = "a".repeat(64);
const HEAD_SHA = "b".repeat(64);

const STAMP: ToolCallArtifactStamp = {
  artifactId: "art-1",
  title: "My Artifact",
  manifest: {
    files: { "index.html": { sha256: STAMP_SHA, byteLength: 100, mediaType: "text/html" } },
    capturedAt: 1_000,
  },
  originChatId: "chat-1",
};

const PROJECTION_BASE: ArtifactProjection = {
  id: "art-1",
  kind: "html",
  title: "My Artifact",
  folderName: "my-artifact",
  parentId: null,
  artifactRoomId: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  status: null,
  createdManually: false,
};

const PROJECTION_WITH_HEAD: ArtifactProjection = {
  ...PROJECTION_BASE,
  head: {
    files: { "index.html": { sha256: HEAD_SHA, byteLength: 120, mediaType: "text/html", status: "published" } },
    capturedAt: 2_000,
  },
};

describe("selectArtifactRowState", () => {
  it("is deleted when the tombstone is confirmed and the projection is absent", () => {
    expect(selectArtifactRowState(STAMP, null, false, true)).toEqual({ kind: "deleted" });
  });

  it("is deleted when the tombstone is confirmed, even behind a stale retained record", () => {
    // A confirmed delete wins regardless of what the row happens to still be
    // holding from before the tombstone arrived.
    expect(selectArtifactRowState(STAMP, PROJECTION_WITH_HEAD, false, true)).toEqual({
      kind: "deleted",
    });
  });

  it("is pending when the projection has not arrived yet and no tombstone confirms a delete", () => {
    expect(selectArtifactRowState(STAMP, null, false, false)).toEqual({ kind: "pending" });
  });

  it("is pending rather than deleted while the record is merely absent so far", () => {
    expect(selectArtifactRowState(STAMP, null, true, false)).toEqual({ kind: "pending" });
  });

  it("is stamped when the projection is live and its stamped object is not missing", () => {
    const result = selectArtifactRowState(STAMP, PROJECTION_BASE, false, false);
    expect(result).toEqual({ kind: "stamped", manifest: STAMP.manifest });
  });

  it("is latest, serving the live head, when the stamped object was evicted and a head exists", () => {
    const result = selectArtifactRowState(STAMP, PROJECTION_WITH_HEAD, true, false);
    expect(result).toEqual({ kind: "latest", manifest: PROJECTION_WITH_HEAD.head });
  });

  it("falls back to the stamped manifest when the stamped object is missing but there is no head to show", () => {
    // `stampedObjectMissing` alone is not enough to promise a replacement
    // document; without a head the row has nothing newer to serve.
    const result = selectArtifactRowState(STAMP, PROJECTION_BASE, true, false);
    expect(result).toEqual({ kind: "stamped", manifest: STAMP.manifest });
  });
});

describe("artifactManifestsEqual", () => {
  const FILES_A: ArtifactManifest = {
    files: { "index.html": { sha256: STAMP_SHA, byteLength: 100, mediaType: "text/html" } },
  };
  const FILES_A_SAME_CONTENT: ArtifactManifest = {
    files: { "index.html": { sha256: STAMP_SHA, byteLength: 100, mediaType: "text/html" } },
  };
  const FILES_B: ArtifactManifest = {
    files: { "index.html": { sha256: HEAD_SHA, byteLength: 120, mediaType: "text/html" } },
  };

  it("is true for the same reference", () => {
    expect(artifactManifestsEqual(FILES_A, FILES_A)).toBe(true);
  });

  it("is true for both null", () => {
    expect(artifactManifestsEqual(null, null)).toBe(true);
  });

  it("is false when only one side is null", () => {
    expect(artifactManifestsEqual(FILES_A, null)).toBe(false);
    expect(artifactManifestsEqual(null, FILES_A)).toBe(false);
  });

  it("is true for distinct objects with identical file content", () => {
    expect(artifactManifestsEqual(FILES_A, FILES_A_SAME_CONTENT)).toBe(true);
  });

  it("is false when a file's sha256 differs", () => {
    expect(artifactManifestsEqual(FILES_A, FILES_B)).toBe(false);
  });

  it("is false when the file counts differ", () => {
    const withExtra: ArtifactManifest = {
      files: {
        ...FILES_A.files,
        "extra.css": { sha256: HEAD_SHA, byteLength: 10, mediaType: "text/css" },
      },
    };
    expect(artifactManifestsEqual(FILES_A, withExtra)).toBe(false);
  });

  it("is false when the same number of files names different paths", () => {
    const renamed: ArtifactManifest = {
      files: { "renamed.html": { sha256: STAMP_SHA, byteLength: 100, mediaType: "text/html" } },
    };
    expect(artifactManifestsEqual(FILES_A, renamed)).toBe(false);
  });
});
