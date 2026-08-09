import {
  forkAgentRequestSchema,
  forkAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { parseForkProfileSelection } from "../internal/profile-selection";
import { parseAgentCreateWorkspace } from "./agent-create";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent fork --agent-id …` - clone an existing local agent (GUI chat
 * or Claude Code terminal session) into a NEW agent seeded from the source's
 * latest available checkpoint (`agent.fork`). Wraps the same
 * `forkAgentFromRequest` core the `traycer_fork_agent` A2A tool calls.
 *
 * `--agent-id` accepts an unambiguous id PREFIX, resolved host-side
 * (`resolveAgentIdPrefix`) - unlike `agent stop`/`agent archive`, which take a
 * full agent id.
 *
 * `--profile` (see `internal/profile-selection.ts`): omission sends
 * `inherit` (byte-for-byte continuation of the SOURCE agent's own profile,
 * not the caller's last-used preference), `ambient` sends the provider's
 * ambient login explicitly, anything else pins that managed profile.
 *
 * `--workspace-path`/`--workspace-entry`/`--cwd` reuse `agent create`'s
 * workspace parsing verbatim (`parseAgentCreateWorkspace`): omitting all
 * three inherits the SOURCE agent's workspace binding, exactly as omitting
 * `workspace` on the wire does.
 *
 * The response echoes `effectiveProfileId`/`profileOverrideApplied` rather
 * than the caller's own request, so a caller that cares whether its
 * `--profile` override actually took effect must check those echoed fields -
 * a rejected/ignored override does not fail the call.
 */
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
    const response = parseHostResponse(forkAgentResponseSchema, result);
    const lines = [
      response.agentId,
      `Forked from: ${response.sourceAgentId}`,
      `Forked from message: ${response.forkedFromMessageId ?? "(terminal fork - no message boundary)"}`,
      // `null` is the ambient provider login, NOT the absence of a profile -
      // see `forkAgentResponseSchema`. Printing "(none)" read as "no profile",
      // which is exactly wrong for a fork that inherited or selected ambient.
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
