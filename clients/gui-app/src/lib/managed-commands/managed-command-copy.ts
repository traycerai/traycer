import type {
  ManagedCommand,
  ManagedCommandKind,
  ManagedCommandStatus,
} from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * Kind-explicit copy for the "Monitors & Shells" surface (`UI.md` §3, root
 * `CONTEXT.md`). Wherever the kind is known the UI names it - "Monitor ·
 * deploy watcher", "Shell completed" - and the word "Commands" never appears
 * as a UI term, because it collides with the command palette and with terminal
 * commands. The section header is the only surface that names both kinds.
 */

export function managedCommandKindLabel(kind: ManagedCommandKind): string {
  return kind === "monitor" ? "Monitor" : "Shell";
}

/** The list row / tab title: "Monitor · deploy watcher". */
export function managedCommandTitle(
  command: Pick<ManagedCommand, "kind" | "description">,
): string {
  return `${managedCommandKindLabel(command.kind)} · ${command.description}`;
}

/**
 * The queued chip's tooltip. Says monitor or shell rather than "background
 * command": "command" is the one word this surface never uses (it collides
 * with the command palette and with terminal commands), and a viewer who has
 * to ask "which background command?" is being told less than the host knows.
 * Only a host too old to report the kind gets the both-kinds wording.
 */
export function managedCommandQueuedChipTooltip(
  kind: ManagedCommandKind | null,
): string {
  const subject =
    kind === null
      ? "a monitor or shell"
      : `this ${managedCommandKindLabel(kind).toLowerCase()}`;
  return `Output from ${subject}, delivered to the agent when this runs. Click to watch it live.`;
}

/** The output window's own name: "Monitor output". */
export function managedCommandOutputWindowTitle(
  kind: ManagedCommandKind,
): string {
  return `${managedCommandKindLabel(kind)} output`;
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

/**
 * Whether this command's ending is news - the one thing that turns the chat's
 * badge from quiet to attention.
 *
 * A stop is something a human or an agent asked for, so it is never news no
 * matter how it reads afterwards. An exit is the command deciding on its own,
 * and what that means depends on the kind: a shell is supposed to finish, so
 * only a failure counts, while a monitor is supposed to still be watching, so
 * ANY exit is the thing you wanted to be told about - including a clean one,
 * which is a watcher that quietly stopped watching. `interrupted` is the host
 * dying underneath the command rather than the command doing anything, so it
 * stays quiet too.
 */
export function managedCommandNeedsAttention(
  command: Pick<ManagedCommand, "kind" | "status">,
): boolean {
  const status = command.status;
  if (status.state !== "exited") return false;
  if (command.kind === "monitor") return true;
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
