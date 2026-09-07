import {
  forkAgentRequestSchema,
  forkAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { parseForkProfileSelection } from "../internal/profile-selection";
import { parseAgentCreateWorkspace } from "./agent-create";
import type { CommandFn } from "../runner/runner";

/** Fork a local agent. `--agent-id` is raw client input; do not interpolate it into log paths. */
export function buildAgentForkCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly agentId: string;
  readonly name: string | null;
  readonly permissionMode: string | null;
  readonly profile: string | null;
  readonly cwd: string | null;
  readonly workspacePaths: readonly string[];
  readonly workspaceEntries: readonly string[];
}): CommandFn {
  return async () => {
    const request = parseUserInput(forkAgentRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      agentId: opts.agentId,
      name: opts.name,
      permissionMode: opts.permissionMode ?? "full_access",
      workspace: parseAgentCreateWorkspace({
        cwd: opts.cwd,
        workspacePaths: opts.workspacePaths,
        workspaceEntries: opts.workspaceEntries,
      }),
      profileSelection: parseForkProfileSelection(opts.profile),
    });
    const result = await toAgentCliError(callHostRpc("agent.fork", request));
    const response = parseCanonicalHostResponse(
      "agent.fork",
      forkAgentResponseSchema,
      result,
    );
    const lines = [
      response.agentId,
      `Forked from: ${response.sourceAgentId}`,
      `Forked from message: ${response.forkedFromMessageId ?? "(terminal fork - no message boundary)"}`,
      // `null` is the ambient provider login, NOT the absence of a profile - see `forkAgentResponseSchema`.
      // Printing "(none)" read as "no profile", which is exactly wrong for a fork that inherited or selected ambient.
      `Effective profile: ${response.effectiveProfileId ?? "ambient (provider CLI login)"}`,
      `Profile override applied: ${response.profileOverrideApplied ? "yes" : "no"}`,
    ];
    if (response.warnings.length > 0) {
      lines.push(
        "Warnings:",
        ...response.warnings.map((warning) => `- ${warning}`),
      );
    }
    return { data: response, human: lines.join("\n"), exitCode: 0 };
  };
}
