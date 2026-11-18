import type { GitChangedFile } from "@traycer/protocol/host";

export interface GitFileStatsSummary {
  readonly insertions: number;
  readonly deletions: number;
}

export function sumGitFileStats(
  files: ReadonlyArray<GitChangedFile>,
): GitFileStatsSummary {
  return files.reduce(
    (totals, file) => ({
      insertions: totals.insertions + file.insertions,
      deletions: totals.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}
