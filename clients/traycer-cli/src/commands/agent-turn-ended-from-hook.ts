import {
  tuiAgentTurnEndedRequestSchemaV11,
  tuiAgentTurnEndedResponseSchemaV11,
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
 * host (`agent.tui.turnEnded@1.1`) so the inter-agent broker can fire a
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
 * @1.1: reads `session_id` + `transcript_path` from the Stop hook's stdin
 * JSON payload (Claude Code). `previouslyReportedLeafUuid` is null here —
 * the host's causal-proof leaf cache is authoritative.
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

    const hookPayload = await readStopHookStdinPayload(readStdinUtf8);

    const request = parseUserInput(tuiAgentTurnEndedRequestSchemaV11, {
      epicId,
      tuiAgentId,
      harnessId,
      observedHarnessSessionId: hookPayload.sessionId,
      transcriptPath: hookPayload.transcriptPath,
      // Host cache is authoritative for the previous leaf.
      previouslyReportedLeafUuid: null,
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

    const { accepted, acceptedLeafUuid } = parseHostResponse(
      tuiAgentTurnEndedResponseSchemaV11,
      rpcResult,
    );
    // No `human` line: a Stop hook's stdout is not surfaced to the user and
    // a status string would only be noise.
    return {
      data: { accepted, acceptedLeafUuid, reason: null },
      human: null,
      exitCode: 0,
    };
  };
}

type StopHookStdinPayload = {
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
};

/**
 * Read Claude Code Stop-hook stdin JSON. Tolerates empty/missing/malformed
 * stdin (returns nulls → exact @1.0 host behavior).
 * Callers must pass a stdin reader (production uses {@link readStdinUtf8}).
 */
export async function readStopHookStdinPayload(
  readStdin: () => Promise<string>,
): Promise<StopHookStdinPayload> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return { sessionId: null, transcriptPath: null };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { sessionId: null, transcriptPath: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { sessionId: null, transcriptPath: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sessionId: null, transcriptPath: null };
  }
  const sessionId = readStringField(parsed, "session_id", "sessionId");
  const transcriptPath = readStringField(
    parsed,
    "transcript_path",
    "transcriptPath",
  );
  return {
    sessionId: sessionId !== null && sessionId.length > 0 ? sessionId : null,
    transcriptPath:
      transcriptPath !== null && transcriptPath.length > 0
        ? transcriptPath
        : null,
  };
}

function readStringField(
  obj: object,
  snake: string,
  camel: string,
): string | null {
  const snakeVal = Reflect.get(obj, snake);
  if (typeof snakeVal === "string") return snakeVal;
  const camelVal = Reflect.get(obj, camel);
  if (typeof camelVal === "string") return camelVal;
  return null;
}

export async function readStdinUtf8(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function noop(reason: NoopReason) {
  return {
    data: { accepted: false, reason },
    human: null,
    exitCode: 0,
  };
}
