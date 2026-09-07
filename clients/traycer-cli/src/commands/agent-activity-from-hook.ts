import {
  recordTuiAgentActivityRequestSchemaV11,
  recordTuiAgentActivityResponseSchema,
  tuiAgentPromptSubmittedRequestSchema,
  tuiAgentPromptSubmittedResponseSchema,
  type RecordTuiAgentActivityRequestV11,
  type RecordTuiAgentActivityResponse,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  tuiHarnessIdSchema,
  type TuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpcFastFail,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { readObservedHarnessSessionId } from "../internal/hook-stdin";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

type ActivityHookEvent = "start" | "stop";

type NoopReason =
  | "missing-context"
  | "unknown-event"
  | "unknown-provider"
  | "host-unreachable";

// Identity fields shared by the `promptSubmitted` call and its `recordActivity`
// fallback - both carry the exact same payload (see the module doc).
interface HookActivityIdentity {
  readonly epicId: string | null;
  readonly tuiAgentId: string | null;
  readonly harnessSessionId: string | null;
  readonly harnessId: TuiHarnessId;
  readonly observedHarnessSessionId: string | null;
}

/** Hook stdin is untrusted provider JSON. Never treat its agent id as a host id. */
export function buildAgentActivityFromHookCommand(opts: {
  readonly provider: string;
  readonly event: string;
  readonly epicId: string | null;
  readonly agentId: string | null;
  readonly harnessSessionId: string | null;
}): CommandFn {
  return async () => {
    const parsedHarness = tuiHarnessIdSchema.safeParse(opts.provider);
    if (!parsedHarness.success) return noop("unknown-provider");
    const event = parseActivityHookEvent(opts.event);
    if (event === null) return noop("unknown-event");

    const harnessSessionId =
      opts.harnessSessionId !== null && opts.harnessSessionId.trim().length > 0
        ? opts.harnessSessionId
        : null;
    const epicId = harnessSessionId === null ? readEpicId(opts.epicId) : null;
    const tuiAgentId =
      harnessSessionId === null ? readTuiAgentId(opts.agentId) : null;
    if (harnessSessionId === null && (epicId === null || tuiAgentId === null)) {
      return noop("missing-context");
    }

    // Read stdin only where a resumable `session_id` is actually piped (see the command doc); skipping elsewhere avoids blocking on a stream the caller never writes to (Codex `notify`, OpenCode session-id-keyed form).
    const observedHarnessSessionId =
      parsedHarness.data === "claude" ||
      (parsedHarness.data === "opencode" && harnessSessionId === null)
        ? await readObservedHarnessSessionId()
        : null;

    const identity: HookActivityIdentity = {
      epicId,
      tuiAgentId,
      harnessSessionId,
      harnessId: parsedHarness.data,
      observedHarnessSessionId,
    };

    // Only providers whose hook runner injects this command's stdout into the outgoing prompt may take the promptSubmitted pull path - the host advances its roles cursor when it hands back pending context, so a provider that discards stdout (OpenCode's in-process plugin) would silently strand the snapshot as "delivered".
    // Those stay on the plain activity edge.
    const consumesPromptEnvelope =
      identity.harnessId === "claude" || identity.harnessId === "codex";

    if (event === "stop" || !consumesPromptEnvelope) {
      const edgeResult = await callRecordActivity(identity, event);
      if (edgeResult === "host-unreachable") return noop("host-unreachable");
      return {
        data: { accepted: edgeResult.accepted, reason: null },
        human: null,
        exitCode: 0,
      };
    }

    return submitPrompt(identity);
  };
}

async function submitPrompt(identity: HookActivityIdentity) {
  const request = parseUserInput(tuiAgentPromptSubmittedRequestSchema, {
    epicId: identity.epicId,
    tuiAgentId: identity.tuiAgentId,
    harnessSessionId: identity.harnessSessionId,
    harnessId: identity.harnessId,
    observedHarnessSessionId: identity.observedHarnessSessionId,
  });
  const rpcResult = await toAgentCliError(
    callHostRpcFastFail("agent.tui.promptSubmitted", request),
  ).catch((err: unknown) => {
    if (
      err instanceof CliError &&
      err.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
    ) {
      return "host-unreachable" as const;
    }
    if (
      err instanceof CliError &&
      err.code === CLI_ERROR_CODES.HOST_UNSUPPORTED
    ) {
      return "host-too-old" as const;
    }
    throw err;
  });
  if (rpcResult === "host-unreachable") return noop("host-unreachable");
  if (rpcResult === "host-too-old") {
    const fallback = await callRecordActivity(identity, "start");
    if (fallback === "host-unreachable") return noop("host-unreachable");
    return {
      data: { accepted: fallback.accepted, reason: null },
      human: null,
      exitCode: 0,
    };
  }

  const { accepted, pendingPromptContext } = parseCanonicalHostResponse(
    "agent.tui.promptSubmitted",
    tuiAgentPromptSubmittedResponseSchema,
    rpcResult,
  );
  return {
    data: { accepted, reason: null },
    human:
      pendingPromptContext === null
        ? null
        : userPromptSubmitEnvelope(pendingPromptContext),
    exitCode: 0,
  };
}

async function callRecordActivity(
  identity: HookActivityIdentity,
  event: ActivityHookEvent,
): Promise<RecordTuiAgentActivityResponse | "host-unreachable"> {
  const requestInput: RecordTuiAgentActivityRequestV11 = {
    epicId: identity.epicId,
    tuiAgentId: identity.tuiAgentId,
    harnessSessionId: identity.harnessSessionId,
    harnessId: identity.harnessId,
    event,
    observedHarnessSessionId: identity.observedHarnessSessionId,
  };
  const request = parseUserInput(
    recordTuiAgentActivityRequestSchemaV11,
    requestInput,
  );
  const rpcResult = await toAgentCliError(
    callHostRpcFastFail("agent.tui.recordActivity", request),
  ).catch((err: unknown) => {
    if (
      err instanceof CliError &&
      err.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
    ) {
      return "host-unreachable" as const;
    }
    throw err;
  });
  if (rpcResult === "host-unreachable") return "host-unreachable";
  return parseCanonicalHostResponse(
    "agent.tui.recordActivity",
    recordTuiAgentActivityResponseSchema,
    rpcResult,
  );
}

function userPromptSubmitEnvelope(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
}

function parseActivityHookEvent(value: string): ActivityHookEvent | null {
  if (value === "start" || value === "stop") return value;
  return null;
}

function noop(reason: NoopReason) {
  return {
    data: { accepted: false, reason },
    human: null,
    exitCode: 0,
  };
}
