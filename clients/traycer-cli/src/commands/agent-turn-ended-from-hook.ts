import {
  tuiAgentTurnEndedRequestSchema,
  tuiAgentTurnEndedResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { tuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

type NoopReason = "missing-context" | "unknown-provider" | "host-unreachable";

/**
 * `traycer agent turn-ended-from-hook --provider <provider>` - invoked by
 * a provider `Stop` hook when a terminal-agent finishes a turn. Signals the
 * host (`agent.tui.turnEnded@1.0`) so the inter-agent broker can fire a
 * `turn-ended` inactivity notice for any thread the agent still owes a
 * reply on. This is the accurate, primary "done" edge - it replaces
 * inferring "done" from raw PTY silence.
 *
 * Like the title hook, it is intentionally lenient: a missing
 * `TRAYCER_EPIC_ID` / `TRAYCER_AGENT_ID` (e.g. claude launched standalone
 * outside Traycer), an unknown provider, or a host-not-running condition
 * all exit cleanly (exit 0, `accepted: false`) with no stderr noise. The
 * hook fires unconditionally, so any benign condition must be a silent
 * no-op. Genuine errors (auth rejection, schema mismatch) still surface.
 *
 * The hook's stdin payload (session metadata) is not needed - the turn-end
 * signal is keyed entirely on the bound agent context from the environment.
 */
export function buildAgentTurnEndedFromHookCommand(opts: {
  readonly provider: string;
  readonly epicId: string | null;
  readonly agentId: string | null;
}): CommandFn {
  return async () => {
    const parsedHarness = tuiHarnessIdSchema.safeParse(opts.provider);
    if (!parsedHarness.success) return noop("unknown-provider");
    const harnessId = parsedHarness.data;

    const epicId = readEpicId(opts.epicId);
    const tuiAgentId = readTuiAgentId(opts.agentId);
    if (epicId === null || tuiAgentId === null) {
      return noop("missing-context");
    }

    const request = parseUserInput(tuiAgentTurnEndedRequestSchema, {
      epicId,
      tuiAgentId,
      harnessId,
    });

    // Host-not-running is benign - the hook fires unconditionally and the
    // host may simply not be up. Other RPC errors (auth, etc.) surface.
    const rpcResult = await toAgentCliError(
      callHostRpc("agent.tui.turnEnded", request),
    ).catch((err: unknown) => {
      if (
        err instanceof CliError &&
        err.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
      ) {
        return "host-unreachable" as const;
      }
      throw err;
    });
    if (rpcResult === "host-unreachable") {
      return noop("host-unreachable");
    }

    const { accepted } = parseHostResponse(
      tuiAgentTurnEndedResponseSchema,
      rpcResult,
    );
    // No `human` line: a Stop hook's stdout is not surfaced to the user and
    // a status string would only be noise.
    return {
      data: { accepted, reason: null },
      human: null,
      exitCode: 0,
    };
  };
}

function noop(reason: NoopReason) {
  return {
    data: { accepted: false, reason },
    human: null,
    exitCode: 0,
  };
}
