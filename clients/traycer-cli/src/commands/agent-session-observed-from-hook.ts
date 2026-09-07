import {
  recordTuiAgentActivityRequestSchemaV11,
  recordTuiAgentActivityResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { tuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import {
  callHostRpcFastFail,
  isRequestVersionProjectionError,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { readObservedHarnessSessionId } from "../internal/hook-stdin";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

type NoopReason =
  | "missing-context"
  | "unknown-provider"
  | "no-session"
  | "host-too-old"
  | "host-unreachable";

/** Hook stdin is untrusted provider JSON. Never treat its session id as a host id. */
export function buildAgentSessionObservedFromHookCommand(opts: {
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

    // Resync providers: Claude (SessionStart pipes the live id) and OpenCode (the per-TUI plugin pipes the sighted root-session id; the host rekeys its session registry in lockstep).
    // Codex ships no hook surface; for any other provider there is nothing to observe, so skip the read and no-op.
    const observedHarnessSessionId =
      harnessId === "claude" || harnessId === "opencode"
        ? await readObservedHarnessSessionId()
        : null;
    if (observedHarnessSessionId === null) {
      return noop("no-session");
    }

    const request = parseUserInput(recordTuiAgentActivityRequestSchemaV11, {
      epicId,
      tuiAgentId,
      harnessSessionId: null,
      harnessId,
      event: "resync",
      observedHarnessSessionId,
    });

    // Two benign version-skew / liveness conditions degrade to a quiet no-op; everything else (auth, genuine host errors) still surfaces: • host-too-old: a newer CLI vs a host that only speaks recordActivity@1.0 has no `event: "resync"`, so the transport fails to project this request onto the host's older minor locally, before it is sent (unlike the additive `observedHarnessSessionId` field, an unknown enum value can't be stripped).
    // A resync against a pre-1.1 host is meaningless, so it must not surface as hook noise.
    const rpcResult = await toAgentCliError(
      callHostRpcFastFail("agent.tui.recordActivity", request).catch(
        (err: unknown) => {
          if (isRequestVersionProjectionError(err)) {
            return "host-too-old" as const;
          }
          throw err;
        },
      ),
    ).catch((err: unknown) => {
      if (
        err instanceof CliError &&
        err.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
      ) {
        return "host-unreachable" as const;
      }
      throw err;
    });
    if (rpcResult === "host-too-old") {
      return noop("host-too-old");
    }
    if (rpcResult === "host-unreachable") {
      return noop("host-unreachable");
    }

    const { accepted } = parseCanonicalHostResponse(
      "agent.tui.recordActivity",
      recordTuiAgentActivityResponseSchema,
      rpcResult,
    );
    // No `human` line: a SessionStart hook's stdout is surfaced back into the
    // Claude TUI as context, and a status string would only be noise.
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
