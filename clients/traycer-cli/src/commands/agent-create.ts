import path from "node:path";
import {
  createAgentRequestSchema,
  createAgentResponseSchema,
  type CreateAgentWorkspace,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent create` - mint a child agent (`agent.create`). The new
 * agent's `parentId` is the sender.
 *
 * Surface selection:
 *   - `--surface gui|tui` (+ `--harness`, optional `--model` for gui)
 *     pins the child's surface + harness explicitly.
 *   - `--harness` without `--surface`: the host infers the surface from
 *     the sender and requested harness.
 *   - neither: the child inherits the sender's surface + harness.
 */
export function buildAgentCreateCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly surface: string | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly agentMode: string | null;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  readonly cwd: string | null;
  readonly workspacePaths: readonly string[];
  readonly workspaceEntries: readonly string[];
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);

    // Validate the full request locally so a bad --surface / --harness
    // fails fast with a clear E_INVALID_ARGUMENT (listing the allowed harness
    // values) instead of round-tripping or leaking a raw ZodError stack.
    const request = parseUserInput(createAgentRequestSchema, {
      senderAgentId,
      epicId,
      surface: opts.surface,
      harnessId: opts.harness,
      model: opts.model,
      agentMode: opts.agentMode,
      reasoningEffort: opts.reasoningEffort,
      fastMode: opts.fast ? true : null,
      workspace: parseAgentCreateWorkspace({
        cwd: opts.cwd,
        workspacePaths: opts.workspacePaths,
        workspaceEntries: opts.workspaceEntries,
      }),
    });
    const result = await toAgentCliError(callHostRpc("agent.create", request));
    const { agentId, warnings } = parseHostResponse(
      createAgentResponseSchema,
      result,
    );
    const human =
      warnings.length === 0
        ? agentId
        : `${agentId}\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
    return { data: { agentId, warnings }, human, exitCode: 0 };
  };
}

export function parseAgentCreateWorkspace(input: {
  readonly cwd: string | null;
  readonly workspacePaths: readonly string[];
  readonly workspaceEntries: readonly string[];
}): CreateAgentWorkspace {
  const entries = [
    ...pathOnlyEntries(input.cwd === null ? [] : [input.cwd]),
    ...pathOnlyEntries(input.workspacePaths),
    ...structuredEntries(input.workspaceEntries),
  ];
  if (entries.length === 0) return null;
  const seenPaths = new Set<string>();
  const deduped = entries.filter((entry) => {
    if (seenPaths.has(entry.path)) return false;
    seenPaths.add(entry.path);
    return true;
  });
  // The host derives mode / repoIdentifier from the paths and treats the
  // first entry as primary, so the CLI only forwards `path` (+ source
  // `workspacePath` for an exact binding).
  return { entries: deduped };
}

function pathOnlyEntries(
  paths: readonly string[],
): CreateAgentWorkspaceEntry[] {
  return paths.map((rawPath) => {
    const resolvedPath = requireAbsolutePath(rawPath, "--cwd/--workspace-path");
    return { path: resolvedPath, workspacePath: null };
  });
}

function structuredEntries(
  entries: readonly string[],
): CreateAgentWorkspaceEntry[] {
  return entries.map((rawEntry) => {
    const separator = rawEntry.indexOf("=");
    if (separator === -1) {
      const resolvedPath = requireAbsolutePath(rawEntry, "--workspace-entry");
      return { path: resolvedPath, workspacePath: null };
    }
    const workspacePath = requireAbsolutePath(
      rawEntry.slice(0, separator),
      "--workspace-entry source path",
    );
    const runPath = requireAbsolutePath(
      rawEntry.slice(separator + 1),
      "--workspace-entry run path",
    );
    return { path: runPath, workspacePath };
  });
}

type CreateAgentWorkspaceEntry =
  NonNullable<CreateAgentWorkspace>["entries"][number];

function requireAbsolutePath(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `agent create: ${label} must be an absolute path. Use --cwd <worktree-path> for a path returned by traycer worktree create, or --workspace-entry <source-path>=<run-path> for an exact binding.`,
      details: { value: rawPath },
      exitCode: 1,
    });
  }
  return path.resolve(trimmed);
}
