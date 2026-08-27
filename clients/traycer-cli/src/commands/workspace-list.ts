import { worktreeListBindingsForEpicResponseSchema } from "@traycer/protocol/host";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer workspace list` - the folders and Git worktrees bound to this Task,
 * which is the set an agent here can be pointed at.
 *
 * Human mode renders a scannable table; `--json` still hands back the host's
 * `worktree.listBindingsForEpic` rows verbatim, which is what a caller parsing
 * this wants and what the human table deliberately is not.
 */
export function buildWorkspaceListCommand(opts: {
  readonly epicId: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const result = await toAgentCliError(
      callHostRpc("worktree.listBindingsForEpic", { epicId }),
    );
    const parsed = parseHostResponse(
      worktreeListBindingsForEpicResponseSchema,
      result,
    );
    return {
      data: parsed,
      human: formatWorkspaceListTable(parsed.rows),
      exitCode: 0,
    };
  };
}

const COLUMNS = [
  "REPO",
  "MODE",
  "BRANCH",
  "GIT",
  "STATE",
  "AGENTS",
  "DIRECTORY",
] as const;

/**
 * Fixed-width column table, pure so the layout is testable without a host.
 *
 * DIRECTORY is `runningDir` - the directory Git and a shell actually run in -
 * rather than `workspacePath`, because for a worktree row those differ and only
 * the former answers "where would my agent be working". The source workspace is
 * still in the `--json` payload for anyone who needs the pair.
 */
export function formatWorkspaceListTable(
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
): string {
  if (rows.length === 0) {
    return [
      "No workspace folders are bound to this Task.",
      "",
      "Create one with `traycer worktree create --workspace <path> --branch <name>`, then bind it with `traycer agent create --cwd <path>`.",
    ].join("\n");
  }
  const cells = rows.map((row) => [
    formatRepo(row),
    row.mode,
    row.branch ?? "-",
    row.isGitRepo ? "yes" : "no",
    formatState(row),
    String(row.sources.length),
    row.runningDir,
  ]);
  const widths = COLUMNS.map((header, column) =>
    cells.reduce(
      (max, row) => Math.max(max, row[column].length),
      header.length,
    ),
  );
  const renderRow = (row: ReadonlyArray<string>): string =>
    row
      .map((cell, column) =>
        // The final column (DIRECTORY) stays unpadded so a long path never
        // trails a wall of spaces.
        column === COLUMNS.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();
  return [
    renderRow(COLUMNS),
    ...cells.map(renderRow),
    "",
    "Run an agent in one with `traycer agent create --cwd <directory>`.",
    "Run with --json for the full binding records.",
  ].join("\n");
}

function formatRepo(row: WorktreeBindingSelectorRow): string {
  const identifier = row.repoIdentifier;
  return identifier === null ? "-" : `${identifier.owner}/${identifier.repo}`;
}

/**
 * One word for "can an agent be pointed here right now". `disabledReason` is
 * the host's own answer to that - the same field the GUI picker greys a row on
 * - so a null reason is `ready` and a non-null one is named rather than
 * re-derived from `setupState` (which would have to repeat the host's rules and
 * could disagree with them).
 */
function formatState(row: WorktreeBindingSelectorRow): string {
  switch (row.disabledReason) {
    case null:
      return "ready";
    case "setup_pending":
      return "setup pending";
    case "setup_running":
      return "setup running";
    case "setup_failed":
      return "setup failed";
    case "setup_cancelled":
      return "setup cancelled";
    case "missing_worktree_path":
      return "missing on disk";
  }
}
