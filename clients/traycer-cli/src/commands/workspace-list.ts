import { worktreeListBindingsForEpicResponseSchemaV12 } from "@traycer/protocol/host";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
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
 *
 * Parses the CANONICAL v1.2 response, not the v1.0 base schema this used to
 * read. Zod strips unknown keys, so the old parse silently discarded
 * `isGitResolvePending` - the host's authoritative "these git facts are still
 * an unverified placeholder" marker - and the table then reported a resolving
 * row as `not git` / `missing on disk`, which is the one thing the protocol
 * says a client must not do with a pending row. A pre-v1.2 host is bridged up
 * transparently (every row stamped `isGitResolvePending: false`, which is
 * correct: an old host has no pending concept and never sends a signal that
 * would clear it), the same way `worktree list` reads its v1.4 schema.
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
      worktreeListBindingsForEpicResponseSchemaV12,
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
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
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
    // `isGitRepo` is part of the placeholder a pending row carries, so it gets
    // the same "not answered yet" treatment as STATE rather than a confident
    // "no" the next refresh may contradict.
    row.isGitResolvePending ? "?" : row.isGitRepo ? "yes" : "no",
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

function formatRepo(row: WorktreeBindingSelectorRowV12): string {
  const identifier = row.repoIdentifier;
  return identifier === null ? "-" : `${identifier.owner}/${identifier.repo}`;
}

/**
 * One word for "can an agent be pointed here right now". `disabledReason` is
 * the host's own answer to that - the same field the GUI picker greys a row on
 * - so a null reason is `ready` and a non-null one is named rather than
 * re-derived from `setupState` (which would have to repeat the host's rules and
 * could disagree with them).
 *
 * `isGitResolvePending` wins over the reason, and only over the git-derived
 * one. The host emits `missing_worktree_path` off an `isGitRepo` it has not
 * verified yet, so reporting "missing on disk" for such a row states as fact
 * something the next refresh may retract - the GUI pickers render these as
 * "checking" for the same reason. A genuine setup-state reason is already
 * resolved and is reported as-is even while git facts are pending.
 */
function formatState(row: WorktreeBindingSelectorRowV12): string {
  if (row.isGitResolvePending && row.disabledReason === "missing_worktree_path")
    return "checking";
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
