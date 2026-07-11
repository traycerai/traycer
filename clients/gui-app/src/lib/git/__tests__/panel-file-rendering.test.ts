import { describe, expect, it } from "vitest";
import {
  FileTree as PierreFileTree,
  type FileTreeDirectoryHandle,
  type FileTreeItemHandle,
} from "@pierre/trees";
import type {
  GitChangedFile,
  GitFileStatus,
  GitStage,
} from "@traycer/protocol/host";
import {
  buildGitFileRowMetadata,
  buildGitPanelFileSections,
  buildGitTreeDirectoryPaths,
  buildGitTreeRowDirectoryPaths,
  gitChangedFileTooltipContent,
  gitChangedFileToPierreStatus,
  gitChangedFileToPierreStatusEntry,
  gitStageBundleGroup,
  mergeGitTreeExpandedDirectoryPaths,
  sortGitPanelFlatFiles,
  splitGitChangedFiles,
} from "@/lib/git/panel-file-rendering";

function makeFile(args: {
  readonly path: string;
  readonly status: GitFileStatus;
  readonly stage: GitStage;
  readonly previousPath: string | null;
  readonly insertions: number;
  readonly deletions: number;
}): GitChangedFile {
  return {
    path: args.path,
    previousPath: args.previousPath,
    status: args.status,
    stage: args.stage,
    insertions: args.insertions,
    deletions: args.deletions,
    isBinary: false,
    sizeBytes: 0,
    stagedOid: null,
    worktreeOid: null,
  };
}

function makeModifiedFile(path: string): GitChangedFile {
  return makeFile({
    path,
    status: "modified",
    stage: "unstaged",
    previousPath: null,
    insertions: 1,
    deletions: 0,
  });
}

function isDirectoryHandle(
  item: FileTreeItemHandle | null,
): item is FileTreeDirectoryHandle {
  return item !== null && item.isDirectory();
}

