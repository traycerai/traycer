import {
  recordTuiAgentActivityRequestSchemaV11,
  recordTuiAgentActivityResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { tuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import {
  callHostRpcFastFail,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import { readObservedHarnessSessionId } from "../internal/hook-stdin";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

type ActivityHookEvent = "start" | "stop";

type NoopReason =
  "missing-context" | "unknown-event" | "unknown-provider" | "host-unreachable";

/**
 * `traycer agent activity-from-hook` - invoked by provider TUI lifecycle
 * hooks. It reports provider-native turn start/stop edges to the host.
 *
 * It also piggybacks the live provider session id (stamped on the hook's
 * stdin payload) as `observedHarnessSessionId` so the host can resync the
 * stored `harnessSessionId` when the live session drifts under the user
 * (Claude implicitly re-ids on Esc-Esc rewind, `/clear`, fork-after-`/btw`;
 * OpenCode re-ids when the user switches/forks sessions inside the TUI).
 * Stdin is read only where a resumable id is actually piped: every Claude
 * hook, and OpenCode's env-identified form (the per-TUI plugin instance omits
 * `--harness-session-id` for root sessions and pipes the id instead - its
 * session-id-keyed form never pipes a payload, and the host would refuse a
 * resync from it anyway). A missing/slow/garbage payload yields `null` and
 * never fails the hook.
 *
 * Like the title hook command, this is intentionally quiet: hooks can fire
 * outside Traycer-managed sessions, and their stdout may be surfaced back into
 * the provider TUI.
 */
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

    // Read stdin only where a resumable `session_id` is actually piped (see
    // the command doc); skipping elsewhere avoids blocking on a stream the
    // caller never writes to (Codex `notify`, OpenCode session-id-keyed form).
    const observedHarnessSessionId =
      parsedHarness.data === "claude" ||
      (parsedHarness.data === "opencode" && harnessSessionId === null)
        ? await readObservedHarnessSessionId()
        : null;

    const request = parseUserInput(recordTuiAgentActivityRequestSchemaV11, {
      epicId,
      tuiAgentId,
      harnessSessionId,
      harnessId: parsedHarness.data,
      event,
      observedHarnessSessionId,
    });
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
    if (rpcResult === "host-unreachable") {
      return noop("host-unreachable");
    }

    const { accepted } = parseHostResponse(
      recordTuiAgentActivityResponseSchema,
      rpcResult,
    );
    return {
      data: { accepted, reason: null },
      human: null,
      exitCode: 0,
    };
  };
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
