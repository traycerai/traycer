import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@traycer/protocol/host";
import { gitImageDiffSides } from "../git-diff-tile";

function file(
  status: GitChangedFile["status"],
  stage: GitChangedFile["stage"],
): GitChangedFile {
  return {
    path: "images/current.png",
    previousPath: null,
    status,
    stage,
    insertions: 0,
    deletions: 0,
    isBinary: true,
    sizeBytes: 1,
    stagedOid: null,
    worktreeOid: null,
  };
}

describe("gitImageDiffSides", () => {
  it.each([
    [
      "modified staged",
      file("modified", "staged"),
      {
        oldStage: "staged",
        newStage: "staged",
        conflicted: false,
      },
    ],
    [
      "modified unstaged",
      file("modified", "unstaged"),
      {
        oldStage: "unstaged",
        newStage: "unstaged",
        conflicted: false,
      },
    ],
    [
      "added staged",
      file("added", "staged"),
      {
        oldStage: null,
        newStage: "staged",
        conflicted: false,
      },
    ],
    [
      "added unstaged",
      file("added", "unstaged"),
      {
        oldStage: null,
        newStage: "unstaged",
        conflicted: false,
      },
    ],
    [
      "untracked",
      file("untracked", "untracked"),
      {
        oldStage: null,
        newStage: "unstaged",
        conflicted: false,
      },
    ],
    [
      "deleted staged",
      file("deleted", "staged"),
      {
        oldStage: "staged",
        newStage: null,
        conflicted: false,
      },
    ],
    [
      "deleted unstaged",
      file("deleted", "unstaged"),
      {
        oldStage: "unstaged",
        newStage: null,
        conflicted: false,
      },
    ],
    [
      "conflicted",
      file("conflicted", "conflicted"),
      {
        oldStage: "staged",
        newStage: "unstaged",
        conflicted: true,
      },
    ],
    [
      "renamed staged",
      file("renamed", "staged"),
      {
        oldStage: "staged",
        newStage: "staged",
        conflicted: false,
      },
    ],
    [
      "renamed unstaged",
      file("renamed", "unstaged"),
      {
        oldStage: "unstaged",
        newStage: "unstaged",
        conflicted: false,
      },
    ],
    [
      "copied",
      file("copied", "unstaged"),
      {
        oldStage: "unstaged",
        newStage: "unstaged",
        conflicted: false,
      },
    ],
  ] as const)("routes %s", (_name, changedFile, expected) => {
    expect(gitImageDiffSides(changedFile)).toEqual(expected);
  });
});
