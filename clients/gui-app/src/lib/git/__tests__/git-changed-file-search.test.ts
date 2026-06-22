import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  createGitChangedFileSearchIndex,
  filterGitChangedFiles,
} from "@/lib/git/git-changed-file-search";

function makeFile(args: {
  readonly path: string;
  readonly previousPath: string | null;
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: args.previousPath,
    status: args.previousPath === null ? "modified" : "renamed",
    stage: "unstaged",
    insertions: 0,
    deletions: 0,
    isBinary: false,
    sizeBytes: 0,
    stagedOid: null,
    worktreeOid: null,
  };
}

const files = [
  makeFile({ path: "src/stores/epics/git-panel-store.ts", previousPath: null }),
  makeFile({ path: "src/stores/epics/canvas/store.ts", previousPath: null }),
  makeFile({ path: "README.md", previousPath: null }),
  makeFile({
    path: "src/components/new-name.ts",
    previousPath: "src/components/legacy-store.ts",
  }),
];

describe("filterGitChangedFiles", () => {
  it("returns every file with no ranges for an empty query", () => {
    const index = createGitChangedFileSearchIndex(files);
    const result = filterGitChangedFiles(files, index, "   ");
    expect(result).toHaveLength(files.length);
    expect(result.every((match) => match.pathRanges.length === 0)).toBe(true);
  });

  it("matches on the current path and reports highlight ranges", () => {
    const index = createGitChangedFileSearchIndex(files);
    const result = filterGitChangedFiles(files, index, "git-panel-store");
    const paths = result.map((match) => match.file.path);
    expect(paths).toContain("src/stores/epics/git-panel-store.ts");
    const hit = result.find(
      (match) => match.file.path === "src/stores/epics/git-panel-store.ts",
    );
    expect(hit?.pathRanges.length ?? 0).toBeGreaterThan(0);
  });

  it("finds a renamed file by its previous path", () => {
    const index = createGitChangedFileSearchIndex(files);
    const result = filterGitChangedFiles(files, index, "legacy-store");
    const paths = result.map((match) => match.file.path);
    expect(paths).toContain("src/components/new-name.ts");
    // The displayed path does not contain the query, so no highlight ranges.
    const hit = result.find(
      (match) => match.file.path === "src/components/new-name.ts",
    );
    expect(hit?.pathRanges).toEqual([]);
  });
});
