import {
  worktreeListAllForHostRequestSchemaV14,
  worktreeListAllForHostResponseSchemaV14,
} from "@traycer/protocol/host";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host";
import {
  WORKTREE_TIER_LABEL,
  classifyWorktreeTier,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES, toCliError } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

// A client-side ask, not a guarantee: the host clamps page size by request mode
// (currently smaller for probed pages, larger for base pages). Over-asking is
// harmless because the loop trusts `nextCursor` until exhaustion.
const DEFAULT_WORKTREE_LIST_PAGE_LIMIT = 32;

/**
 * One listing row: the raw enriched host entry plus the evidence tier computed
 * by the shared classifier (`classifyWorktreeTier` - the exact function behind
 * the Settings ▸ Worktrees pills, so CLI and GUI can never disagree). `tier` is
 * `null` when `--include-activity` was not passed: the activity probes are what
 * feed the greens, so classifying unprobed entries would misread every worktree
 * as Review. Null mirrors the probe-skipped semantics of the other fields.
 */
export type WorktreeListRow = WorktreeHostEntryV14 & {
  readonly tier: WorktreeTier | null;
};

export interface WorktreeListCommandOpts {
  // `--include-activity`: opt into the host's per-worktree git probes
  // (`lastActivityAt`, `branchStatus`). Off by default so the listing stays
  // cheap; the housekeeping skill turns it on to classify staleness. `owners`
  // and `createdAt` are returned either way.
  readonly includeActivity: boolean;
  readonly cursor: string | null;
  readonly limit: string | null;
}

interface WorktreeListPage {
  readonly worktrees: WorktreeListRow[];
  readonly nextCursor: string | null;
}

/**
 * `traycer worktree list` - host-wide listing of every Traycer-managed
 * worktree under `~/.traycer/worktrees/`. Calls `worktree.listAllForHost@1.4`;
 * the canonical (latest) request carries `includeActivity`, so a v1.0 host is
 * bridged up transparently (enriched fields default to empty `owners` / `null`
 * timestamps). Human mode renders a scannable table; `--json` hands the
 * enriched entries to the caller (the skill), each carrying the shared
 * classifier's computed `tier` (null without `--include-activity`).
 */
export function buildWorktreeListCommand(
  opts: WorktreeListCommandOpts,
): CommandFn {
  return async () => {
    const explicitPaging = opts.limit !== null;
    const explicitLimit = parseWorktreeListLimit(opts.limit);

    if (explicitPaging) {
      const page = await requestWorktreeListPage(
        opts.includeActivity,
        opts.cursor,
        explicitLimit,
      );
      return {
        data: { worktrees: page.worktrees, nextCursor: page.nextCursor },
        human: formatWorktreeListTable(
          page.worktrees,
          opts.includeActivity,
          page.nextCursor,
        ),
        exitCode: 0,
      };
    }

    const worktrees: WorktreeListRow[] = [];
    let cursor: string | null = opts.cursor;

    while (true) {
      let page: WorktreeListPage;
      try {
        page = await requestWorktreeListPage(
          opts.includeActivity,
          cursor,
          DEFAULT_WORKTREE_LIST_PAGE_LIMIT,
        );
      } catch (err) {
        throw worktreeListResumeError(err, worktrees, cursor);
      }

      worktrees.push(...page.worktrees);
      if (page.nextCursor === null) {
        return {
          data: { worktrees, nextCursor: null },
          human: formatWorktreeListTable(worktrees, opts.includeActivity, null),
          exitCode: 0,
        };
      }
      cursor = page.nextCursor;
    }
  };
}

export function parseWorktreeListLimit(value: string | null): number | null {
  if (value === null) return null;
  const limit = Number(value);
  if (Number.isSafeInteger(limit) && limit > 0) return limit;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: "traycer worktree list: --limit must be a positive integer.",
    details: { limit: value },
    exitCode: 1,
  });
}

async function requestWorktreeListPage(
  includeActivity: boolean,
  cursor: string | null,
  limit: number | null,
): Promise<WorktreeListPage> {
  const request = parseUserInput(worktreeListAllForHostRequestSchemaV14, {
    includeActivity,
    // The CLI is a paged-listing caller, never a GUI per-selection probe.
    activityPaths: null,
    cursor,
    limit,
    // CLI invocations are one-shot accuracy reads, so each page deliberately
    // awaits resolve-now instead of inheriting the GUI's cache-only poll path.
    forceRefresh: true,
  });
  const result = await toAgentCliError(
    callHostRpc("worktree.listAllForHost", request),
  );
  const parsed = parseHostResponse(
    worktreeListAllForHostResponseSchemaV14,
    result,
  );
  return {
    worktrees: parsed.worktrees.map((entry) => ({
      ...entry,
      tier: includeActivity ? classifyWorktreeTier(entry) : null,
    })),
    nextCursor: parsed.nextCursor,
  };
}

function worktreeListResumeError(
  err: unknown,
  worktrees: ReadonlyArray<WorktreeListRow>,
  resumeCursor: string | null,
): Error {
  const cliErr = toCliError(err);
  const resumeHint =
    resumeCursor === null
      ? "retry the command to resume from the beginning"
      : `resume with --cursor ${resumeCursor}`;
  return cliError({
    code: cliErr.code,
    message: `${cliErr.message} Partial worktree rows are available; ${resumeHint}.`,
    details: {
      worktrees,
      resumeCursor,
    },
    exitCode: cliErr.exitCode,
  });
}

const COLUMNS = [
  "REPO",
  "BRANCH",
  "TIER",
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
  worktrees: ReadonlyArray<WorktreeListRow>,
  includeActivity: boolean,
  nextCursor: string | null,
): string {
  if (worktrees.length === 0)
    return formatWorktreeListTailHints([], nextCursor);
  const rows = worktrees.map((entry) => [
    entry.repoLabel,
    entry.branch ?? "(detached)",
    entry.tier === null ? "-" : WORKTREE_TIER_LABEL[entry.tier],
    entry.inUse ? "yes" : "no",
    String(entry.uncommittedCount),
    formatLastActive(entry.lastActivityAt),
    String(entry.owners.length),
    entry.worktreePath,
  ]);
  const widths = COLUMNS.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, row[column].length), header.length),
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
      "Pass --include-activity for last-active timestamps, branch status, and the computed tier.",
    );
  }
  return formatWorktreeListTailHints(lines, nextCursor);
}

function formatWorktreeListTailHints(
  lines: ReadonlyArray<string>,
  nextCursor: string | null,
): string {
  const outputLines =
    lines.length === 0 ? ["No Traycer-managed worktrees found."] : [...lines];
  if (nextCursor !== null) {
    outputLines.push(
      "",
      `More worktrees available - resume with --cursor ${nextCursor}.`,
    );
  }
  return outputLines.join("\n");
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
