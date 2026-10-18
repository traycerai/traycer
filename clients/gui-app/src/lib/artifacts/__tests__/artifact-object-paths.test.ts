import { describe, expect, it } from "vitest";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import {
  artifactSourcePathsFor,
  artifactTreePath,
  createArtifactOutsideReferenceResolver,
} from "../artifact-object-paths";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function artifact(
  overrides: Partial<ArtifactProjection> &
    Pick<ArtifactProjection, "id" | "kind" | "folderName">,
): ArtifactProjection {
  return {
    title: "Untitled",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
    ...overrides,
  };
}

function slice(artifacts: readonly ArtifactProjection[]): ArtifactsSlice {
  const byId: Record<string, ArtifactProjection> = {};
  const allIds: string[] = [];
  for (const entry of artifacts) {
    byId[entry.id] = entry;
    allIds.push(entry.id);
  }
  return { byId, allIds };
}

describe("artifactTreePath", () => {
  it("walks the folder chain root-to-leaf for nested folder-layout artifacts", () => {
    const artifacts = slice([
      artifact({ id: "root", kind: "spec", folderName: "docs", parentId: null }),
      artifact({ id: "mid", kind: "spec", folderName: "guide", parentId: "root" }),
      artifact({
        id: "leaf",
        kind: "html",
        folderName: "page",
        parentId: "mid",
        layout: "folder",
      }),
    ]);

    expect(artifactTreePath(artifacts, "leaf")).toBe("docs/guide/page");
  });

  it("uses the parent's folder with the loose file's own relativePath", () => {
    const artifacts = slice([
      artifact({ id: "parent", kind: "spec", folderName: "assets" }),
      artifact({
        id: "child",
        kind: "file",
        folderName: "",
        parentId: "parent",
        layout: "file",
        relativePath: "logo.png",
      }),
    ]);

    expect(artifactTreePath(artifacts, "child")).toBe("assets/logo.png");
  });

  it("resolves a top-level loose file with no parent to its bare relativePath", () => {
    const artifacts = slice([
      artifact({
        id: "lone",
        kind: "file",
        folderName: "",
        parentId: null,
        layout: "file",
        relativePath: "notes.txt",
      }),
    ]);

    expect(artifactTreePath(artifacts, "lone")).toBe("notes.txt");
  });

  it("returns null for an id the slice does not carry", () => {
    expect(artifactTreePath(slice([]), "missing")).toBeNull();
  });

  it("returns null on a cyclic parent chain instead of looping forever", () => {
    const artifacts = slice([
      artifact({ id: "a", kind: "spec", folderName: "a", parentId: "b" }),
      artifact({ id: "b", kind: "spec", folderName: "b", parentId: "a" }),
    ]);

    expect(artifactTreePath(artifacts, "a")).toBeNull();
  });

  it("returns null when an ancestor is file-layout - a loose file cannot have children", () => {
    const artifacts = slice([
      artifact({
        id: "loose",
        kind: "file",
        folderName: "",
        parentId: null,
        layout: "file",
        relativePath: "report.pdf",
      }),
      artifact({
        id: "nested",
        kind: "spec",
        folderName: "nested",
        parentId: "loose",
      }),
    ]);

    expect(artifactTreePath(artifacts, "nested")).toBeNull();
  });

  it("falls back to folderName when a file-layout entry has no relativePath of its own", () => {
    const artifacts = slice([
      artifact({ id: "assets", kind: "spec", folderName: "assets" }),
      artifact({
        id: "notes",
        kind: "file",
        folderName: "notes.txt",
        parentId: "assets",
        layout: "file",
      }),
    ]);

    expect(artifactTreePath(artifacts, "notes")).toBe("assets/notes.txt");
  });

  it("still returns null when the fallback folderName is itself empty", () => {
    const artifacts = slice([
      artifact({
        id: "broken",
        kind: "file",
        folderName: "",
        parentId: null,
        layout: "file",
      }),
    ]);

    expect(artifactTreePath(artifacts, "broken")).toBeNull();
  });

  it("returns null for a path an empty folder name makes invalid", () => {
    const artifacts = slice([
      artifact({ id: "empty", kind: "spec", folderName: "" }),
    ]);

    expect(artifactTreePath(artifacts, "empty")).toBeNull();
  });

  it("uses a folder-layout artifact's relativePath as a multi-segment prefix, keeping folderName for display only", () => {
    const artifacts = slice([
      artifact({
        id: "site",
        kind: "html",
        folderName: "site",
        relativePath: "research/site",
        layout: "folder",
      }),
    ]);

    expect(artifactTreePath(artifacts, "site")).toBe("research/site");
  });

  it("resolves a child under a folder-layout relativePath prefix (child resolution)", () => {
    const artifacts = slice([
      artifact({
        id: "site",
        kind: "html",
        folderName: "site",
        relativePath: "research/site",
        layout: "folder",
      }),
      artifact({
        id: "page",
        kind: "html",
        folderName: "page",
        parentId: "site",
        layout: "folder",
      }),
    ]);

    expect(artifactTreePath(artifacts, "page")).toBe("research/site/page");
  });
});

