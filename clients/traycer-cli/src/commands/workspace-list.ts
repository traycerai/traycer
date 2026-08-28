import { worktreeListBindingsForEpicResponseSchemaV12 } from "@traycer/protocol/host";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import {
  callHostRpc,
  parseCanonicalHostResponse,
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
    const parsed = parseCanonicalHostResponse(
      "worktree.listBindingsForEpic",
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
 * What this row's state actually is, mirroring the precedence in the GUI
 * pickers (`clients/gui-app/src/lib/worktree/worktree-folder-disabled-reason.ts`
 * — `worktreeFolderRowBadge`), which is the canonical derivation.
 *
 * Keying on `disabledReason` ALONE was wrong, and wrong in the direction that
 * hides bad news. The current host treats creation as the selector gate: once a
 * worktree exists, setup progress and outcomes stay in `setupState` and the row
 * is left selectable with `disabledReason: null`. Reading only the reason
 * therefore reported a worktree whose setup script FAILED as plain `ready`.
 * Older hosts projected the same lifecycle as `setup_*` reasons, so both
 * spellings are accepted — which is also why a legacy `setup_*` reason is not
 * treated as blocking unless disk truth (`mode === "worktree" && !isGitRepo`)
 * says the worktree is not actually there.
 *
 * Setup states are deliberately NOT "unavailable": the GUI renders them
 * `disabled: false`, because a worktree with a failed setup script is still a
 * directory an agent can work in. They are reported so the user knows why it
 * may be half-configured, not to warn them off it.
 *
 * Ideally this lives in `clients/shared` beside `classifyWorktreeTier`, so CLI
 * and GUI cannot drift; that consolidation is a separate change from this one.
 */
function formatState(row: WorktreeBindingSelectorRowV12): string {
  if (hasBlockingReason(row)) {
    // The host derives `missing_worktree_path` from an `isGitRepo` it has not
    // verified yet, so naming it "missing" states as fact something the next
    // sweep may retract. The pickers render these as "checking" for exactly
    // this reason.
    return row.isGitResolvePending ? "checking" : "missing on disk";
  }
  if (row.setupState === "pending" || row.disabledReason === "setup_pending")
    return "setup pending";
  if (row.setupState === "running" || row.disabledReason === "setup_running")
    return "setting up";
  if (row.setupState === "failed" || row.disabledReason === "setup_failed")
    return "setup failed";
  if (
    row.setupState === "cancelled" ||
    row.disabledReason === "setup_cancelled"
  )
    return "setup cancelled";
  return "ready";
}

/**
 * Mirrors `hasBlockingWorktreeSelectorReason`. A `setup_*` reason from an older
 * host is relaxed once the worktree demonstrably exists; anything else with a
 * reason (today only `missing_worktree_path`) genuinely blocks.
 */
function hasBlockingReason(row: WorktreeBindingSelectorRowV12): boolean {
  switch (row.disabledReason) {
    case null:
      return false;
    case "setup_pending":
    case "setup_running":
    case "setup_failed":
    case "setup_cancelled":
      return row.mode === "worktree" && !row.isGitRepo;
    case "missing_worktree_path":
      return true;
  }
}
