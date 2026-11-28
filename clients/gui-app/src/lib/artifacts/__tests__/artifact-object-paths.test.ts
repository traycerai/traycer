import { describe, expect, it } from "vitest";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving/artifact-manifest";
import {
  artifactSourcePathsFor,
  artifactTreePath,
  createArtifactOutsideReferenceResolver,
  servedArtifactDocument,
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
      artifact({
        id: "root",
        kind: "spec",
        folderName: "docs",
        parentId: null,
      }),
      artifact({
        id: "mid",
        kind: "spec",
        folderName: "guide",
        parentId: "root",
      }),
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
      artifact({
        id: "mid",
        kind: "spec",
        folderName: "guide",
        parentId: "root",
      }),
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
          "index.html": {
            sha256: SHA_A,
            byteLength: 10,
            mediaType: "text/html",
            status: "published",
          },
          "styles.css": {
            sha256: SHA_B,
            byteLength: 20,
            mediaType: "text/css",
            status: "published",
          },
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
          "index.html": {
            sha256: SHA_A,
            byteLength: 42,
            mediaType: "text/html",
            status: "published",
          },
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

  it("resolves a file-kind artifact's own bytes at its tree path, keeping its status", () => {
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

    // ArtifactManifestEntry is the protocol ArtifactObjectRef, status
    // included - the resolver hands the object through wholesale rather
    // than stripping it.
    expect(resolve("assets/logo.png")).toEqual({
      sha256: SHA_A,
      byteLength: 1024,
      mediaType: "image/png",
      status: "published",
    });
  });

  it("returns null for any path outside the advertised set", () => {
    const artifacts = slice([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
    ]);

    expect(
      createArtifactOutsideReferenceResolver(artifacts)("docs/nothing.html"),
    ).toBeNull();
  });

  it("drops a path two different artifacts both claim", () => {
    const first = artifact({
      id: "a",
      kind: "file",
      folderName: "",
      parentId: null,
      layout: "file",
      relativePath: "shared.bin",
      object: {
        sha256: SHA_A,
        byteLength: 1,
        mediaType: "application/octet-stream",
        status: "published",
      },
    });
    const second = artifact({
      id: "b",
      kind: "file",
      folderName: "shared.bin",
      parentId: null,
      layout: "folder",
      object: {
        sha256: SHA_B,
        byteLength: 2,
        mediaType: "application/octet-stream",
        status: "published",
      },
    });
    const resolve = createArtifactOutsideReferenceResolver(
      slice([first, second]),
    );

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
          "index.html": {
            sha256: SHA_A,
            byteLength: 1,
            mediaType: "text/html",
            status: "published",
          },
        },
        capturedAt: 1,
      },
    });

    expect(
      createArtifactOutsideReferenceResolver(slice([orphan]))(
        "page/index.html",
      ),
    ).toBeNull();
  });
});

