import {
  claimAgentRoleRequestSchema,
  claimAgentRoleResponseSchemaV11,
  listAgentRolesRequestSchema,
  listAgentRolesResponseSchema,
  relinquishAgentRoleRequestSchema,
  relinquishAgentRoleResponseSchemaV11,
} from "@traycer/protocol/host/agent/roles";
import {
  formatClaimRoleResponseV11,
  formatListRolesResponse,
  formatRelinquishRoleResponseV11,
} from "@traycer/protocol/agent/agent-roles-format";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent role claim|list|relinquish` - the Claude TUI surface of the
 * Task role registry (`agent.roles.*`).
 *
 * Every command validates the request it builds through the PROTOCOL request
 * schema (`parseUserInput`) BEFORE any transport: role/scope normalization
 * (NFC, whitespace fold, trim) and claimId UUID validation happen client-side,
 * a bad value reports the offending field as a clean `E_INVALID_ARGUMENT`, and
 * NO request frame is sent for invalid input. Output goes through the SAME
 * protocol formatters the GUI tools render with, so both surfaces produce
 * byte-identical text for identical responses. On a host that does not
 * advertise `agent.roles.*`, the shared client refuses to dispatch client-side
 * (zero writes) and this surfaces as `E_HOST_UNSUPPORTED` ("update the host").
 */
export function buildAgentRoleClaimCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string | null;
  readonly role: string | null;
  readonly scope: string | null;
}): CommandFn {
  return async () => {
    const request = parseUserInput(claimAgentRoleRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      claimantAgentId: resolveSenderAgentId(opts.agentId),
      role: opts.role ?? "",
      scope: opts.scope ?? "",
    });
    const result = await toAgentCliError(
      callHostRpc("agent.roles.claim", request),
    );
    const response = parseHostResponse(claimAgentRoleResponseSchemaV11, result);
    return {
      data: response,
      human: formatClaimRoleResponseV11(response),
      exitCode: 0,
    };
  };
}

export function buildAgentRoleListCommand(opts: {
  readonly epicId: string | null;
}): CommandFn {
  return async () => {
    const request = parseUserInput(listAgentRolesRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
    });
    const result = await toAgentCliError(
      callHostRpc("agent.roles.list", request),
    );
    const response = parseHostResponse(listAgentRolesResponseSchema, result);
    return {
      data: response,
      human: formatListRolesResponse(response),
      exitCode: 0,
    };
  };
}

export function buildAgentRoleRelinquishCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string | null;
  readonly claimId: string | null;
}): CommandFn {
  return async () => {
    const request = parseUserInput(relinquishAgentRoleRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      claimantAgentId: resolveSenderAgentId(opts.agentId),
      claimId: opts.claimId ?? "",
    });
    const result = await toAgentCliError(
      callHostRpc("agent.roles.relinquish", request),
    );
    const response = parseHostResponse(
      relinquishAgentRoleResponseSchemaV11,
      result,
    );
    return {
      data: response,
      human: formatRelinquishRoleResponseV11(response),
      exitCode: 0,
    };
  };
}
