import { cliError, CLI_ERROR_CODES, type CliError } from "./runner/errors";

/**
 * Which slice of the agent-facing CLI a session is allowed to drive.
 *
 * `readonly` is set by the host (`TRAYCER_AGENT_CLI_SURFACE=readonly`) for
 * sessions that may inspect Traycer state but must not change it. `full` is an
 * absent/empty variable - a human typing `traycer` in their own terminal, and
 * every session the host chose not to restrict - or the exact string `full`.
 * Anything else resolves to `readonly`; see `resolveAgentCliSurface`.
 *
 * WHAT THIS IS, AND IS NOT. The signal is an environment variable in the
 * session's own environment, so an agent holding that shell can unset or
 * overwrite it. This is therefore a client-side capability RAIL - it makes the
 * restricted surface behave as it is documented to behave, for a caller that
 * does not go out of its way - and NOT an authorization boundary against the
 * agent it restricts. Real authorization has to come from the host: a
 * host-side check, or a scoped credential the session cannot swap out. Until
 * that exists, do not let this file's presence be read as "mutations are
 * prevented"; it means "mutations are refused unless the caller tampers with
 * its own environment".
 *
 * Lives in this leaf module - not in `index.ts` - so the policy table below can
 * be imported by a command without pulling in the whole program builder (and
 * closing an import cycle).
 */
export type AgentCliSurface = "full" | "readonly";

/**
 * Resolve the surface, failing CLOSED on anything unrecognised.
 *
 * Only an absent/empty variable and the exact string `full` open the full
 * surface. Every other value - a host spelling drift, a casing difference, a
 * surface name a newer host knows and this CLI does not - resolves to
 * `readonly`.
 *
 * The alternative (unknown means `full`) is how the restriction silently
 * evaporates: one typo on the host side and a session the host believes is
 * restricted quietly regains every mutation, with nothing failing to signal
 * it. Failing closed instead costs a newer-host/older-CLI pairing some gated
 * commands, which is visible, recoverable, and refuses rather than acts.
 */
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

/**
 * Every command path the readonly surface REFUSES at runtime, keyed by the
 * space-joined path under `traycer` and mapped to the recovery sentence its
 * refusal ends with.
 *
 * This table is the capability check. Commander's `hidden` flag is not:
 * hiding a command only keeps it out of `--help`, and an agent that types the
 * subcommand anyway still reaches the action. Hiding is also a WIDER set than
 * this one - the readonly surface hides the whole agent-to-agent surface,
 * reads included (`agent inbox`, `agent selection-guide`, the harness/profile
 * catalogs), because none of it is useful to a session that cannot act. Those
 * reads stay runnable; only the mutations below are refused.
 *
 * Enforcement is centralised in `withRunner` (see `index.ts`), which looks up
 * the invoked command's path here on every runner-backed action. So adding a
 * mutating command to this table is the whole change - there is no second
 * per-command opt-in to forget.
 *
 * `traycer monitor` is deliberately absent; see `MONITOR_SURFACE_NOTE`.
 */
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

/**
 * Why the long-running inbox monitor is NOT in the table above, kept next to it
 * so the omission reads as a decision rather than an oversight.
 *
 * `traycer monitor` does mutate: it durably acknowledges the messages it prints
 * (`agent.inbox.ack` from the negotiated `@1.2`; on an older host the CLI has
 * no event id and the host retires the row itself), rotates and persists this
 * machine's stored credentials while it runs, and may provision a delegated
 * host credential. Those are disclosed in its description and in
 * `commands/monitor.ts`.
 *
 * It is an EXPLICIT EXCEPTION, not a command that happens to be out of reach.
 * It is normally the delivery daemon the Traycer plugin spawns for a session,
 * but it is also a registered command an agent can type, with its own
 * `--agent-id` - so leaving it ungated does leave a mutation reachable, and
 * the exception is granted with that understood. Two things decide it:
 *
 *  - Refusing it would break at-least-once delivery for any session the host
 *    DOES spawn a monitor for. Whether that happens is a host-side fact this
 *    repo cannot check, and the failure would be silent redelivery loops.
 *  - Refusing it would buy little even against a caller trying to get around
 *    the restriction, because this whole mechanism is an environment-variable
 *    rail (see `AgentCliSurface`): the same caller can clear the variable and
 *    run anything. The rail's job is to make the documented surface behave as
 *    documented, and monitor's documented behaviour is that it runs.
 *
 * Flipping this needs the host-side fact, and then one entry in the table
 * above.
 *
 * The same reasoning keeps the internal `agent *-from-hook` commands out of the
 * table: a provider hook firing on turn/session lifecycle is the harness
 * reporting what this session just did, not the agent asking for a change, and
 * refusing them would only desynchronise the host's record of a session it is
 * already running.
 *
 * Not in scope of that reasoning, and not gated today because the readonly
 * surface has never hidden them either: `comments set-status` and
 * `worktree create` are both agent-typed mutations that a readonly session can
 * still run. Whether the surface should cover them is a contract question for
 * the host, not something this table should decide unilaterally.
 */
export const MONITOR_SURFACE_NOTE =
  "traycer monitor is an explicit readonly-surface exception: refusing the delivery daemon would break inbox delivery rather than remove a capability";

/**
 * The refusal every gated command shares. `FORBIDDEN` (not `INVALID_ARGUMENT`)
 * so a caller can switch on the code: the invocation was well-formed, this
 * session just may not perform it.
 */
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

/**
 * The capability check itself. Throws before the gated command is even built,
 * so ahead of every RPC, dial, and write that command would do. It is NOT
 * ahead of the runner's own generic setup: `runCommand` has already resolved
 * the runtime and opened the CLI log by the time this runs, and the installed
 * entrypoint may have refreshed the well-known CLI slot before Commander
 * parsed anything. Nothing gated happens; some ordinary process bookkeeping
 * does.
 *
 * A no-op both on the full surface and for any command the table does not
 * list.
 */
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
