import { describe, it, expect } from "vitest";
import type {
  CommitAheadFile,
  GitChangedFileV11,
  SubmoduleChangeset,
  SubmodulePointer,
  SubmoduleRelation,
} from "@traycer/protocol/host";
import {
  composeGitRepos,
  classifyRelationPresentation,
  formatHeadLabel,
} from "@/lib/git/git-repo-composition";

function file(
  overrides: Partial<GitChangedFileV11> & Pick<GitChangedFileV11, "path">,
): GitChangedFileV11 {
  return {
    path: overrides.path,
    previousPath: overrides.previousPath ?? null,
    status: overrides.status ?? "modified",
    stage: overrides.stage ?? "unstaged",
    isBinary: overrides.isBinary ?? false,
    insertions: overrides.insertions ?? 1,
    deletions: overrides.deletions ?? 0,
    sizeBytes: overrides.sizeBytes ?? 10,
    stagedOid: overrides.stagedOid ?? null,
    worktreeOid: overrides.worktreeOid ?? null,
    gitlink: overrides.gitlink ?? null,
  };
}

function normalPointer(
  overrides: Partial<Extract<SubmodulePointer, { kind: "normal" }>>,
): SubmodulePointer {
  return {
    kind: "normal",
    recordedPinSha: overrides.recordedPinSha ?? "aaaaaaaaaa",
    stagedPinSha: overrides.stagedPinSha ?? null,
    commitChanged: overrides.commitChanged ?? false,
    modifiedContent: overrides.modifiedContent ?? true,
    untrackedContent: overrides.untrackedContent ?? false,
  };
}

function commitAheadFile(path: string): CommitAheadFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    isBinary: false,
    insertions: 3,
    deletions: 1,
  };
}

function changeset(
  overrides: Partial<SubmoduleChangeset> &
    Pick<SubmoduleChangeset, "parentPath" | "relation">,
): SubmoduleChangeset {
  return {
    repoRoot: overrides.repoRoot ?? `/repo/${overrides.parentPath}`,
    parentPath: overrides.parentPath,
    branch: overrides.branch ?? null,
    repoState: overrides.repoState ?? { kind: "clean" },
    relation: overrides.relation,
    files: overrides.files ?? [],
  };
}

function baseSnapshot(overrides: {
  files: ReadonlyArray<GitChangedFileV11>;
  submodules: ReadonlyArray<SubmoduleChangeset>;
}) {
  return {
    runningDir: "/repo/traycer-internal",
    label: "traycer-internal",
    branch: "development" as string | null,
    headSha: "deadbeefcafe",
    repoState: { kind: "clean" as const },
    files: overrides.files,
    submodules: overrides.submodules,
  };
}

const aheadRelation: SubmoduleRelation = {
  state: "ahead",
  recordedPinSha: "1111111111",
  submoduleHeadSha: "2222222222",
  commitsAhead: { count: 2, files: [commitAheadFile("clients/a.ts")] },
};

