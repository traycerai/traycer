import type {
  ManagedCommand,
  ManagedCommandStatus,
} from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * Copy for the Shells surface (root `CONTEXT.md`). There is ONE entity here -
 * a shell - and "monitor" is prose for a shell with notifications on, never a
 * second noun the UI names. "Commands" stays banned as a UI term, because it
 * collides with the command palette and with terminal commands.
 */

/** The entity noun, wherever a bare label is what fits (pill, banner). */
export const MANAGED_COMMAND_NOUN = "Shell";

/** The list row / tab title: "Shell · deploy watcher". */
export function managedCommandTitle(
  command: Pick<ManagedCommand, "description">,
): string {
  return `${MANAGED_COMMAND_NOUN} · ${command.description}`;
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

/**
 * Whether this shell's ending is news - the one thing that turns the chat's
 * badge from quiet to attention.
 *
 * A failure and nothing else, whether or not the shell was notifying. A stop is
 * something a human or an agent asked for, so it is never news no matter how it
 * reads afterwards; a clean exit is a shell doing what it was made to do, and a
 * watcher that means to keep running says so through its own output rather than
 * through a badge on the chat. `interrupted` is the host dying underneath the
 * shell rather than the shell doing anything, so it stays quiet too.
 */
export function managedCommandNeedsAttention(
  command: Pick<ManagedCommand, "status">,
): boolean {
  const status = command.status;
  if (status.state !== "exited") return false;
  if (status.signal !== null) return true;
  return status.exitCode !== 0;
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
