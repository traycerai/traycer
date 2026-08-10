import { create } from "zustand";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { managedCommandNeedsAttention } from "@/lib/managed-commands/managed-command-copy";

/**
 * Which shell endings the human has already been shown. Opening a chat's
 * Shells menu IS the acknowledgement - the rows inside spell out every
 * outcome, so once the menu has been open there is nothing left for the badge
 * to tell anyone, and it goes quiet while the rows keep saying what happened.
 *
 * Acknowledgement is keyed to the ENDING, not the record: a shell that is
 * restarted and fails again is new news, but a record that merely changes
 * around a failure the human already read - the agent muting a dead shell's
 * notifications, a description edit - is not. `updatedAtMs` moves on every
 * such change, so it cannot be the key; the exit moment and outcome only move
 * when something genuinely ends again.
 *
 * Client-side and deliberately not persisted: a restart of the app is a fresh
 * look at everything, and surviving one would mean silently swallowing an
 * overnight failure. Purely UI state, so Zustand rather than Query.
 */
interface ManagedCommandAttentionState {
  readonly acknowledgedEndingById: Readonly<Record<string, string>>;
  readonly acknowledge: (commands: readonly ManagedCommand[]) => void;
}

/**
 * The identity of one ending. Exit moment plus outcome: two failures of the
 * same shell cannot share it, while any record churn AFTER a failure keeps it.
 */
function endingKey(command: ManagedCommand): string {
  const status = command.status;
  if (status.state !== "exited") return "";
  return `${status.exitedAtMs}:${status.exitCode ?? ""}:${status.signal ?? ""}`;
}

export const useManagedCommandAttentionStore =
  create<ManagedCommandAttentionState>()((set) => ({
    acknowledgedEndingById: {},
    // One map across every chat, so an acknowledgement MERGES: each chat's
    // menu only ever knows its own commands, and rebuilding the map from the
    // set in hand would re-arm every other chat's already-seen failures. An
    // entry for a deleted command matches nothing and is harmless.
    acknowledge: (commands) => {
      set((state) => ({
        acknowledgedEndingById: {
          ...state.acknowledgedEndingById,
          ...Object.fromEntries(
            commands
              .filter((command) => managedCommandNeedsAttention(command))
              .map((command) => [command.id, endingKey(command)]),
          ),
        },
      }));
    },
  }));

/** The commands whose ending is still news, in the order they were given. */
export function unacknowledgedAttentionCommands(
  commands: readonly ManagedCommand[],
  acknowledgedEndingById: Readonly<Record<string, string>>,
): readonly ManagedCommand[] {
  return commands.filter(
    (command) =>
      managedCommandNeedsAttention(command) &&
      acknowledgedEndingById[command.id] !== endingKey(command),
  );
}