describe("git panel file rendering helpers", () => {
  it("maps Traycer Git statuses into Pierre's supported status set", () => {
    expect(
      gitChangedFileToPierreStatus(
        makeFile({
          path: "src/new.ts",
          status: "added",
          stage: "staged",
          previousPath: null,
          insertions: 1,
          deletions: 0,
        }),
      ),
    ).toBe("added");
    expect(
      gitChangedFileToPierreStatus(
        makeFile({
          path: "src/untracked.ts",
          status: "untracked",
          stage: "untracked",
          previousPath: null,
          insertions: 1,
          deletions: 0,
        }),
      ),
    ).toBe("added");
    expect(
      gitChangedFileToPierreStatus(
        makeFile({
          path: "src/copy.ts",
          status: "copied",
          stage: "staged",
          previousPath: "src/source.ts",
          insertions: 1,
          deletions: 0,
        }),
      ),
    ).toBe("renamed");
    expect(
      gitChangedFileToPierreStatus(
        makeFile({
          path: "src/conflict.ts",
          status: "conflicted",
          stage: "conflicted",
          previousPath: null,
          insertions: 2,
          deletions: 3,
        }),
      ),
    ).toBe("modified");
  });

  it("builds Pierre status entries with repo-relative paths", () => {
    const file = makeModifiedFile("src/app.tsx");

    expect(gitChangedFileToPierreStatusEntry(file)).toEqual({
      path: "src/app.tsx",
      status: "modified",
    });
  });

  it("builds flat row metadata without losing rename and count details", () => {
    const file = makeFile({
      path: "packages/gui/src/new-name.ts",
      status: "renamed",
      stage: "staged",
      previousPath: "packages/gui/src/old-name.ts",
      insertions: 7,
      deletions: 2,
    });

    expect(buildGitFileRowMetadata(file)).toMatchObject({
      fileName: "new-name.ts",
      directoryName: "packages/gui/src",
      previousFileName: "old-name.ts",
      statusLetter: "R",
      statusTone: "primary",
      statusLabel: "Renamed",
      countText: "+7 -2",
      isConflict: false,
    });
  });

  it("keeps flat list sections in host order", () => {
    const staged = makeFile({
      path: "z.ts",
      status: "modified",
      stage: "staged",
      previousPath: null,
      insertions: 1,
      deletions: 0,
    });
    const unstaged = makeModifiedFile("a.ts");
    const untracked = makeFile({
      path: "m.ts",
      status: "untracked",
      stage: "untracked",
      previousPath: null,
      insertions: 1,
      deletions: 0,
    });
    const conflicted = makeFile({
      path: "conflict.ts",
      status: "conflicted",
      stage: "conflicted",
      previousPath: null,
      insertions: 3,
      deletions: 1,
    });

    expect(
      splitGitChangedFiles([unstaged, conflicted, staged, untracked]),
    ).toEqual({
      mergeFiles: [conflicted],
      stagedFiles: [staged],
      changeFiles: [unstaged, untracked],
    });
  });

  it("keeps visible section files separate from whole-bundle counts", () => {
    const stagedVisible = makeFile({
      path: "visible.ts",
      status: "modified",
      stage: "staged",
      previousPath: null,
      insertions: 1,
      deletions: 0,
    });
    const stagedHidden = makeFile({
      path: "hidden.ts",
      status: "modified",
      stage: "staged",
      previousPath: null,
      insertions: 1,
      deletions: 0,
    });

    const sections = buildGitPanelFileSections(
      [stagedVisible, stagedHidden],
      [stagedVisible],
    );

    expect(sections).toContainEqual({
      group: "staged",
      visibleFiles: [stagedVisible],
      bundleFileCount: 2,
    });
  });

  it("sorts the flat list by basename with full path as tiebreaker", () => {
    const sorted = sortGitPanelFlatFiles([
      makeModifiedFile("src/routes/index.ts"),
      makeModifiedFile("lib/zebra.ts"),
      makeModifiedFile("src/stores/index.ts"),
      makeModifiedFile("alpha.ts"),
    ]);

    expect(sorted.map((file) => file.path)).toEqual([
      "alpha.ts",
      "src/routes/index.ts",
      "src/stores/index.ts",
      "lib/zebra.ts",
    ]);
  });

  it("does not mutate the input when sorting the flat list", () => {
    const files = [makeModifiedFile("b.ts"), makeModifiedFile("a.ts")] as const;

    sortGitPanelFlatFiles(files);

    expect(files.map((file) => file.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("renders the tooltip as the repo-relative path", () => {
    expect(gitChangedFileTooltipContent(makeModifiedFile("src/app.tsx"))).toBe(
      "src/app.tsx",
    );
  });

  it("renders rename tooltips as old → new", () => {
    const renamed = makeFile({
      path: "src/hooks/use-git-flat.ts",
      status: "renamed",
      stage: "staged",
      previousPath: "src/hooks/use-git.ts",
      insertions: 2,
      deletions: 2,
    });

    expect(gitChangedFileTooltipContent(renamed)).toBe(
      "src/hooks/use-git.ts → src/hooks/use-git-flat.ts",
    );
  });

  it("maps stages onto bundle groups for section reveal", () => {
    expect(gitStageBundleGroup("conflicted")).toBe("merge");
    expect(gitStageBundleGroup("staged")).toBe("staged");
    expect(gitStageBundleGroup("unstaged")).toBe("changes");
    expect(gitStageBundleGroup("untracked")).toBe("changes");
  });

  it("builds every ancestor directory path for max-depth Git tree expansion", () => {
    const paths = [
      "src/app.tsx",
      "src/components/button.tsx",
      "src/components/forms/input.tsx",
      "README.md",
      "test/unit/app.test.ts",
    ];

    expect(buildGitTreeDirectoryPaths(paths)).toEqual([
      "src",
      "src/components",
      "src/components/forms",
      "test",
      "test/unit",
    ]);
  });

  it("counts Pierre-flattened directory chains as single rendered rows", () => {
    expect(
      buildGitTreeRowDirectoryPaths([
        "Profile/components/PlatformRatings.jsx",
        "Trace-20260603T220311.json.gz",
        "Trace-20260604T133730.json.gz",
      ]),
    ).toEqual(["Profile"]);

    expect(
      buildGitTreeRowDirectoryPaths(["clients/gui/src/components/button.tsx"]),
    ).toEqual(["clients"]);

    expect(
      buildGitTreeRowDirectoryPaths([
        "src/components/button.tsx",
        "src/lib/git.ts",
      ]),
    ).toEqual(["src", "src/components", "src/lib"]);
  });

  it("expands Pierre's compacted Git tree rows to the deepest changed file", () => {
    const paths = [
      "clients/gui-app/src/components/forms/input.tsx",
      "clients/gui-app/src/components/button.tsx",
      "clients/gui-app/src/lib/c.ts",
    ];
    const expandedPaths = buildGitTreeDirectoryPaths(paths);
    const model = new PierreFileTree({
      paths,
      initialExpansion: "closed",
      initialExpandedPaths: expandedPaths,
    });

    const root = model.getItem("clients/gui-app/src");
    const components = model.getItem("clients/gui-app/src/components");
    const forms = model.getItem("clients/gui-app/src/components/forms");
    const lib = model.getItem("clients/gui-app/src/lib");

    expect(isDirectoryHandle(root) && root.isExpanded()).toBe(true);
    expect(isDirectoryHandle(components) && components.isExpanded()).toBe(true);
    expect(isDirectoryHandle(forms) && forms.isExpanded()).toBe(true);
    expect(isDirectoryHandle(lib) && lib.isExpanded()).toBe(true);
  });

  it("keeps deeper user-expanded Git tree folders across path resets", () => {
    expect(
      mergeGitTreeExpandedDirectoryPaths(
        ["src", "src/components"],
        ["src/components/forms", "src"],
      ),
    ).toEqual(["src", "src/components", "src/components/forms"]);
  });
});
