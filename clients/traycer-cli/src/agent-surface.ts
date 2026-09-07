import { cliError, CLI_ERROR_CODES, type CliError } from "./runner/errors";

/** Agent-facing CLI slice. A rail, not an authorization boundary: the caller owns the env var. */
export type AgentCliSurface = "full" | "readonly";

/** Resolve the surface, failing CLOSED on anything unrecognised. Only an absent/empty variable and the exact string `full` open the full surface. */
export function resolveAgentCliSurface(
  env: Readonly<Record<string, string | undefined>>,
): AgentCliSurface {
  const declared = env.TRAYCER_AGENT_CLI_SURFACE;
  // Unset or empty is the ordinary case: a human's own terminal, and every
  // session the host chose not to restrict.
  if (declared === undefined || declared.length === 0) return "full";
  if (declared === "full") return "full";
  return "readonly";
}

/** Readonly-refused command paths, keyed by Commander path. Hiding a command is presentation only. */
export const READONLY_REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  "agent create":
    "this session can inspect agents but cannot create or change them.",
  "agent fork":
    "this session can inspect agents but cannot create or change them.",
  "agent configure":
    "this session can inspect agents but cannot change how they run.",
  "agent stop": "this session can inspect agents but cannot stop their work.",
  "agent archive":
    "this session can inspect agents but cannot change their archive state.",
  "agent send":
    "this session can inspect agents but cannot message them - report the message to the user instead.",
  "agent role claim": "this session can list role claims but cannot make one.",
  "agent role relinquish":
    "this session can list role claims but cannot release one.",
  "worktree delete":
    "remove worktrees from Settings ▸ Worktrees, or run this from a full-surface session.",
};

/** Inbox monitor is not in the readonly-refused table: it is observational and must keep running. */
export const MONITOR_SURFACE_NOTE =
  "traycer monitor is an explicit readonly-surface exception: refusing the delivery daemon would break inbox delivery rather than remove a capability";

/** The refusal every gated command shares. `FORBIDDEN` (not `INVALID_ARGUMENT`) so a caller can switch on the code: the invocation was well-formed, this session just may not perform it. */
export function readonlySurfaceRefusal(
  commandPath: string,
  hint: string,
): CliError {
  return cliError({
    code: CLI_ERROR_CODES.FORBIDDEN,
    message: `traycer: ${commandPath} is not available in the readonly agent surface - ${hint}`,
    details: null,
    exitCode: 1,
  });
}

/** The capability check itself. Throws before the gated command is even built, so ahead of every RPC, dial, and write that command would do. */
export function assertCommandAllowedOnSurface(
  commandPath: string,
  surface: AgentCliSurface,
): void {
  if (surface !== "readonly") return;
  if (!Object.hasOwn(READONLY_REFUSED_COMMANDS, commandPath)) return;
  throw readonlySurfaceRefusal(
    commandPath,
    READONLY_REFUSED_COMMANDS[commandPath],
  );
}