describe("artifactSourcePathsFor", () => {
  it("mounts a folder-layout html artifact at its own folder with index.html as the entry", () => {
    const html = artifact({
      id: "leaf",
      kind: "html",
      folderName: "page",
      parentId: "mid",
      layout: "folder",
    });
    const artifacts = slice([
      artifact({ id: "root", kind: "spec", folderName: "docs" }),
      artifact({ id: "mid", kind: "spec", folderName: "guide", parentId: "root" }),
      html,
    ]);

    expect(artifactSourcePathsFor(html, artifacts)).toEqual({
      treePath: "docs/guide/page",
      entryPath: "index.html",
    });
  });

  it("mounts a file-layout html artifact at its parent's folder with its relativePath as the entry", () => {
    const loose = artifact({
      id: "child",
      kind: "html",
      folderName: "",
      parentId: "parent",
      layout: "file",
      relativePath: "weather.html",
    });
    const artifacts = slice([
      artifact({ id: "parent", kind: "spec", folderName: "docs" }),
      loose,
    ]);

    expect(artifactSourcePathsFor(loose, artifacts)).toEqual({
      treePath: "docs",
      entryPath: "weather.html",
    });
  });

  it("gives a top-level loose html artifact an empty treePath", () => {
    const loose = artifact({
      id: "lone",
      kind: "html",
      folderName: "",
      parentId: null,
      layout: "file",
      relativePath: "weather.html",
    });
    const artifacts = slice([loose]);

    expect(artifactSourcePathsFor(loose, artifacts)).toEqual({
      treePath: "",
      entryPath: "weather.html",
    });
  });

  it("returns null when the artifact's own tree path cannot be resolved", () => {
    const orphan = artifact({
      id: "orphan",
      kind: "html",
      folderName: "page",
      parentId: "missing-parent",
      layout: "folder",
    });

    expect(artifactSourcePathsFor(orphan, slice([orphan]))).toBeNull();
  });

  it("falls back to folderName as the entry when a file-layout artifact has no relativePath", () => {
    const loose = artifact({
      id: "notes",
      kind: "html",
      folderName: "notes.html",
      parentId: "parent",
      layout: "file",
    });
    const artifacts = slice([
      artifact({ id: "parent", kind: "spec", folderName: "docs" }),
      loose,
    ]);

    expect(artifactSourcePathsFor(loose, artifacts)).toEqual({
      treePath: "docs",
      entryPath: "notes.html",
    });
  });

  it("returns null when the fallback folderName is itself empty, leaving no valid path", () => {
    const broken = artifact({
      id: "broken",
      kind: "html",
      folderName: "",
      parentId: null,
      layout: "file",
    });

    expect(artifactSourcePathsFor(broken, slice([broken]))).toBeNull();
  });
});

