import { describe, it, expect } from "vitest";
import type {
  GitChangedFileV11,
  SubmoduleChangeset,
  SubmodulePointer,
} from "@traycer/protocol/host";
import {
  buildSubmoduleNodes,
  buildSubmoduleReferenceRows,
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

describe("buildSubmoduleReferenceRows", () => {
  it("joins a gitlink row to its submodule node and reads pins off the pointer", () => {
    const rows = buildSubmoduleReferenceRows(
      [file("traycer", normalPointer)],
      [changeset({})],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repoRoot).toBe("/repo/traycer");
    expect(rows[0].isConflicted).toBe(false);
    expect(rows[0].detailsUnavailable).toBe(false);
    expect(rows[0].summary).toBe(
      "parent references 1111111 · checkout at 2222222",
    );
  });

  it("surfaces the enriched `diverged` fact as divergence copy (both directions)", () => {
    const diverged = buildSubmoduleReferenceRows(
      [file("traycer", { ...normalPointer, diverged: true })],
      [changeset({})],
    );
    expect(diverged[0].divergence).toBe("diverged");

    const matches = buildSubmoduleReferenceRows(
      [file("traycer", { ...normalPointer, diverged: false })],
      [changeset({})],
    );
    expect(matches[0].divergence).toBe("matches");
  });

  it("has no divergence for a conflicted pointer (no single pin)", () => {
    const conflicted: SubmodulePointer = {
      kind: "conflicted",
      baseSha: "b",
      oursSha: "c",
      theirsSha: "d",
    };
    const rows = buildSubmoduleReferenceRows([file("traycer", conflicted)], []);
    expect(rows[0].divergence).toBeNull();
  });

  it("propagates an unavailable matching section into the reference row (still navigable)", () => {
    const rows = buildSubmoduleReferenceRows(
      [file("traycer", normalPointer)],
      [
        changeset({
          availability: { state: "unavailable", reason: "git-error" },
        }),
      ],
    );
    // The section exists, so the row still navigates to it (which shows the
    // "details unavailable" view), AND the reference row itself flags the degrade.
    expect(rows[0].repoRoot).toBe("/repo/traycer");
    expect(rows[0].detailsUnavailable).toBe(true);
  });

  it("flags a dirty normal pointer with no submodule section as details-unavailable and non-navigable", () => {
    const rows = buildSubmoduleReferenceRows(
      [file("traycer", normalPointer)],
      [], // old-host downgrade: submodules stripped
    );
    expect(rows[0].repoRoot).toBeNull();
    expect(rows[0].detailsUnavailable).toBe(true);
  });

  it("treats a conflicted pointer as pointer-only (no section, not a degrade)", () => {
    const conflicted: SubmodulePointer = {
      kind: "conflicted",
      baseSha: "bbbbbbbbbb",
      oursSha: "cccccccccc",
      theirsSha: "dddddddddd",
    };
    const rows = buildSubmoduleReferenceRows([file("traycer", conflicted)], []);
    expect(rows[0].repoRoot).toBeNull();
    expect(rows[0].isConflicted).toBe(true);
    expect(rows[0].detailsUnavailable).toBe(false);
    expect(rows[0].summary).toContain(
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

  it("marks a committed-pin-only submodule (no working-tree files) as dimmed/no-changes", () => {
    const [node] = buildSubmoduleNodes([changeset({ files: [] })]);
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