describe("composeGitRepos", () => {
  it("splits ordinary parent files from gitlink pointer rows and counts them separately", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({ path: "src/app.ts" }),
          file({ path: "src/lib.ts" }),
          file({
            path: "traycer",
            status: "modified",
            gitlink: normalPointer({ recordedPinSha: "1111111111" }),
          }),
        ],
        submodules: [changeset({ parentPath: "traycer", relation: aheadRelation })],
      }),
    );

    expect(result.parent.files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/lib.ts",
    ]);
    expect(result.parent.fileCount).toBe(2);
    expect(result.parent.referenceCount).toBe(1);
    expect(result.parent.countsLabel).toBe("2 files · 1 submodule reference");
    expect(result.hasSubmoduleContent).toBe(true);
  });

  it("dedups a dual-stage gitlink row (MM S.M.) into one reference row by path", () => {
    const pointer = normalPointer({ recordedPinSha: "1111111111" });
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({ path: "traycer", stage: "staged", gitlink: pointer }),
          file({ path: "traycer", stage: "unstaged", gitlink: pointer }),
        ],
        submodules: [changeset({ parentPath: "traycer", relation: aheadRelation })],
      }),
    );

    expect(result.parent.referenceRows).toHaveLength(1);
    expect(result.parent.referenceRows[0].parentPath).toBe("traycer");
    expect(result.parent.fileCount).toBe(0);
    expect(result.parent.countsLabel).toBe("0 files · 1 submodule reference");
  });

  it("joins the checkout HEAD from the matching changeset into the reference summary", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({
            path: "traycer",
            gitlink: normalPointer({
              recordedPinSha: "1111111111",
              stagedPinSha: "3333333333",
            }),
          }),
        ],
        submodules: [changeset({ parentPath: "traycer", relation: aheadRelation })],
      }),
    );

    const row = result.parent.referenceRows[0];
    expect(row.detailsAvailable).toBe(true);
    expect(row.detailsUnavailable).toBe(false);
    expect(row.summary).toBe(
      "parent references 1111111, staged 3333333, checkout at 2222222",
    );
  });

  it("flags a dirty normal gitlink with no matching changeset as details-unavailable", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({
            path: "traycer",
            gitlink: normalPointer({
              recordedPinSha: "1111111111",
              modifiedContent: true,
            }),
          }),
        ],
        submodules: [],
      }),
    );

    const row = result.parent.referenceRows[0];
    expect(row.detailsAvailable).toBe(false);
    expect(row.detailsUnavailable).toBe(true);
    expect(result.hasSubmoduleContent).toBe(true);
  });

  it("renders a conflicted pointer as a pointer-only reference row, never a degrade", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({
            path: "traycer",
            status: "conflicted",
            stage: "conflicted",
            gitlink: {
              kind: "conflicted",
              baseSha: "bbbbbbbbbb",
              oursSha: "cccccccccc",
              theirsSha: "dddddddddd",
            },
          }),
        ],
        submodules: [],
      }),
    );

    const row = result.parent.referenceRows[0];
    expect(row.pointer.kind).toBe("conflicted");
    expect(row.detailsUnavailable).toBe(false);
    expect(row.summary).toBe(
      "merge conflict on the submodule pointer (base bbbbbbb, ours ccccccc, theirs ddddddd)",
    );
  });

  it("builds a submodule view with an ahead group carrying the commit files", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [file({ path: "traycer", gitlink: normalPointer({}) })],
        submodules: [
          changeset({
            parentPath: "traycer",
            branch: null,
            relation: aheadRelation,
            files: [file({ path: "clients/gui-app/wt.ts", stage: "unstaged" })],
          }),
        ],
      }),
    );

    const sub = result.submodules[0];
    expect(sub.label).toBe("traycer");
    expect(sub.headLabel).toBe("detached @ 2222222");
    expect(sub.presentation.bucket).toBe("ahead");
    if (sub.presentation.bucket === "ahead") {
      expect(sub.presentation.heading).toBe(
        "Committed changes not recorded by parent (2 commits)",
      );
      expect(sub.presentation.files.map((f) => f.path)).toEqual([
        "clients/a.ts",
      ]);
    }
    expect(sub.files.map((f) => f.path)).toEqual(["clients/gui-app/wt.ts"]);
  });

  it("labels submodule sections and reference rows with the full path, not the basename", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [
          file({ path: "nested/traycer", gitlink: normalPointer({}) }),
        ],
        submodules: [
          changeset({ parentPath: "nested/traycer", relation: aheadRelation }),
        ],
      }),
    );
    expect(result.submodules[0].label).toBe("nested/traycer");
    expect(result.parent.referenceRows[0].label).toBe("nested/traycer");
  });

  it("stays flat when there are no submodules and no gitlink rows", () => {
    const result = composeGitRepos(
      baseSnapshot({
        files: [file({ path: "src/app.ts" })],
        submodules: [],
      }),
    );
    expect(result.hasSubmoduleContent).toBe(false);
    expect(result.parent.referenceRows).toHaveLength(0);
  });
});

describe("classifyRelationPresentation", () => {
  it.each([
    ["behind" as const],
    ["diverged" as const],
    ["equal" as const],
  ])("collapses %s into the checkout-differs bucket", (state) => {
    const relation = {
      state,
      recordedPinSha: "1111111111",
      submoduleHeadSha: "2222222222",
    } as SubmoduleRelation;
    const presentation = classifyRelationPresentation(relation);
    expect(presentation.bucket).toBe("checkout-differs");
    expect(presentation.heading).toBe("Checkout differs from parent reference");
  });

  it("collapses unknown into needs-attention as a local-comparability limit", () => {
    const presentation = classifyRelationPresentation({
      state: "unknown",
      reason: "missing-pin-object",
      recordedPinSha: "1111111111",
      submoduleHeadSha: null,
    });
    expect(presentation.bucket).toBe("needs-attention");
    expect(presentation.heading).toBe("Reference needs attention");
    expect(presentation.detail).toContain("Not comparable locally");
    expect(presentation.detail).not.toMatch(/host|failed|error/i);
  });

  it("distinguishes unborn-head from missing-pin-object copy", () => {
    expect(
      classifyRelationPresentation({
        state: "unknown",
        reason: "unborn-head",
        recordedPinSha: null,
        submoduleHeadSha: null,
      }).detail,
    ).toContain("no commits yet");
  });

  it("labels the ahead bucket with the commit count and preserves the pin facts", () => {
    const presentation = classifyRelationPresentation(aheadRelation);
    expect(presentation.heading).toBe(
      "Committed changes not recorded by parent (2 commits)",
    );
    expect(presentation.detail).toContain("1111111");
    expect(presentation.detail).toContain("2222222");
  });
});

describe("formatHeadLabel", () => {
  it("prefers the branch name", () => {
    expect(formatHeadLabel("main", "abcdef1234")).toBe("main");
  });
  it("falls back to a short detached sha", () => {
    expect(formatHeadLabel(null, "abcdef1234")).toBe("detached @ abcdef1");
  });
  it("falls back to plain detached when nothing is known", () => {
    expect(formatHeadLabel(null, null)).toBe("detached");
  });
});
