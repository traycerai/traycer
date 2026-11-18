import { listShells } from "../store/config-store";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer config shell list`. JSON mode emits a single
// terminal `result` envelope whose `data` is the merged picker list -
// detected shells unioned with the user's `shell.entries` paths
// (`{ name, path, isDefault, source, missing }`, OS default first). Human mode
// prints one `name<TAB>path` line per shell, marking the OS default with `*` and
// a customised-but-uninstalled (`missing`) shell with a trailing `(not found)`.
//
// Best-effort by design: an empty list is a valid result (an unreadable
// `/etc/shells` or a machine with nothing on the probe paths), and the
// Settings → Shell picker still accepts an arbitrary added path.
export const configShellListCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const shells = await listShells();
  const data = shells.map((shell) => ({
    name: shell.name,
    path: shell.path,
    isDefault: shell.isDefault,
    source: shell.source,
    missing: shell.missing,
    // Only ever set on Windows wsl.exe rows; omitted (not null) when healthy
    // so the JSON envelope is unchanged for every other shell.
    ...(shell.wslHealth !== undefined ? { wslHealth: shell.wslHealth } : {}),
  }));
  if (ctx.runtime.json) {
    return { data, human: null, exitCode: 0 };
  }
  if (data.length === 0) {
    return { data, human: "(no shells detected)", exitCode: 0 };
  }
  return {
    data,
    human: data
      .map(
        (shell) =>
          `${shell.isDefault ? "*" : " "} ${shell.name}\t${shell.path}${
            shell.missing ? "\t(not found)" : ""
          }${
            shell.wslHealth === "not-installed"
              ? "\t(WSL not installed)"
              : shell.wslHealth === "no-distro"
                ? "\t(no Linux distribution)"
                : ""
          }`,
      )
      .join("\n"),
    exitCode: 0,
  };
};
