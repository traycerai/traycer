import type { CommandFn, CommandResult } from "../runner/runner";
import { resetShell } from "../store/config-store";

// Runner-aware `traycer config shell reset`. Clears ONLY the current selection
// (returns to the system default / login shell); remembered shells and their
// per-shell flags are kept, so the login shell's own flags are inherited on the
// next read. JSON mode emits a single terminal `result` event; human mode prints
// a one-line confirmation. Resetting an already-default config is a no-op.
export const configShellResetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  await resetShell();
  return {
    data: { reset: true },
    human: ctx.runtime.json
      ? null
      : "shell selection reset to the system default; remembered shells kept",
    exitCode: 0,
  };
};
