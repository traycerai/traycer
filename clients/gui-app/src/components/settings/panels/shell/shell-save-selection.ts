/**
 * The `shell` item a shell save leaves, as the app states it in the request
 * (`selection`, `config.shell.*@1.2`). Computed from the computer's own
 * `config.shell.get` read: the host computes the item from its config the
 * same way, so the two agree whenever that read is current, and the save is
 * then confirmed without a click. When they differ, the change waits in the
 * review list. Until that read has answered, a save that needs it states
 * nothing and the app expects no proposal.
 */
import { defaultShellArgs } from "@traycer/protocol/config/shell-family";
import type {
  ConfigShellEntry,
  ConfigShellGetResponseV11,
  ConfigShellSelection,
  ConfigShellSetRequestV10,
} from "@traycer/protocol/host/config/index";

const NOT_STATED: ConfigShellSelection = { kind: "not_stated" };

/** The arguments a shell starts with: those it remembers, else its default. */
function argsOf(path: string, entries: readonly ConfigShellEntry[]): string[] {
  const remembered = entries.find((entry) => entry.path === path)?.args;
  return [...(remembered ?? defaultShellArgs(path))];
}

/**
 * A switch to `path`, or new arguments for the current shell (`path: null`).
 * A switch that names no arguments takes the remembered ones. New arguments
 * while the computer follows the system default are saved on this computer
 * and propose nothing.
 */
export function shellSetSelection(
  request: ConfigShellSetRequestV10,
  config: ConfigShellGetResponseV11 | undefined,
): ConfigShellSelection {
  if (request.path !== null && request.args !== null) {
    return { kind: "shell", path: request.path, args: [...request.args] };
  }
  if (config === undefined) return NOT_STATED;
  if (request.path === null) {
    return config.synthesised
      ? NOT_STATED
      : { kind: "shell", path: config.path, args: [...request.args] };
  }
  return {
    kind: "shell",
    path: request.path,
    args: argsOf(request.path, config.entries),
  };
}

/** Add selects the shell it adds, with its default arguments. */
export function shellAddSelection(path: string): ConfigShellSelection {
  return { kind: "shell", path, args: [...defaultShellArgs(path)] };
}

/**
 * Removing the current shell leaves the system default. Removing any other
 * is saved on this computer and proposes nothing.
 */
export function shellRemoveSelection(
  path: string,
  config: ConfigShellGetResponseV11 | undefined,
): ConfigShellSelection {
  if (config === undefined) return NOT_STATED;
  return !config.synthesised && config.path === path
    ? { kind: "system_default" }
    : NOT_STATED;
}

/**
 * Reverting the current shell's arguments leaves its default. Reverting any
 * other's is saved on this computer and proposes nothing.
 */
export function shellRevertSelection(
  path: string,
  config: ConfigShellGetResponseV11 | undefined,
): ConfigShellSelection {
  if (config === undefined) return NOT_STATED;
  return !config.synthesised && config.path === path
    ? { kind: "shell", path, args: [...defaultShellArgs(path)] }
    : NOT_STATED;
}
