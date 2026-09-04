import { formatProfileSelection } from "@traycer/protocol/agent/agent-profile-format";
import {
  getAgentNativeSessionBindingResponseSchema,
  listAgentsResponseSchema,
  type GetAgentNativeSessionBindingResponse,
} from "@traycer/protocol/host/agent/shared";
import { listTuiAgentsResponseV12Schema } from "@traycer/protocol/host/epic/tui-agent-records";
import {
  callHostRpc,
  callHostRpcAtEndpoint,
  parseCanonicalHostResponse,
  resolveEndpoint,
  toAgentCliError,
} from "../internal/host-rpc";
import type { HostTransportEndpoint } from "../../../shared/host-transport/host-messenger";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { CLI_ERROR_CODES, CliError, cliError } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent binding` - read the current provider-native session identity
 * for one local GUI or TUI agent. The structured response is intentionally
 * narrow enough for an external recorder to join on `agentId` plus
 * `harnessSessionId` without receiving provider-account or transcript data.
 *
 * A null session id is a successful pending observation, not an error. GUI
 * agents can later acquire a different current binding after changing harness
 * or profile, so consumers that need history should retain every non-null pair
 * they observe rather than overwrite their own join table.
 */
export function buildAgentBindingCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly agentId: string;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);
    const request = { epicId, senderAgentId, agentId: opts.agentId };
    let response: GetAgentNativeSessionBindingResponse;
    try {
      const result = await toAgentCliError(
        callHostRpc("agent.getNativeSessionBinding", request),
      );
      response = parseCanonicalHostResponse(
        "agent.getNativeSessionBinding",
        getAgentNativeSessionBindingResponseSchema,
        result,
      );
    } catch (error: unknown) {
      if (!isNativeBindingUnsupported(error)) throw error;
      response = await resolveReleasedHostTuiBinding({
        epicId,
        senderAgentId,
        agentId: opts.agentId,
        endpoint: await resolveEndpoint(),
        unsupportedError: error,
      });
    }
    const human = [
      `Agent: ${response.agentId}`,
      `Surface: ${response.surface}`,
      `Harness: ${response.harnessId}`,
      `Profile: ${formatProfileSelection(response.profileSelection)}`,
      `Native session: ${response.harnessSessionId ?? "not observed yet"}`,
    ].join("\n");
    return { data: response, human, exitCode: 0 };
  };
}

/**
 * Recover a TUI binding from the released Host's existing, authorized record
 * reads. The fallback never opens `chat.subscribe`: even its windowed v1.8
 * snapshot carries a hydrated transcript tail, so using it for GUI bindings
 * would violate this command's metadata-only boundary.
 *
 * The two broader responses below can contain titles, workspace folders, and
 * terminal launch metadata. They live only in this short-lived CLI process and
 * are immediately projected into the same narrow response schema as the native
 * RPC. GUI agents keep the original E_HOST_UNSUPPORTED result until the Host
 * implements the dedicated resolver.
 */
async function resolveReleasedHostTuiBinding(input: {
  readonly epicId: string;
  readonly senderAgentId: string;
  readonly agentId: string;
  readonly endpoint: HostTransportEndpoint;
  readonly unsupportedError: CliError;
}): Promise<GetAgentNativeSessionBindingResponse> {
  const listResult = await toAgentCliError(
    callHostRpcAtEndpoint(
      "agent.list",
      {
        epicId: input.epicId,
        senderAgentId: input.senderAgentId,
        scope: "user",
      },
      input.endpoint,
    ),
  );
  const listed = parseCanonicalHostResponse(
    "agent.list",
    listAgentsResponseSchema,
    listResult,
  );
  const targets = listed.agents.filter((agent) => agent.id === input.agentId);
  if (targets.length === 0) throw unavailableAgent();
  if (targets.length !== 1) {
    throw incompatibleReleasedHostRecords();
  }
  const target = targets[0];
  if (!target.isLocal) {
    throw cliError({
      code: CLI_ERROR_CODES.AGENT_NOT_LOCAL,
      message:
        "traycer: Agent is owned by another host; query its binding on that host.",
      details: null,
      exitCode: 1,
    });
  }
  if (target.surface !== "tui" || target.harnessId === null) {
    throw input.unsupportedError;
  }
  if (target.hostId !== input.endpoint.hostId) {
    throw incompatibleReleasedHostRecords();
  }

  const tuiResult = await toAgentCliError(
    callHostRpcAtEndpoint(
      "epic.listTuiAgents",
      {
        epicId: input.epicId,
        hasDocReplica: false,
      },
      input.endpoint,
    ),
  );
  const tuiRecords = parseCanonicalHostResponse(
    "epic.listTuiAgents",
    listTuiAgentsResponseV12Schema,
    tuiResult,
  );
  const records = tuiRecords.tuiAgents.filter(
    (candidate) => candidate.tuiAgentId === input.agentId,
  );
  const record = records[0];
  if (records.length === 0) {
    // The record reads are individually authorized but not atomic. Distinguish
    // a target deleted between them from a malformed Host registry response.
    const recheckResult = await toAgentCliError(
      callHostRpcAtEndpoint(
        "agent.list",
        {
          epicId: input.epicId,
          senderAgentId: input.senderAgentId,
          scope: "user",
        },
        input.endpoint,
      ),
    );
    const rechecked = parseCanonicalHostResponse(
      "agent.list",
      listAgentsResponseSchema,
      recheckResult,
    );
    const remaining = rechecked.agents.filter(
      (agent) => agent.id === input.agentId,
    );
    if (remaining.length === 0) throw unavailableAgent();
    throw incompatibleReleasedHostRecords();
  }
  if (
    records.length !== 1 ||
    record === undefined ||
    record.origin !== "registry" ||
    record.docResident ||
    record.hostId !== target.hostId ||
    record.harnessId !== target.harnessId
  ) {
    throw incompatibleReleasedHostRecords();
  }

  const projected = getAgentNativeSessionBindingResponseSchema.safeParse({
    agentId: target.id,
    surface: "tui",
    harnessId: target.harnessId,
    profileSelection:
      record.profileId === null
        ? { kind: "ambient" }
        : { kind: "profile", profileId: record.profileId },
    harnessSessionId: record.harnessSessionId,
  });
  if (!projected.success) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      message:
        "traycer: the released host returned a native binding this CLI could not safely project - try 'traycer host restart'.",
      details: null,
      exitCode: 1,
    });
  }
  return projected.data;
}

function unavailableAgent(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AGENT_NOT_FOUND,
    message:
      "traycer: Agent is unavailable. Check --agent-id (or $TRAYCER_AGENT_ID).",
    details: null,
    exitCode: 1,
  });
}

function incompatibleReleasedHostRecords(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
    message:
      "traycer: the released host returned inconsistent local agent records - try 'traycer host restart'.",
    details: null,
    exitCode: 1,
  });
}

/** Match only absence of the new optional method, not an unrelated failure. */
function isNativeBindingUnsupported(error: unknown): error is CliError {
  return (
    error instanceof CliError &&
    error.code === CLI_ERROR_CODES.HOST_UNSUPPORTED &&
    error.details?.method === "agent.getNativeSessionBinding"
  );
}
