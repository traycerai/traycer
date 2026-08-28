import {
  type WorktreeBranchSelection,
  type WorktreeCreatePathsResponse,
  worktreeCreatePathsRequestSchema,
  worktreeCreatePathsResponseSchema,
} from "@traycer/protocol/host";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

export interface WorktreeCreateCommandOpts {
  readonly workspacePath: string;
  // `--branch`: create a fresh branch (the `new` selection). Mutually
  // exclusive with `existingBranch`.
  readonly newBranch: string | null;
  // `--existing`: check an already-existing branch out into a fresh worktree
  // (the `existing` selection). Mutually exclusive with `newBranch`.
  readonly existingBranch: string | null;
  // `--source-branch`: branch the `new` selection forks from. When omitted the
  // command resolves the workspace's current branch from the host.
  readonly sourceBranch: string | null;
  readonly carryUncommittedChanges: boolean;
}

/**
 * Resolve the CLI flags into the host's branch-selection union. `--existing`
 * routes to the `existing` variant verbatim (no source / no carry); `--branch`
 * routes to the `new` variant, defaulting `source` to the workspace's current
 * branch (resolved from the host) when `--source-branch` is omitted - the
 * same branch the renderer picks. The empty-name and mutual-exclusion guards
 * run here, before any create call, so a misuse reports a clear CLI error
 * rather than a raw zod failure from the host.
 */
export async function resolveWorktreeBranchSelection(
  opts: WorktreeCreateCommandOpts,
): Promise<WorktreeBranchSelection> {
  if (opts.newBranch !== null && opts.existingBranch !== null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: --branch (create a new branch) and --existing (check out an existing branch) cannot be combined - pass exactly one.",
      details: null,
      exitCode: 1,
    });
  }

  if (opts.existingBranch !== null) {
    // `--existing` checks the branch out as-is; it has no fork source, so a
    // supplied `--source-branch` would be silently dropped. Reject it instead.
    if (opts.sourceBranch !== null) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: --source-branch only applies to --branch (creating a new branch); it cannot be combined with --existing.",
        details: null,
        exitCode: 1,
      });
    }
    // Same rule, same reason: the `existing` selection carries no
    // `carryUncommittedChanges` field, so this flag had been accepted and then
    // silently dropped - the user asked for their work to come along and it
    // did not. Refuse rather than quietly do nothing.
    if (opts.carryUncommittedChanges) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: --carry-uncommitted only applies to --branch (creating a new branch); it cannot be combined with --existing.",
        details: null,
        exitCode: 1,
      });
    }
    const name = opts.existingBranch.trim();
    if (name.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: --existing requires a non-empty branch name.",
        details: null,
        exitCode: 1,
      });
    }
    return { type: "existing", name };
  }

  const name = opts.newBranch === null ? "" : opts.newBranch.trim();
  if (name.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: pass --branch <name> to create a new branch or --existing <name> to check out an existing one.",
      details: null,
      exitCode: 1,
    });
  }

  // A whitespace-only `--source-branch` is not a valid branch name; treat it
  // like an omitted flag and fall back to the workspace's current branch.
  const trimmedSource = opts.sourceBranch?.trim() ?? "";
  const source =
    trimmedSource.length > 0
      ? trimmedSource
      : await resolveCurrentBranch(opts.workspacePath);

  return {
    type: "new",
    name,
    source,
    carryUncommittedChanges: opts.carryUncommittedChanges,
    collision: "fail",
  };
}

/**
 * Resolve the workspace's current branch: ask the host for its branch list
 * and take the one HEAD points at. This is the `source` a new branch forks from
 * when `--source-branch` is omitted, matching how the renderer resolves it.
 */
async function resolveCurrentBranch(workspacePath: string): Promise<string> {
  const response = await toAgentCliError(
    callHostRpc("worktree.listBranches", {
      workspacePath,
      includeRemote: false,
    }),
  );
  const current = response.branches.find((branch) => branch.isCurrent);
  if (current === undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: could not resolve the workspace's current branch (detached HEAD or not a Git worktree) - pass --source-branch <branch> explicitly.",
      details: null,
      exitCode: 1,
    });
  }
  return current.name;
}

export function buildWorktreeCreateCommand(
  opts: WorktreeCreateCommandOpts,
): CommandFn {
  return async () => {
    const branch = await resolveWorktreeBranchSelection(opts);
    const request = parseUserInput(worktreeCreatePathsRequestSchema, {
      entries: [{ workspacePath: opts.workspacePath, branch }],
    });
    const result = await toAgentCliError(
      callHostRpc("worktree.createPaths", request),
    );
    const parsed = parseCanonicalHostResponse(
      "worktree.createPaths",
      worktreeCreatePathsResponseSchema,
      result,
    );
    return {
      data: parsed,
      human: formatWorktreeCreateResult(parsed, branch),
      exitCode: parsed.perEntry.every((entry) => entry.ok) ? 0 : 1,
    };
  };
}

