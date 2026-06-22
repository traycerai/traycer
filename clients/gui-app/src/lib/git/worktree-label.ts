import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { getBasename } from "@/lib/path/cross-platform-path";

export function formatGitWorktreeLabel(row: {
  readonly repoIdentifier: WorktreeBindingSelectorRow["repoIdentifier"];
  readonly runningDir: string;
  readonly branch: string | null;
}): string {
  const repo = row.repoIdentifier?.repo ?? getBasename(row.runningDir);
  const branch = row.branch ?? "detached";
  return `${repo} · ${branch}`;
}
