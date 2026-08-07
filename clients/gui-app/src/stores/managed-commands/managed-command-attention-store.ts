import { create } from "zustand";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { managedCommandNeedsAttention } from "@/lib/managed-commands/managed-command-copy";

/**
 * Which command endings the human has already been shown. Opening a chat's
 * monitors menu IS the acknowledgement - the rows inside spell out every
 * outcome, so once the menu has been open there is nothing left for the badge
 * to tell anyone, and it goes quiet while the rows keep saying what happened.
 *
 * Acknowledgement is keyed to the ending, not the command: a command that is
 * restarted and fails again is new news. `updatedAtMs` is the host's marker for
 * "this record changed", so remembering the value seen at acknowledgement makes
 * the next transition re-arm the badge by itself.
 *
 * Client-side and deliberately not persisted: a restart of the app is a fresh
 * look at everything, and surviving one would mean silently swallowing an
 * overnight failure. Purely UI state, so Zustand rather than Query.
 */
interface ManagedCommandAttentionState {
  readonly acknowledgedUpdatedAtMsById: Readonly<Record<string, number>>;
  readonly acknowledge: (commands: readonly ManagedCommand[]) => void;
}

export const useManagedCommandAttentionStore =
  create<ManagedCommandAttentionState>()((set) => ({
    acknowledgedUpdatedAtMsById: {},
    // One map across every chat, so an acknowledgement MERGES: each chat's
    // menu only ever knows its own commands, and rebuilding the map from the
    // set in hand would re-arm every other chat's already-seen failures. An
    // entry for a deleted command matches nothing and is harmless.
    acknowledge: (commands) => {
      set((state) => ({
        acknowledgedUpdatedAtMsById: {
          ...state.acknowledgedUpdatedAtMsById,
          ...Object.fromEntries(
            commands
              .filter((command) => managedCommandNeedsAttention(command))
              .map((command) => [command.id, command.updatedAtMs]),
          ),
        },
      }));
    },
  }));

/** The commands whose ending is still news, in the order they were given. */
export function unacknowledgedAttentionCommands(
  commands: readonly ManagedCommand[],
  acknowledgedUpdatedAtMsById: Readonly<Record<string, number>>,
): readonly ManagedCommand[] {
  return commands.filter(
    (command) =>
      managedCommandNeedsAttention(command) &&
      acknowledgedUpdatedAtMsById[command.id] !== command.updatedAtMs,
  );
}
