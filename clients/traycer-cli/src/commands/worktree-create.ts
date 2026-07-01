import {
  type WorktreeBranchSelection,
  worktreeCreatePathsRequestSchema,
  worktreeCreatePathsResponseSchema,
} from "@traycer/protocol/host";
import {
  callHostRpc,
  parseHostResponse,
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
    const parsed = parseHostResponse(worktreeCreatePathsResponseSchema, result);
    return {
      data: parsed,
      human: JSON.stringify(parsed, null, 2),
      exitCode: parsed.perEntry.every((entry) => entry.ok) ? 0 : 1,
    };
  };
}
