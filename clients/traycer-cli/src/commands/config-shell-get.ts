import { loadEffectiveShellConfig } from "../store/config-store";
import type { CommandFn, CommandResult } from "../runner/runner";

// Runner-aware `traycer config shell get`. JSON mode emits a single
// terminal `result` envelope whose `data` carries the effective shell
// config (path, args, synthesised). Human mode prints a small two-line
// block (`path: …`, `args: […]`) with an optional `(default - not
// stored)` annotation when the config was synthesised from defaults
// rather than read from disk.
//
// Desktop's settings IPC consumes this through `runTraycerCliJson`
// since the migration to the shared runner.
export const configShellGetCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const cfg = await loadEffectiveShellConfig();
  const data = {
    path: cfg.path,
    args: cfg.args,
    synthesised: cfg.synthesised,
  };
  if (ctx.runtime.json) {
    return { data, human: null, exitCode: 0 };
  }
  const lines: string[] = [];
  lines.push(`path: ${cfg.path}`);
  lines.push(`args: ${JSON.stringify(cfg.args)}`);
  if (cfg.synthesised) {
    lines.push("(default - not stored)");
  }
  return { data, human: lines.join("\n"), exitCode: 0 };
};