/**
 * Human summary of a create. Pure so the layout is testable without a host, and
 * deliberately not the response object: `--json` still returns the protocol
 * shape verbatim for anyone parsing this, while a person gets the four facts
 * they came for - where it landed, on which branch, from what, and what to do
 * with it.
 *
 * The `branch` selection is threaded in rather than read back off the response
 * because it is the only place the *intent* survives: the wire response reports
 * a branch name, not whether that branch was created or checked out, nor
 * whether uncommitted changes were carried along.
 */
export function formatWorktreeCreateResult(
  response: WorktreeCreatePathsResponse,
  branch: WorktreeBranchSelection,
): string {
  const failures = response.perEntry.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    return failures
      .map((entry) =>
        [
          `Could not create a worktree for ${entry.workspacePath}`,
          `  ${entry.errorMessage ?? "The host reported no reason."}`,
        ].join("\n"),
      )
      .join("\n\n");
  }
  if (response.entries.length === 0) {
    // `perEntry` says every entry succeeded, so an empty `entries` is the host
    // contradicting itself. Say so plainly instead of printing a confident
    // summary of nothing.
    return "The host reported success but returned no worktree path. Run with --json to see the full response.";
  }
  const lines: string[] = [];
  for (const entry of response.entries) {
    if (lines.length > 0) lines.push("");
    lines.push(`Created worktree ${entry.path}`);
    lines.push(
      ...kvBlock([
        ["Branch", formatBranch(entry.branch, branch)],
        ["Source", entry.workspacePath],
        [
          "Repo",
          entry.repoIdentifier === null
            ? "(no parseable Git remote - filed under a local path)"
            : `${entry.repoIdentifier.owner}/${entry.repoIdentifier.repo}`,
        ],
        ["Mode", entry.mode],
        // Only the `new` selection can carry work across, and
        // `resolveWorktreeBranchSelection` rejects `--carry-uncommitted`
        // alongside `--existing`, so an `existing` create has nothing to
        // report here rather than a "no" a reader would have to interpret.
        //
        // The carrying case is reported as INTENT, not as an outcome, and the
        // distinction is load-bearing. The response says a worktree was
        // created; it does not say whether any WIP came with it. Carry is
        // best-effort on the host - an unresolvable carry root, a failed stash
        // replay, an unreadable untracked file - and none of those turn the
        // create into a failed `perEntry`. Printing "carried" off the request
        // flag would state as fact something this command cannot observe, which
        // is the class of false human status CLI-020 exists to remove. The
        // not-carrying case IS certain: nothing was asked for, so nothing moved.
        ...(branch.type === "existing"
          ? []
          : ([
              [
                "Uncommitted changes",
                branch.carryUncommittedChanges
                  ? "carry requested - best effort, confirm in the new worktree"
                  : "left in the source workspace",
              ],
            ] satisfies [string, string][])),
      ]),
    );
  }
  lines.push("");
  lines.push("Run an agent in it with `traycer agent create --cwd <path>`.");
  return lines.join("\n");
}

/**
 * The host's `branch` when it reported one, and an explicit "it did not" when
 * it did not.
 *
 * This used to fall back to `branch.name` - the name we ASKED for - and then
 * describe it with the same "(new branch, forked from x)" / "(checked out)"
 * confidence as a reported one. `worktreeCreatedPathEntrySchema` makes the
 * returned branch nullable, so a null is the host declining to state the
 * outcome, and echoing the request back dressed as a result is the same
 * false-status defect this file already fixed for the carry row. The requested
 * name is still shown, because it is the useful thing to print - it is just
 * labelled as the request rather than as what happened.
 */
function formatBranch(
  created: string | null,
  branch: WorktreeBranchSelection,
): string {
  if (created === null) {
    return `${branch.name} (requested; the host did not report the resulting branch)`;
  }
  return branch.type === "existing"
    ? `${created} (checked out; the branch already existed)`
    : `${created} (new branch, forked from ${branch.source})`;
}

function kvBlock(rows: readonly [string, string][]): string[] {
  const keyWidth = rows.reduce(
    (width, [key]) => Math.max(width, key.length),
    0,
  );
  return rows.map(([key, value]) => `  ${key.padEnd(keyWidth)}  ${value}`);
}