describe("artifacts the host placed", () => {
  const PLACED_FILE: ArtifactProjection["placement"] = {
    kind: "placed",
    segments: ["docs", "weather-2.html"],
  };
  const UNPLACED: ArtifactProjection["placement"] = {
    kind: "unplaced",
    reason: "hidden-parent",
  };
  const PENDING: ArtifactProjection["placement"] = { kind: "pending" };

  function entry(sha256: string) {
    return {
      sha256,
      byteLength: 5,
      mediaType: "text/html",
      status: "published" as const,
    };
  }

  function looseHtml(
    placement: ArtifactProjection["placement"],
  ): ArtifactProjection {
    return artifact({
      id: "weather",
      kind: "html",
      folderName: "weather.html",
      parentId: "docs",
      layout: "file",
      relativePath: "weather.html",
      head: {
        files: { "captured-on-another-host.html": entry(SHA_A) },
        capturedAt: 1,
      },
      ...(placement === undefined ? {} : { placement }),
    });
  }

  function docsWith(page: ArtifactProjection): ArtifactsSlice {
    return slice([
      artifact({
        id: "docs",
        kind: "spec",
        folderName: "docs",
        placement: { kind: "placed", segments: ["docs"] },
      }),
      page,
    ]);
  }

  it("lays a placed row out by its segments, where the stored fields would answer with the unsuffixed name", () => {
    const stored = docsWith(looseHtml(undefined));
    const placed = docsWith(looseHtml(PLACED_FILE));

    expect(artifactTreePath(stored, "weather")).toBe("docs/weather.html");
    expect(artifactTreePath(placed, "weather")).toBe("docs/weather-2.html");
    expect(artifactSourcePathsFor(placed.byId.weather, placed)).toEqual({
      treePath: "docs",
      entryPath: "weather-2.html",
    });
    expect(artifactSourcePathsFor(stored.byId.weather, stored)).toEqual({
      treePath: "docs",
      entryPath: "weather.html",
    });
  });

  it.each([
    { name: "unplaced", placement: UNPLACED },
    { name: "pending", placement: PENDING },
  ])(
    "derives no path, source or outside reference for a $name row, which a row below 1.7 with the same stored fields has",
    ({ placement }) => {
      const stated = docsWith(looseHtml(placement));
      const legacy = docsWith(looseHtml(undefined));

      expect(artifactTreePath(legacy, "weather")).not.toBeNull();
      expect(
        artifactSourcePathsFor(legacy.byId.weather, legacy),
      ).not.toBeNull();
      expect(
        createArtifactOutsideReferenceResolver(legacy)(
          "docs/captured-on-another-host.html",
        ),
      ).not.toBeNull();
      expect(artifactTreePath(stated, "weather")).toBeNull();
      expect(artifactSourcePathsFor(stated.byId.weather, stated)).toBeNull();
      expect(
        createArtifactOutsideReferenceResolver(stated)(
          "docs/captured-on-another-host.html",
        ),
      ).toBeNull();
    },
  );

  it("serves a placed file-layout page's sole manifest entry at the placed name, whatever its key", () => {
    const page = looseHtml(PLACED_FILE);
    const paths = { treePath: "docs", entryPath: "weather-2.html" };
    if (page.head === undefined) throw new Error("fixture has a head");

    const served = servedArtifactDocument(
      page,
      paths,
      page.head,
      "ignored.html",
    );

    expect(served).toEqual({
      manifest: {
        capturedAt: 1,
        files: { "weather-2.html": entry(SHA_A) },
      },
      treePath: "docs",
      entryPath: "weather-2.html",
    });
  });

  it.each<{ readonly name: string; readonly files: ArtifactManifest["files"] }>(
    [
      { name: "no entry", files: {} },
      {
        name: "two entries",
        files: { "a.html": entry(SHA_A), "b.html": entry(SHA_B) },
      },
    ],
  )(
    "serves nothing for a placed file-layout page whose manifest has $name",
    ({ files }) => {
      const page = looseHtml(PLACED_FILE);

      expect(
        servedArtifactDocument(
          page,
          { treePath: "docs", entryPath: "weather-2.html" },
          { files },
          null,
        ),
      ).toBeNull();
    },
  );

  it("serves a page the host states no placement for as it always has, the version's entry first", () => {
    const page = looseHtml(undefined);
    if (page.head === undefined) throw new Error("fixture has a head");

    expect(
      servedArtifactDocument(
        page,
        { treePath: "docs", entryPath: "weather.html" },
        page.head,
        "pages/old.html",
      ),
    ).toEqual({
      manifest: page.head,
      treePath: "docs",
      entryPath: "pages/old.html",
    });
  });

  it("resolves a placed file-layout page's one file at its placed path only", () => {
    const resolve = createArtifactOutsideReferenceResolver(
      docsWith(looseHtml(PLACED_FILE)),
    );

    expect(resolve("docs/weather-2.html")).toEqual(entry(SHA_A));
    expect(resolve("docs/captured-on-another-host.html")).toBeNull();
  });
});
