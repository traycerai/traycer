import { describe, it, expect } from "vitest";
import type {
  GitChangedFileV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import {
  buildGitModuleGroups,
  buildSubmoduleNodes,
  buildSubmoduleParentReferences,
  findSubmoduleChangeset,
  formatRepoHeadLabel,
  splitParentFiles,
} from "../git-repo-tree";

function file(
  path: string,
  gitlink: SubmodulePointer | null,
): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 1,
    deletions: 0,
    sizeBytes: 10,
    stagedOid: null,
    worktreeOid: null,
    gitlink,
  };
}

const normalPointer: SubmodulePointer = {
  kind: "normal",
  recordedPinSha: "1111111111",
  submoduleHeadSha: "2222222222",
  diverged: true,
  commitChanged: true,
  modifiedContent: false,
  untrackedContent: false,
};

function changeset(overrides: Partial<SubmoduleChangeset>): SubmoduleChangeset {
  return {
    repoRoot: "/repo/traycer",
    parentPath: "traycer",
    branch: "main",
    repoState: { kind: "clean" },
    files: [],
    pointer: normalPointer,
    availability: { state: "ok" },
    ...overrides,
  };
}

describe("splitParentFiles", () => {
  it("separates ordinary files from gitlink rows and dedups gitlinks by path", () => {
    const split = splitParentFiles([
      file("src/app.ts", null),
      file("traycer", normalPointer),
      file("traycer", normalPointer), // dual-stage duplicate
      file("src/util.ts", null),
    ]);
    expect(split.ordinaryFiles.map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/util.ts",
    ]);
    expect(split.gitlinkFiles.map((f) => f.path)).toEqual(["traycer"]);
  });
});

describe("buildSubmoduleParentReferences", () => {
  it("joins a gitlink file to its submodule section and reads pins off the pointer", () => {
    const references = buildSubmoduleParentReferences(
      [file("traycer", normalPointer)],
      [changeset({})],
    );
    expect(references).toHaveLength(1);
    expect(references[0].repoRoot).toBe("/repo/traycer");
    expect(references[0].isConflicted).toBe(false);
    expect(references[0].detailsUnavailable).toBe(false);
    expect(references[0].summary).toBe(
      "parent references 1111111 · checkout at 2222222",
    );
  });

  it("surfaces the enriched `diverged` fact as divergence copy (both directions)", () => {
    const diverged = buildSubmoduleParentReferences(
      [file("traycer", { ...normalPointer, diverged: true })],
      [changeset({})],
    );
    expect(diverged[0].divergence).toBe("diverged");

    const matches = buildSubmoduleParentReferences(
      [file("traycer", { ...normalPointer, diverged: false })],
      [changeset({})],
    );
    expect(matches[0].divergence).toBe("matches");
  });

  it("has no divergence for an unenriched pointer (checkout HEAD never read)", () => {
    // A dirty submodule the host could not inspect keeps the parser defaults
    // (`submoduleHeadSha: null, diverged: false`) - that must not read as a
    // verified "matches".
    const references = buildSubmoduleParentReferences(
      [
        file("traycer", {
          ...normalPointer,
          submoduleHeadSha: null,
          diverged: false,
        }),
      ],
      [],
    );
    expect(references[0].divergence).toBeNull();
  });

  it("has no divergence for a conflicted pointer (no single pin)", () => {
    const conflicted: SubmodulePointer = {
      kind: "conflicted",
      baseSha: "b",
      oursSha: "c",
      theirsSha: "d",
    };
    const references = buildSubmoduleParentReferences(
      [file("traycer", conflicted)],
      [],
    );
    expect(references[0].divergence).toBeNull();
  });

  it("propagates an unavailable matching section into the parent-reference descriptor", () => {
    const references = buildSubmoduleParentReferences(
      [file("traycer", normalPointer)],
      [
        changeset({
          availability: { state: "unavailable", reason: "git-error" },
        }),
      ],
    );
    expect(references[0].repoRoot).toBe("/repo/traycer");
    expect(references[0].detailsUnavailable).toBe(true);
  });

  it("flags a dirty normal pointer with no submodule section as details-unavailable", () => {
    const references = buildSubmoduleParentReferences(
      [file("traycer", normalPointer)],
      [], // old-host downgrade: submodules stripped
    );
    expect(references[0].repoRoot).toBeNull();
    expect(references[0].detailsUnavailable).toBe(true);
  });

  it("treats a conflicted pointer as pointer-only (no section, not a degrade)", () => {
    const conflicted: SubmodulePointer = {
      kind: "conflicted",
      baseSha: "bbbbbbbbbb",
      oursSha: "cccccccccc",
      theirsSha: "dddddddddd",
    };
    const references = buildSubmoduleParentReferences(
      [file("traycer", conflicted)],
      [],
    );
    expect(references[0].repoRoot).toBeNull();
    expect(references[0].isConflicted).toBe(true);
    expect(references[0].detailsUnavailable).toBe(false);
    expect(references[0].summary).toContain(
      "merge conflict on the submodule pointer",
    );
  });
});

