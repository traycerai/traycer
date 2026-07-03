import {
  worktreeListAllForHostResponseSchemaV11,
  type WorktreeHostEntryV11,
} from "@traycer/protocol/host";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import type { CommandFn } from "../runner/runner";

export interface WorktreeListCommandOpts {
  // `--include-activity`: opt into the host's per-worktree git probes
  // (`lastActivityAt`, `branchStatus`). Off by default so the listing stays
  // cheap; the housekeeping skill turns it on to classify staleness. `owners`
  // and `createdAt` are returned either way.
  readonly includeActivity: boolean;
}

/**
 * `traycer worktree list` - host-wide listing of every Traycer-managed
 * worktree under `~/.traycer/worktrees/`. Calls `worktree.listAllForHost@1.1`;
 * the canonical (latest) request carries `includeActivity`, so a v1.0 host is
 * bridged up transparently (enriched fields default to empty `owners` / `null`
 * timestamps). Human mode renders a scannable table; `--json` hands the raw
 * enriched entries to the caller (the skill) to classify.
 */
export function buildWorktreeListCommand(
  opts: WorktreeListCommandOpts,
): CommandFn {
  return async () => {
    const result = await toAgentCliError(
      callHostRpc("worktree.listAllForHost", {
        includeActivity: opts.includeActivity,
      }),
    );
    const parsed = parseHostResponse(
      worktreeListAllForHostResponseSchemaV11,
      result,
    );
    return {
      data: parsed,
      human: formatWorktreeListTable(parsed.worktrees, opts.includeActivity),
      exitCode: 0,
    };
  };
}

const COLUMNS = [
  "REPO",
  "BRANCH",
  "IN-USE",
  "UNCOMMITTED",
  "LAST-ACTIVE",
  "OWNERS",
  "PATH",
] as const;

/**
 * Render the host-wide worktree listing as a fixed-width column table. Pure so
 * the layout is unit-testable without a host. `lastActivityAt` is `null`
 * whenever `--include-activity` was not passed (the host skips the git probes),
 * so the LAST-ACTIVE cell reads `-` and a trailing hint points at the flag.
 */
export function formatWorktreeListTable(
  worktrees: ReadonlyArray<WorktreeHostEntryV11>,
  includeActivity: boolean,
): string {
  if (worktrees.length === 0) {
    return "No Traycer-managed worktrees found.";
  }
  const rows = worktrees.map((entry) => [
    entry.repoLabel,
    entry.branch ?? "(detached)",
    entry.inUse ? "yes" : "no",
    String(entry.uncommittedCount),
    formatLastActive(entry.lastActivityAt),
    String(entry.owners.length),
    entry.worktreePath,
  ]);
  const widths = COLUMNS.map((header, column) =>
    rows.reduce(
      (max, row) => Math.max(max, row[column].length),
      header.length,
    ),
  );
  const renderRow = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, column) =>
        // The final column (PATH) is left unpadded so a long path never trails
        // a wall of spaces.
        column === COLUMNS.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();
  const lines = [renderRow(COLUMNS), ...rows.map(renderRow)];
  if (!includeActivity) {
    lines.push(
      "",
      "Pass --include-activity for last-active timestamps and branch status.",
    );
  }
  return lines.join("\n");
}

/**
 * Format a derived `lastActivityAt` for the table. The host may hand back a
 * seconds- or milliseconds-based epoch (reflog `%ct` is seconds, binding
 * `updatedAt` is JS `Date.now()` ms); normalise a plainly-seconds value up to
 * ms before formatting so a real timestamp never renders as 1970. `null`
 * (probe skipped or no signal) renders as `-`.
 */
function formatLastActive(lastActivityAt: number | null): string {
  if (lastActivityAt === null) return "-";
  const ms = lastActivityAt < 1e12 ? lastActivityAt * 1000 : lastActivityAt;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().slice(0, 10);
}
