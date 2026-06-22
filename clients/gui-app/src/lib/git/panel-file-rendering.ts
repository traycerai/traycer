import type { GitChangedFile, GitStage } from "@traycer/protocol/host";
import type { GitStatusEntry } from "@pierre/trees";
import { getBasename, getDirname } from "@/lib/path/cross-platform-path";
import { statusBadgeStyle, type StatusBadgeStyle } from "@/lib/git/status-icon";
import type { GitDiffBundleGroup } from "@/stores/epics/canvas/types";

export interface GitFileRowMetadata {
  readonly fileName: string;
  readonly directoryName: string;
  readonly previousFileName: string | null;
  readonly statusLetter: string;
  readonly statusTone: StatusBadgeStyle["tone"];
  readonly statusLabel: string;
  readonly countText: string;
  readonly countTitle: string;
  readonly isConflict: boolean;
}

export interface GitFileSections {
  readonly mergeFiles: ReadonlyArray<GitChangedFile>;
  readonly stagedFiles: ReadonlyArray<GitChangedFile>;
  readonly changeFiles: ReadonlyArray<GitChangedFile>;
}

export interface GitPanelFileSection {
  readonly group: GitDiffBundleGroup;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly bundleFileCount: number;
}

function directoryPathsForPath(filePath: string): ReadonlyArray<string> {
  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  const directorySegmentCount = Math.max(0, segments.length - 1);
  return Array.from({ length: directorySegmentCount }, (_value, index) =>
    segments.slice(0, index + 1).join("/"),
  );
}

export function gitChangedFileToPierreStatus(
  file: GitChangedFile,
): GitStatusEntry["status"] {
  if (file.status === "untracked") return "added";
  if (file.status === "copied") return "renamed";
  if (file.status === "conflicted") return "modified";
  return file.status;
}

export function gitChangedFileToPierreStatusEntry(
  file: GitChangedFile,
): GitStatusEntry {
  return {
    path: file.path,
    status: gitChangedFileToPierreStatus(file),
  };
}

export function buildGitFileRowMetadata(
  file: GitChangedFile,
): GitFileRowMetadata {
  const status = statusBadgeStyle(file.status);
  const fileName = getBasename(file.path);
  return {
    fileName,
    directoryName: getDirname(file.path),
    previousFileName:
      file.previousPath === null ? null : getBasename(file.previousPath),
    statusLetter: status.letter,
    statusTone: status.tone,
    statusLabel: status.label,
    countText: `+${file.insertions} -${file.deletions}`,
    countTitle: `${file.insertions} insertion${
      file.insertions === 1 ? "" : "s"
    }, ${file.deletions} deletion${file.deletions === 1 ? "" : "s"}`,
    isConflict: file.stage === "conflicted",
  };
}

export function splitGitChangedFiles(
  files: ReadonlyArray<GitChangedFile>,
): GitFileSections {
  return {
    mergeFiles: files.filter((file) =>
      gitChangedFileBelongsToBundleGroup(file, "merge"),
    ),
    stagedFiles: files.filter((file) =>
      gitChangedFileBelongsToBundleGroup(file, "staged"),
    ),
    changeFiles: files.filter((file) =>
      gitChangedFileBelongsToBundleGroup(file, "changes"),
    ),
  };
}

export function buildGitPanelFileSections(
  allFiles: ReadonlyArray<GitChangedFile>,
  visibleFiles: ReadonlyArray<GitChangedFile>,
): ReadonlyArray<GitPanelFileSection> {
  const allSections = splitGitChangedFiles(allFiles);
  const visibleSections = splitGitChangedFiles(visibleFiles);
  return [
    {
      group: "merge",
      visibleFiles: visibleSections.mergeFiles,
      bundleFileCount: allSections.mergeFiles.length,
    },
    {
      group: "staged",
      visibleFiles: visibleSections.stagedFiles,
      bundleFileCount: allSections.stagedFiles.length,
    },
    {
      group: "changes",
      visibleFiles: visibleSections.changeFiles,
      bundleFileCount: allSections.changeFiles.length,
    },
  ];
}

export function gitStageBundleGroup(stage: GitStage): GitDiffBundleGroup {
  if (stage === "conflicted") return "merge";
  if (stage === "staged") return "staged";
  return "changes";
}

function gitChangedFileBundleGroup(file: GitChangedFile): GitDiffBundleGroup {
  return gitStageBundleGroup(file.stage);
}

export function gitChangedFileBelongsToBundleGroup(
  file: GitChangedFile,
  group: GitDiffBundleGroup,
): boolean {
  return gitChangedFileBundleGroup(file) === group;
}

export function buildGitTreeDirectoryPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Array.from(
    new Set(paths.flatMap((path) => directoryPathsForPath(path))),
  );
}

export function mergeGitTreeExpandedDirectoryPaths(
  primaryPaths: ReadonlyArray<string>,
  secondaryPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Array.from(new Set([...primaryPaths, ...secondaryPaths]));
}

export function sortGitPanelFlatFiles(
  files: ReadonlyArray<GitChangedFile>,
): ReadonlyArray<GitChangedFile> {
  return files.toSorted((left, right) => {
    const byName = getBasename(left.path).localeCompare(
      getBasename(right.path),
    );
    if (byName !== 0) return byName;
    return left.path.localeCompare(right.path);
  });
}

export function gitChangedFileTooltipContent(file: GitChangedFile): string {
  if (file.previousPath !== null && file.previousPath !== file.path) {
    return `${file.previousPath} → ${file.path}`;
  }
  return file.path;
}
