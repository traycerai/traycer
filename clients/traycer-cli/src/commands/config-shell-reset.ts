import type { CommandFn, CommandResult } from "../runner/runner";
import { resetShell } from "../store/config-store";

// Runner-aware `traycer config shell reset`. JSON mode emits a single
// terminal `result` event; human mode prints a one-line confirmation.
// Resetting an already-default shell config is a successful no-op.
export const configShellResetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  await resetShell();
  return {
    data: { reset: true },
    human: ctx.runtime.json
      ? null
      : "shell config reset; defaults will be synthesised on next read",
    exitCode: 0,
  };
};
