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

// Identity fields shared by the `promptSubmitted` call and its `recordActivity`
// fallback - both carry the exact same payload (see the module doc).
interface HookActivityIdentity {
  readonly epicId: string | null;
  readonly tuiAgentId: string | null;
  readonly harnessSessionId: string | null;
  readonly harnessId: TuiHarnessId;
  readonly observedHarnessSessionId: string | null;
}

/**
 * `traycer agent activity-from-hook` - invoked by provider TUI lifecycle
 * hooks. It reports provider-native turn start/stop edges to the host.
 *
 * The `stop` edge still rides `agent.tui.recordActivity`. The `start` edge
 * (the `UserPromptSubmit` hook chain) is the roles-snapshot-delivery pull
 * point FOR ENVELOPE-CONSUMING PROVIDERS ONLY (Claude, and Codex via its
 * Claude-compatible hook runner): it calls `agent.tui.promptSubmitted@1.0`
 * instead, an optional unary method that does both jobs in one round trip -
 * it records the same activity edge `recordActivity` would have, then runs
 * the host's roles-digest-cursor check. A non-null `pendingPromptContext` in
 * the response is emitted on stdout as the `UserPromptSubmit`
 * `additionalContext` envelope (`{"hookSpecificOutput":{"hookEventName":
 * "UserPromptSubmit","additionalContext":"..."}}`), which the provider
 * appends to the outgoing prompt; `null` (nothing to deliver) means no
 * stdout at all.
 *
 * Every OTHER provider's `start` edge stays on plain `recordActivity`: the
 * response contract lets the host advance its roles cursor when it returns
 * pending context, so calling `promptSubmitted` from a hook whose stdout is
 * NOT injected into the prompt (OpenCode's in-process plugin consumes no
 * hook stdout) would acknowledge a snapshot the model never receives -
 * a silent permanent delivery loss, not a degrade.
 *
 * `promptSubmitted` is registered with `degrade: { kind: "unsupported" }`
 * (a brand-new method, not a new minor of `recordActivity`): against a host
 * that doesn't advertise it, the shared transport never sends the request -
 * it fails locally with `HostRpcError({ code: "E_HOST_UNSUPPORTED" })`,
 * which `toAgentCliError` maps to `CliError({ code:
 * CLI_ERROR_CODES.HOST_UNSUPPORTED })`. That specific code degrades silently
 * to a plain `recordActivity` `start` call carrying the identical payload -
 * today's semantics, unnoticed by the user. Every other error (a genuine
 * host `RPC_ERROR`, auth failure, etc.) still surfaces.
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
 * Like the title hook command, this is intentionally quiet on the `stop`
 * edge and on every benign miss: hooks can fire outside Traycer-managed
 * sessions, and their stdout may be surfaced back into the provider TUI.
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

    const identity: HookActivityIdentity = {
      epicId,
      tuiAgentId,
      harnessSessionId,
      harnessId: parsedHarness.data,
      observedHarnessSessionId,
    };

    // Only providers whose hook runner injects this command's stdout into
    // the outgoing prompt may take the promptSubmitted pull path - the host
    // advances its roles cursor when it hands back pending context, so a
    // provider that discards stdout (OpenCode's in-process plugin) would
    // silently strand the snapshot as "delivered". Those stay on the plain
    // activity edge.
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

  const { accepted, pendingPromptContext } = parseHostResponse(
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
  return parseHostResponse(recordTuiAgentActivityResponseSchema, rpcResult);
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
