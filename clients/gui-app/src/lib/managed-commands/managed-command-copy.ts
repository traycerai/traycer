import type {
  ManagedCommand,
  ManagedCommandStatus,
} from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * Copy for the Shells surface (root `CONTEXT.md`). There is ONE entity here -
 * a shell - but what the UI CALLS one follows its monitor state: a shell that
 * is watching is a "Monitor", a shell that is not is a "Shell". Product
 * decision, 2026-08-09; it supersedes the earlier rule that the noun stays
 * "Shell" whatever the flag says.
 *
 * The flag is live-tunable, so the noun changes under a row that stays put.
 * That is the point rather than a cost: the name is the loudest place to tell
 * the "this stopped being a watcher" story, and it is the one state that
 * separates two otherwise identical shells.
 *
 * "Shells" stays the umbrella, because a monitor IS a shell: the container -
 * the chat's menu, its chip, the deleted-shell copy - keeps that name.
 * "Commands" stays banned as a UI term, because it collides with the command
 * palette and with terminal commands.
 */

/**
 * The entity in general, for copy that names no particular shell and so has no
 * flag to follow: the resource monitor's owner-kind column, the output
 * window's own name, empty states. A title with a command in hand uses
 * `managedCommandNoun` instead.
 */
export const MANAGED_COMMAND_NOUN = "Shell";

/** What to call ONE shell, given whether it is watching. */
export function managedCommandNoun(monitoring: boolean): string {
  return monitoring ? "Monitor" : MANAGED_COMMAND_NOUN;
}

/**
 * The list row / tab title: "Monitor · deploy watcher", "Shell · db migration".
 *
 * A shell with no description is the noun alone rather than a dangling
 * "Shell · ": the separator promises a name after it. Whitespace counts as no
 * description - an agent that passed " " meant nothing by it, and a title
 * ending in a separator and a space is the same broken promise. The guard
 * lives here so every surface inherits it - it used to be a
 * resource-monitor-only rule, which is exactly how a second spelling of the
 * same title gets written.
 */
export function managedCommandTitle(
  command: Pick<ManagedCommand, "description" | "monitoring">,
): string {
  const noun = managedCommandNoun(command.monitoring);
  const description = command.description.trim();
  return description.length === 0 ? noun : `${noun} · ${description}`;
}

/**
 * The queued chip's tooltip. Says shell rather than "background command":
 * "command" is the one word this surface never uses, and a viewer who has to
 * ask "which background command?" is being told less than the host knows.
 */
export const MANAGED_COMMAND_QUEUED_CHIP_TOOLTIP =
  "Output from this shell, delivered to the agent when this runs. Click to watch it live.";

/** The output window's own name. */
export const MANAGED_COMMAND_OUTPUT_WINDOW_TITLE = "Shell output";

/**
 * The restart card's header verb, in the shell's own noun: "Restarted Monitor ·
 * deploy watcher". Same guard as `managedCommandTitle` for a shell with no
 * description, and for the same reason.
 */
export function managedCommandRestartTitle(
  command: Pick<ManagedCommand, "description" | "monitoring">,
): string {
  return `Restarted ${managedCommandTitle(command)}`;
}

/**
 * What a restart changed, as the compact phrase beside its title. Judged
 * against the spec the shell ran under before the call, never against which
 * inputs the caller passed - a restart naming the command already stored is
 * "same command and cwd", because it is.
 */
export function managedCommandRestartDeltaPhrase(delta: {
  readonly commandChanged: boolean;
  readonly cwdChanged: boolean;
}): string {
  if (delta.commandChanged && delta.cwdChanged) {
    return "command and cwd changed";
  }
  if (delta.commandChanged) return "command changed";
  if (delta.cwdChanged) return "cwd changed";
  return "same command and cwd";
}

/**
 * The frozen outcome a restart card shows when the relaunch did NOT come up.
 * A spawn failure is `exited` with neither code nor signal - "Exited" would
 * read as though something ran; it did not. Anything else keeps the shared
 * status vocabulary. (A `running` outcome is not shown at all: it is the
 * normal case, and frozen it reads as a live claim.)
 */
export function managedCommandRestartOutcomeLabel(
  outcome: ManagedCommandStatus,
): string {
  if (
    outcome.state === "exited" &&
    outcome.exitCode === null &&
    outcome.signal === null
  ) {
    return "Failed to start";
  }
  return managedCommandStatusLabel(outcome);
}

export function managedCommandStatusLabel(
  status: ManagedCommandStatus,
): string {
  switch (status.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "exited": {
      if (status.signal !== null) return `Exited · ${status.signal}`;
      if (status.exitCode !== null) return `Exited · code ${status.exitCode}`;
      return "Exited";
    }
    case "interrupted":
      return "Interrupted";
  }
}

export type ManagedCommandStatusTone = "running" | "failed" | "idle";

/**
 * How a status dot reads at a glance. A non-zero exit or a signal death is the
 * one thing worth colouring for - everything else is either live or simply
 * over. An interrupted command (the host died under it) is not a failure of
 * the command itself, so it stays neutral.
 */
export function managedCommandStatusTone(
  status: ManagedCommandStatus,
): ManagedCommandStatusTone {
  if (status.state === "running") return "running";
  if (status.state !== "exited") return "idle";
  if (status.signal !== null) return "failed";
  return status.exitCode === 0 ? "idle" : "failed";
}
