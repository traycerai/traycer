import {
  recordTuiAgentActivityRequestSchemaV12,
  recordTuiAgentActivityResponseSchema,
  TRAYCER_INBOX_MONITOR_DESCRIPTION,
  tuiAgentPromptSubmittedRequestSchemaV12,
  tuiAgentPromptSubmittedResponseSchema,
  type RecordTuiAgentActivityRequestV12,
  type RecordTuiAgentActivityResponse,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  tuiHarnessIdSchema,
  type TuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import { z } from "zod";
import {
  callHostRpcFastFail,
  isRequestVersionProjectionError,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import {
  readEpicId,
  readTerminalSpawnToken,
  readTuiAgentId,
} from "../internal/agent-context";
import { countClaudeScheduledTasks } from "../internal/claude-scheduled-tasks";
import {
  observedSessionIdFromPayload,
  readHookStdinPayload,
} from "../internal/hook-stdin";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

type ActivityHookEvent = "start" | "stop" | "idle" | "started";

type NoopReason =
  | "missing-context"
  | "unknown-event"
  | "unknown-provider"
  | "host-unreachable"
  | "host-too-old"
  | "not-idle-prompt"
  | "not-a-start";

// Identity fields shared by the `promptSubmitted` call and its `recordActivity`
// fallback - both carry the exact same payload (see the module doc).
interface HookActivityIdentity {
  readonly epicId: string | null;
  readonly tuiAgentId: string | null;
  readonly harnessSessionId: string | null;
  readonly harnessId: TuiHarnessId;
  readonly observedHarnessSessionId: string | null;
  readonly spawnToken: string | null;
}

// What one hook report adds to the identity: the turn it belongs to and, on a
// stop or a start-up report, how much work the provider says is still in
// flight (`null` = not reported, which the host reads as "keep the agent").
interface HookActivityReport {
  readonly turnId: string | null;
  readonly inFlight: { readonly count: number } | null;
}

const NO_REPORT: HookActivityReport = { turnId: null, inFlight: null };

/**
 * `traycer agent activity-from-hook` - invoked by provider TUI lifecycle
 * hooks. It reports provider-native turn start/stop edges to the host, and
 * the two reports the host's idle evidence is built from:
 *
 *   - `--event idle` (Claude's `Notification` hook): Claude's own report that
 *     it is waiting for input (`notification_type: "idle_prompt"`), sent as
 *     `recordActivity` `idle-confirmed` for the turn (`prompt_id`) it
 *     follows. Every other notification type exits quietly.
 *   - `--event started` (Claude's `SessionStart` hook, the OpenCode plugin's
 *     start-up): a process start report carrying how much work the new
 *     process already has scheduled - Claude's durable crons in
 *     `<cwd>/.claude/scheduled_tasks.json`, OpenCode's non-idle sessions. A
 *     Claude `SessionStart` that is not a `startup`, `resume` or `fork`
 *     (`/clear`, `compact`) is no new process and exits quietly.
 *
 * Every request carries the PTY's `TRAYCER_TERMINAL_SPAWN_TOKEN`, so the host
 * can tell this process's reports from a late one of a process it already
 * replaced, and the provider's turn id, so a stop is matched to the start it
 * ends. A Claude stop also counts what its payload lists as still in flight
 * (`background_tasks`, minus Traycer's own inbox monitor, plus
 * `session_crons`); a payload without either list reports nothing.
 *
 * The `stop` edge still rides `agent.tui.recordActivity`. The `start` edge
 * (the `UserPromptSubmit` hook chain) is the roles-snapshot-delivery pull
 * point FOR ENVELOPE-CONSUMING PROVIDERS ONLY (Claude, and Codex via its
 * Claude-compatible hook runner): it calls `agent.tui.promptSubmitted`
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
 * Version skew: against a host older than `recordActivity@1.2` the transport
 * strips the added fields from a start or a stop, and cannot represent the
 * `started` and `idle-confirmed` events at all; those two fail before they
 * are sent and exit quietly as `host-too-old`.
 *
 * It also piggybacks the live provider session id (stamped on the hook's
 * stdin payload) as `observedHarnessSessionId` so the host can resync the
 * stored `harnessSessionId` when the live session drifts under the user
 * (Claude implicitly re-ids on Esc-Esc rewind, `/clear`, fork-after-`/btw`;
 * OpenCode re-ids when the user switches/forks sessions inside the TUI).
 * Stdin is read only where a payload is actually piped: every Claude hook,
 * OpenCode's env-identified form (the per-TUI plugin instance omits
 * `--harness-session-id` for root sessions and pipes the id instead - its
 * session-id-keyed form never pipes a payload, and the host would refuse a
 * resync from it anyway), and Codex's `UserPromptSubmit` hook (for its
 * `turn_id`; Codex `notify` passes its payload as the trailing argv instead).
 * A missing/slow/garbage payload yields nothing and never fails the hook.
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
  readonly notifyPayload: string | null;
}): CommandFn {
  return async () => {
    const parsedHarness = tuiHarnessIdSchema.safeParse(opts.provider);
    if (!parsedHarness.success) return noop("unknown-provider");
    const harnessId = parsedHarness.data;
    const event = parseActivityHookEvent(opts.event);
    if (event === null || !providerReportsEvent(harnessId, event)) {
      return noop("unknown-event");
    }

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

    // Read stdin only where a payload is actually piped (see the command
    // doc); skipping elsewhere avoids blocking on a stream the caller never
    // writes to (Codex `notify`, OpenCode session-id-keyed form).
    const envIdentifiedOpenCode =
      harnessId === "opencode" && harnessSessionId === null;
    const payload =
      harnessId === "claude" ||
      envIdentifiedOpenCode ||
      (harnessId === "codex" && event === "start")
        ? await readHookStdinPayload()
        : null;

    const identity: HookActivityIdentity = {
      epicId,
      tuiAgentId,
      harnessSessionId,
      harnessId,
      observedHarnessSessionId:
        harnessId === "claude" || envIdentifiedOpenCode
          ? observedSessionIdFromPayload(payload)
          : null,
      spawnToken: readTerminalSpawnToken(),
    };

    if (event === "idle") {
      // Claude's Notification hook runs for every notification type; only
      // its idle report is evidence.
      const notification = claudeNotificationSchema.safeParse(payload);
      if (
        !notification.success ||
        notification.data.notification_type !== "idle_prompt"
      ) {
        return noop("not-idle-prompt");
      }
      return reportOutcome(
        await callRecordActivity(identity, "idle-confirmed", {
          turnId: claudeTurnId(payload),
          inFlight: null,
        }),
      );
    }

    if (event === "started") {
      const report = await processStartReport(harnessId, payload);
      if (report === "not-a-start") return noop("not-a-start");
      return reportOutcome(
        await callRecordActivity(identity, "started", report),
      );
    }

    const report = turnReport(harnessId, event, payload, opts.notifyPayload);

    // Only providers whose hook runner injects this command's stdout into
    // the outgoing prompt may take the promptSubmitted pull path - the host
    // advances its roles cursor when it hands back pending context, so a
    // provider that discards stdout (OpenCode's in-process plugin) would
    // silently strand the snapshot as "delivered". Those stay on the plain
    // activity edge.
    const consumesPromptEnvelope =
      identity.harnessId === "claude" || identity.harnessId === "codex";

    if (event === "stop" || !consumesPromptEnvelope) {
      return reportOutcome(await callRecordActivity(identity, event, report));
    }

    return submitPrompt(identity, report);
  };
}

async function submitPrompt(
  identity: HookActivityIdentity,
  report: HookActivityReport,
) {
  const request = parseUserInput(tuiAgentPromptSubmittedRequestSchemaV12, {
    epicId: identity.epicId,
    tuiAgentId: identity.tuiAgentId,
    harnessSessionId: identity.harnessSessionId,
    harnessId: identity.harnessId,
    observedHarnessSessionId: identity.observedHarnessSessionId,
    spawnToken: identity.spawnToken,
    turnId: report.turnId,
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
    return reportOutcome(
      await callRecordActivity(identity, "start", {
        turnId: report.turnId,
        inFlight: null,
      }),
    );
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
  event: RecordTuiAgentActivityRequestV12["event"],
  report: HookActivityReport,
): Promise<
  RecordTuiAgentActivityResponse | "host-unreachable" | "host-too-old"
> {
  const requestInput: RecordTuiAgentActivityRequestV12 = {
    epicId: identity.epicId,
    tuiAgentId: identity.tuiAgentId,
    harnessSessionId: identity.harnessSessionId,
    harnessId: identity.harnessId,
    event,
    observedHarnessSessionId: identity.observedHarnessSessionId,
    spawnToken: identity.spawnToken,
    turnId: report.turnId,
    inFlight: report.inFlight,
  };
  const request = parseUserInput(
    recordTuiAgentActivityRequestSchemaV12,
    requestInput,
  );
  // An event a pre-1.2 host cannot represent (`started`, `idle-confirmed`)
  // fails projection locally, before it is sent: meaningless to that host,
  // so a quiet no-op rather than hook noise. Caught on the raw transport
  // error, before `toAgentCliError` buckets it as UNEXPECTED.
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
  if (rpcResult === "host-unreachable" || rpcResult === "host-too-old") {
    return rpcResult;
  }
  return parseCanonicalHostResponse(
    "agent.tui.recordActivity",
    recordTuiAgentActivityResponseSchema,
    rpcResult,
  );
}

function reportOutcome(
  result: RecordTuiAgentActivityResponse | "host-unreachable" | "host-too-old",
) {
  if (result === "host-unreachable") return noop("host-unreachable");
  if (result === "host-too-old") return noop("host-too-old");
  return {
    data: { accepted: result.accepted, reason: null },
    human: null,
    exitCode: 0,
  };
}

const claudeNotificationSchema = z.looseObject({
  notification_type: z.string(),
});

const CLAUDE_PROCESS_START_SOURCES: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "fork",
]);

const claudeSessionStartSchema = z.looseObject({
  source: z.string(),
  cwd: z.string().optional(),
});

const claudeStopListsSchema = z.looseObject({
  background_tasks: z.array(z.unknown()),
  session_crons: z.array(z.unknown()),
});

// Traycer's own plugin monitor (`monitors.json` in the host's Claude plugin)
// is listed in every Stop for the session's life. It is a helper, not work,
// so it never counts: matched by its description and its `… monitor`
// command, since `${TRAYCER_CLI}` expands to a path that varies per host.
const traycerInboxMonitorEntrySchema = z.looseObject({
  description: z.literal(TRAYCER_INBOX_MONITOR_DESCRIPTION),
  command: z.string().refine((command) => command.endsWith(" monitor")),
});

const claudePromptIdSchema = z.looseObject({
  prompt_id: z.string().trim().min(1),
});

const turnIdPayloadSchema = z.looseObject({
  turn_id: z.string().trim().min(1),
});

const openCodeInFlightSchema = z.looseObject({
  in_flight: z.object({ count: z.number().int().nonnegative() }),
});

const codexNotifySchema = z.looseObject({
  "turn-id": z.string().trim().min(1),
});

function providerReportsEvent(
  harnessId: TuiHarnessId,
  event: ActivityHookEvent,
): boolean {
  if (event === "idle") return harnessId === "claude";
  if (event === "started") {
    return harnessId === "claude" || harnessId === "opencode";
  }
  return true;
}

function turnReport(
  harnessId: TuiHarnessId,
  event: "start" | "stop",
  payload: unknown,
  notifyPayload: string | null,
): HookActivityReport {
  switch (harnessId) {
    case "claude":
      return {
        turnId: claudeTurnId(payload),
        inFlight: event === "stop" ? claudeInFlight(payload) : null,
      };
    case "opencode":
      return {
        turnId: payloadTurnId(payload),
        inFlight: event === "stop" ? openCodeInFlight(payload) : null,
      };
    case "codex":
      return {
        turnId:
          event === "start"
            ? payloadTurnId(payload)
            : codexNotifyTurnId(notifyPayload),
        inFlight: null,
      };
    case "cursor":
      return NO_REPORT;
  }
}

async function processStartReport(
  harnessId: TuiHarnessId,
  payload: unknown,
): Promise<HookActivityReport | "not-a-start"> {
  if (harnessId === "opencode") {
    return { turnId: null, inFlight: openCodeInFlight(payload) };
  }
  // `SessionStart` also fires for `/clear` and `compact`, which start no new
  // process: only a `startup`, a `resume` or a `fork` (`--fork-session`, how
  // a terminal agent is forked) is a process start.
  const sessionStart = claudeSessionStartSchema.safeParse(payload);
  if (
    !sessionStart.success ||
    !CLAUDE_PROCESS_START_SOURCES.has(sessionStart.data.source)
  ) {
    return "not-a-start";
  }
  const count = await countClaudeScheduledTasks(
    sessionStart.data.cwd ?? process.cwd(),
  );
  return { turnId: null, inFlight: count === null ? null : { count } };
}

function claudeTurnId(payload: unknown): string | null {
  const parsed = claudePromptIdSchema.safeParse(payload);
  return parsed.success ? parsed.data.prompt_id : null;
}

function payloadTurnId(payload: unknown): string | null {
  const parsed = turnIdPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.turn_id : null;
}

function claudeInFlight(payload: unknown): { readonly count: number } | null {
  const parsed = claudeStopListsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const tasks = parsed.data.background_tasks.filter(
    (entry) => !traycerInboxMonitorEntrySchema.safeParse(entry).success,
  );
  return { count: tasks.length + parsed.data.session_crons.length };
}

function openCodeInFlight(payload: unknown): { readonly count: number } | null {
  const parsed = openCodeInFlightSchema.safeParse(payload);
  return parsed.success ? { count: parsed.data.in_flight.count } : null;
}

function codexNotifyTurnId(notifyPayload: string | null): string | null {
  if (notifyPayload === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(notifyPayload);
  } catch {
    return null;
  }
  const parsed = codexNotifySchema.safeParse(raw);
  return parsed.success ? parsed.data["turn-id"] : null;
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
  if (
    value === "start" ||
    value === "stop" ||
    value === "idle" ||
    value === "started"
  ) {
    return value;
  }
  return null;
}

function noop(reason: NoopReason) {
  return {
    data: { accepted: false, reason },
    human: null,
    exitCode: 0,
  };
}
