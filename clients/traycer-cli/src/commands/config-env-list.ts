import type { CommandFn, CommandResult } from "../runner/runner";
import { listEnvOverrides } from "../store/config-store";

// Runner-aware `traycer config env list` (host-process scope). JSON mode
// emits a single terminal `result` NDJSON event whose `data` is an array of
// `{ key, value }` entries. `value: null` means the variable is explicitly
// unset at launch/spawn time. Harness-scoped env now lives per-provider in the
// host's provider-overrides (Settings → Providers), not here.
export function buildConfigEnvListCommand(): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const entries = Object.entries(await listEnvOverrides())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value }));
    if (ctx.runtime.json) {
      return { data: entries, human: null, exitCode: 0 };
    }
    if (entries.length === 0) {
      return { data: entries, human: "(no env overrides)", exitCode: 0 };
    }
    return {
      data: entries,
      human: entries
        .map((entry) =>
          entry.value === null
            ? `${entry.key}=<unset>`
            : `${entry.key}=${entry.value}`,
        )
        .join("\n"),
      exitCode: 0,
    };
  };
}

export const configEnvListCommand: CommandFn = buildConfigEnvListCommand();
