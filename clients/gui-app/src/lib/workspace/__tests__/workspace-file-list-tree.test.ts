import { describe, expect, it } from "vitest";
import type { WorkspaceFileListEntry } from "@traycer/protocol/host/workspace/subscribe";
import {
  isWithinDirectory,
  mergeExpandedDirectoryPaths,
  parentDirectoryPathOf,
  projectWorkspaceFileList,
  selectWatchableDirectoryPaths,
  sortDirectoryPathsAncestorsFirst,
  type WorkspaceFileListDirectoryListing,
} from "@/lib/workspace/workspace-file-list-tree";

function file(path: string, ignored: boolean): WorkspaceFileListEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "file",
    ignored,
  };
}

function directory(path: string, ignored: boolean): WorkspaceFileListEntry {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return {
    path,
    name: segments.at(-1) ?? path,
    kind: "directory",
    ignored,
  };
}

function listing(
  entries: ReadonlyArray<WorkspaceFileListEntry>,
  truncated: boolean,
): WorkspaceFileListDirectoryListing {
  return { entries, truncated };
}

describe("parentDirectoryPathOf", () => {
  it("walks trailing-slash directory tokens up to the root", () => {
    expect(parentDirectoryPathOf("src/lib/")).toBe("src/");
    expect(parentDirectoryPathOf("src/")).toBe("");
  });

  it("has no parent for the root or a non-directory token", () => {
    expect(parentDirectoryPathOf("")).toBeNull();
    expect(parentDirectoryPathOf("src/main.ts")).toBeNull();
  });
});

describe("isWithinDirectory", () => {
  it("treats the trailing slash as an exact boundary", () => {
    expect(isWithinDirectory("src/lib/a.ts", "src/")).toBe(true);
    expect(isWithinDirectory("src-generated/a.ts", "src/")).toBe(false);
  });

  it("puts every path under the root token", () => {
    expect(isWithinDirectory("src/a.ts", "")).toBe(true);
  });
});

describe("selectWatchableDirectoryPaths", () => {
  it("orders a batch ancestors-first", () => {
    expect(
      selectWatchableDirectoryPaths(["src/lib/deep/", "src/", "src/lib/"]),
    ).toEqual(["src/", "src/lib/", "src/lib/deep/"]);
  });

  it("drops a directory whose ancestor is not expanded", () => {
    // Collapsing `src/` leaves `src/lib/` marked expanded so re-expanding
    // restores the subtree - but watching it would violate the contract's
    // ancestor precondition and be pruned.
    expect(selectWatchableDirectoryPaths(["src/lib/"])).toEqual([]);
  });

  it("never names the always-covered root", () => {
    expect(selectWatchableDirectoryPaths(["", "src/"])).toEqual(["src/"]);
  });
});

describe("sortDirectoryPathsAncestorsFirst", () => {
  it("sorts by depth before name", () => {
    expect(sortDirectoryPathsAncestorsFirst(["b/a/", "a/"])).toEqual([
      "a/",
      "b/a/",
    ]);
  });
});

describe("mergeExpandedDirectoryPaths", () => {
  const expandedInTree = (paths: ReadonlyArray<string>) => (path: string) =>
    paths.includes(path);

  it("keeps a restored path the tree has not listed yet", () => {
    // On mount the tree knows nothing, so reading it alone would wipe the
    // restored set before the batched watch frame could ask for it.
    expect(
      mergeExpandedDirectoryPaths(["src/", "src/lib/"], [], expandedInTree([])),
    ).toEqual(["src/", "src/lib/"]);
  });

  it("takes a collapse from the tree for a directory it knows", () => {
    expect(
      mergeExpandedDirectoryPaths(
        ["src/", "docs/"],
        ["src/", "docs/"],
        expandedInTree(["docs/"]),
      ),
    ).toEqual(["docs/"]);
  });

  it("remembers a nested expansion once its parent's rows are gone", () => {
    expect(
      mergeExpandedDirectoryPaths(
        ["src/", "src/lib/"],
        ["src/"],
        expandedInTree([]),
      ),
    ).toEqual(["src/lib/"]);
  });
});

describe("projectWorkspaceFileList", () => {
  it("unions covered listings into a flat path list", () => {
    const listings = new Map([
      [
        "",
        listing([directory("src/", false), file("readme.md", false)], false),
      ],
      ["src/", listing([file("src/main.ts", false)], false)],
    ]);

    const projection = projectWorkspaceFileList(
      listings,
      new Set(["", "src/"]),
    );

    expect([...projection.paths].toSorted()).toEqual([
      "readme.md",
      "src/",
      "src/main.ts",
    ]);
    expect(projection.fileNameByPath.get("src/main.ts")).toBe("main.ts");
    // Directory rows are not openable.
    expect(projection.fileNameByPath.has("src/")).toBe(false);
  });

  it("ignores listings for directories that are no longer covered", () => {
    const listings = new Map([
      ["", listing([directory("src/", false)], false)],
      ["src/", listing([file("src/main.ts", false)], false)],
    ]);

    const projection = projectWorkspaceFileList(listings, new Set([""]));

    expect(projection.paths).toEqual(["src/"]);
  });

  it("reports ignored entries without suppressing them", () => {
    const listings = new Map([
      [
        "",
        listing([directory("node_modules/", true), file(".env", true)], false),
      ],
      ["node_modules/", listing([file("node_modules/pkg.js", true)], false)],
    ]);

    const projection = projectWorkspaceFileList(
      listings,
      new Set(["", "node_modules/"]),
    );

    expect(projection.paths).toContain("node_modules/pkg.js");
    // The entry inside an already-ignored directory inherits its dimming, so
    // it contributes no marker of its own.
    expect([...projection.ignoredPaths].toSorted()).toEqual([
      ".env",
      "node_modules/",
    ]);
  });

  it("surfaces truncation from any covered directory", () => {
    const listings = new Map([
      ["", listing([directory("src/", false)], false)],
      ["src/", listing([file("src/main.ts", false)], true)],
    ]);

    expect(
      projectWorkspaceFileList(listings, new Set(["", "src/"])).truncated,
    ).toBe(true);
  });
});