describe("buildSubmoduleNodes", () => {
  it("marks a submodule with working-tree files as having changes", () => {
    const [node] = buildSubmoduleNodes([
      changeset({ files: [file("a.ts", null), file("b.ts", null)] }),
    ]);
    expect(node.changeCount).toBe(2);
    expect(node.hasChanges).toBe(true);
    expect(node.unavailable).toBe(false);
    expect(node.headLabel).toBe("main");
  });

  it("marks a parent-reference-only submodule as changed without changing its file count", () => {
    const [node] = buildSubmoduleNodes([changeset({ files: [] })]);
    expect(node.changeCount).toBe(0);
    expect(node.hasChanges).toBe(true);
  });

  it("marks a clean submodule with no working-tree files as unchanged", () => {
    const [node] = buildSubmoduleNodes([
      changeset({
        pointer: {
          ...normalPointer,
          recordedPinSha: "2222222222",
          diverged: false,
          commitChanged: false,
          modifiedContent: false,
        },
      }),
    ]);
    expect(node.changeCount).toBe(0);
    expect(node.hasChanges).toBe(false);
  });

  it("marks an unavailable submodule", () => {
    const [node] = buildSubmoduleNodes([
      changeset({
        availability: { state: "unavailable", reason: "git-error" },
      }),
    ]);
    expect(node.unavailable).toBe(true);
  });
});

describe("findSubmoduleChangeset", () => {
  it("finds by repoRoot, else null", () => {
    const list = [changeset({})];
    expect(findSubmoduleChangeset(list, "/repo/traycer")).not.toBeNull();
    expect(findSubmoduleChangeset(list, "/repo/other")).toBeNull();
  });
});

describe("formatRepoHeadLabel", () => {
  it("prefers branch, falls back to detached@sha, then detached", () => {
    expect(formatRepoHeadLabel("main", "abcdef1234")).toBe("main");
    expect(formatRepoHeadLabel(null, "abcdef1234")).toBe("detached @ abcdef1");
    expect(formatRepoHeadLabel(null, null)).toBe("detached");
  });
});

describe("buildGitModuleGroups", () => {
  function model(args: {
    readonly files?: ReadonlyArray<GitChangedFileV11>;
    readonly submodules?: ReadonlyArray<SubmoduleChangeset>;
  }) {
    return buildGitModuleGroups({
      root: {
        repoRoot: "/repo",
        label: "traycer-internal",
        branch: "development",
        headSha: "abcdef1234",
        files: args.files ?? [],
        repoState: { kind: "clean" },
        repoMode: "normal",
      },
      submodules: args.submodules ?? [],
    });
  }

  it("renders root first and hides matching parent gitlink rows from root files", () => {
    const result = model({
      files: [file("src/app.ts", null), file("traycer", normalPointer)],
      submodules: [changeset({ files: [file("src/submodule.ts", null)] })],
    });

    expect(result.modules.map((module) => module.label)).toEqual([
      "traycer-internal",
      "traycer",
    ]);
    expect(
      result.modules[0].files.map((changedFile) => changedFile.path),
    ).toEqual(["src/app.ts"]);
    expect(result.modules[1]).toMatchObject({
      kind: "submodule",
      label: "traycer",
      clean: false,
      defaultExpanded: true,
    });
  });

  it("represents parent-reference mismatch on the submodule module", () => {
    const result = model({
      files: [file("traycer", normalPointer)],
      submodules: [changeset({ files: [] })],
    });

    expect(result.modules[0].files).toHaveLength(0);
    expect(result.modules[1]).toMatchObject({
      label: "traycer",
      parentReference: {
        status: "differs",
        summary: "parent references 1111111 · checkout at 2222222",
      },
      clean: false,
      defaultExpanded: true,
    });
  });

  it("keeps clean submodules collapsed behind the clean-module count", () => {
    const result = model({
      submodules: [
        changeset({
          pointer: {
            ...normalPointer,
            diverged: false,
            commitChanged: false,
            modifiedContent: false,
          },
        }),
      ],
    });

    expect(result.hiddenCleanModuleCount).toBe(1);
    expect(result.modules[1]).toMatchObject({
      clean: true,
      defaultExpanded: false,
    });
  });

  it("turns unmatched dirty gitlink rows into unavailable module groups", () => {
    const result = model({
      files: [file("traycer", normalPointer)],
      submodules: [],
    });

    expect(result.modules[0].files).toHaveLength(0);
    expect(result.modules[1]).toMatchObject({
      kind: "submodule",
      label: "traycer",
      repoRoot: null,
      unavailable: true,
      parentReference: {
        status: "unavailable",
      },
    });
  });
});