describe("createArtifactOutsideReferenceResolver", () => {
  it("resolves every manifest file of a folder-layout html artifact at its tree path", () => {
    const html = artifact({
      id: "page",
      kind: "html",
      folderName: "report",
      parentId: "docs",
      layout: "folder",
      head: {
        files: {
          "index.html": { sha256: SHA_A, byteLength: 10, mediaType: "text/html", status: "published" },
          "styles.css": { sha256: SHA_B, byteLength: 20, mediaType: "text/css", status: "published" },
        },
        capturedAt: 1,
      },
    });
    const artifacts = slice([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
      html,
    ]);
    const resolve = createArtifactOutsideReferenceResolver(artifacts);

    expect(resolve("docs/report/index.html")).toEqual({
      sha256: SHA_A,
      byteLength: 10,
      mediaType: "text/html",
      status: "published",
    });
    expect(resolve("docs/report/styles.css")).toEqual({
      sha256: SHA_B,
      byteLength: 20,
      mediaType: "text/css",
      status: "published",
    });
    expect(resolve("docs/report/missing.js")).toBeNull();
  });

  it("maps a file-layout html artifact's manifest entry onto its parent folder (parent-child outside resolution)", () => {
    const loose = artifact({
      id: "weather",
      kind: "html",
      folderName: "",
      parentId: "docs",
      layout: "file",
      relativePath: "weather.html",
      head: {
        files: {
          "index.html": { sha256: SHA_A, byteLength: 42, mediaType: "text/html", status: "published" },
        },
        capturedAt: 1,
      },
    });
    const artifacts = slice([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
      loose,
    ]);
    const resolve = createArtifactOutsideReferenceResolver(artifacts);

    // The manifest key, not the display filename, lands beside the parent
    // folder - the resolver substitutes the real manifest key at every layout.
    expect(resolve("docs/index.html")).toEqual({
      sha256: SHA_A,
      byteLength: 42,
      mediaType: "text/html",
      status: "published",
    });
    expect(resolve("docs/weather.html")).toBeNull();
  });

  it("resolves a file-kind artifact's own bytes at its tree path, with no status field", () => {
    const file = artifact({
      id: "logo",
      kind: "file",
      folderName: "",
      parentId: "assets",
      layout: "file",
      relativePath: "logo.png",
      object: {
        sha256: SHA_A,
        byteLength: 1024,
        mediaType: "image/png",
        status: "published",
      },
    });
    const artifacts = slice([
      artifact({ id: "assets", kind: "spec", folderName: "assets" }),
      file,
    ]);
    const resolve = createArtifactOutsideReferenceResolver(artifacts);

    expect(resolve("assets/logo.png")).toEqual({
      sha256: SHA_A,
      byteLength: 1024,
      mediaType: "image/png",
    });
  });

  it("returns null for any path outside the advertised set", () => {
    const artifacts = slice([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
    ]);

    expect(createArtifactOutsideReferenceResolver(artifacts)("docs/nothing.html")).toBeNull();
  });

  it("drops a path two different artifacts both claim", () => {
    const first = artifact({
      id: "a",
      kind: "file",
      folderName: "",
      parentId: null,
      layout: "file",
      relativePath: "shared.bin",
      object: { sha256: SHA_A, byteLength: 1, mediaType: "application/octet-stream", status: "published" },
    });
    const second = artifact({
      id: "b",
      kind: "file",
      folderName: "shared.bin",
      parentId: null,
      layout: "folder",
      object: { sha256: SHA_B, byteLength: 2, mediaType: "application/octet-stream", status: "published" },
    });
    const resolve = createArtifactOutsideReferenceResolver(slice([first, second]));

    expect(resolve("shared.bin")).toBeNull();
  });

  it("ignores a file artifact with no object at all (upstream validation never leaves a partial one)", () => {
    const noObject = artifact({
      id: "partial",
      kind: "file",
      folderName: "",
      parentId: null,
      layout: "file",
      relativePath: "partial.bin",
      // `object` intentionally absent - the projector drops a file artifact
      // entirely rather than ever surfacing a partially-populated object.
    });

    expect(
      createArtifactOutsideReferenceResolver(slice([noObject]))("partial.bin"),
    ).toBeNull();
  });

  it("skips an artifact whose own tree path cannot be resolved", () => {
    const orphan = artifact({
      id: "orphan",
      kind: "html",
      folderName: "page",
      parentId: "missing-parent",
      layout: "folder",
      head: {
        files: {
          "index.html": { sha256: SHA_A, byteLength: 1, mediaType: "text/html", status: "published" },
        },
        capturedAt: 1,
      },
    });

    expect(
      createArtifactOutsideReferenceResolver(slice([orphan]))("page/index.html"),
    ).toBeNull();
  });
});
