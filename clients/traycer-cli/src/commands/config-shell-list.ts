import { detectShells } from "../store/config-store";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer config shell list`. JSON mode emits a single
// terminal `result` envelope whose `data` is an array of detected shells
// (`{ name, path, isDefault }`, OS default first). Human mode prints one
// `name<TAB>path` line per shell, marking the OS default with `*`.
//
// Best-effort by design: an empty list is a valid result (an unreadable
// `/etc/shells` or a machine with nothing on the probe paths), and the
// Settings → Shell combobox still accepts an arbitrary typed path.
export const configShellListCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const shells = await detectShells();
  const data = shells.map((shell) => ({
    name: shell.name,
    path: shell.path,
    isDefault: shell.isDefault,
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
          `${shell.isDefault ? "*" : " "} ${shell.name}\t${shell.path}`,
      )
      .join("\n"),
    exitCode: 0,
  };
};
