import { describe, expect, it } from "vitest";
import type { WorkspaceSearchPathResult } from "@traycer/protocol/host/workspace/unary-schemas";
import { ancestorDirectoryPathsOf } from "@/lib/workspace/workspace-file-list-tree";
import { projectWorkspaceSearchPaths } from "@/lib/workspace/workspace-path-search-projection";

function file(relPath: string): WorkspaceSearchPathResult {
  return {
    kind: "file",
    relPath,
    name: relPath.split("/").at(-1) ?? relPath,
  };
}

function folder(relPath: string): WorkspaceSearchPathResult {
  return {
    kind: "folder",
    relPath,
    name: relPath.split("/").at(-1) ?? relPath,
  };
}

describe("ancestorDirectoryPathsOf", () => {
  it("names every ancestor as a trailing-slash directory token", () => {
    expect(ancestorDirectoryPathsOf("src/lib/a.ts")).toEqual([
      "src/",
      "src/lib/",
    ]);
  });

  it("treats a directory token like the directory it names", () => {
    expect(ancestorDirectoryPathsOf("src/lib/")).toEqual(["src/"]);
  });

  it("has nothing above a top-level path", () => {
    expect(ancestorDirectoryPathsOf("readme.md")).toEqual([]);
    expect(ancestorDirectoryPathsOf("src/")).toEqual([]);
  });
});

describe("projectWorkspaceSearchPaths", () => {
  it("keeps the host's ranking and canonicalizes folder rows", () => {
    const projection = projectWorkspaceSearchPaths([
      file("src/lib/main.ts"),
      folder("src/mainlib"),
      file("main.md"),
    ]);

    expect(projection.paths).toEqual([
      "src/lib/main.ts",
      // The wire form carries no trailing slash; the tree needs one to render
      // the row as a folder.
      "src/mainlib/",
      "main.md",
    ]);
  });

  it("marks only file rows openable", () => {
    const projection = projectWorkspaceSearchPaths([
      file("src/lib/main.ts"),
      folder("src/mainlib"),
    ]);

    expect(projection.fileNameByPath.get("src/lib/main.ts")).toBe("main.ts");
    expect(projection.fileNameByPath.has("src/mainlib/")).toBe(false);
  });

  it("collects the ancestors every match needs open, deduped", () => {
    const projection = projectWorkspaceSearchPaths([
      file("src/lib/main.ts"),
      file("src/lib/other-main.ts"),
      folder("src/mainlib"),
    ]);

    expect(projection.expandedDirectoryPaths).toEqual(["src/", "src/lib/"]);
  });

  it("projects an empty result set to an empty tree", () => {
    const projection = projectWorkspaceSearchPaths([]);

    expect(projection.paths).toEqual([]);
    expect(projection.expandedDirectoryPaths).toEqual([]);
  });
});
