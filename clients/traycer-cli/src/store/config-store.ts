// `~/.traycer/cli/config.json` is now owned by `@traycer/protocol/config`,
// the single source of truth shared by the CLI and the host (which reads
// the same file for terminal PTY spawns). This module re-exports that
// surface so the existing `traycer config …` command imports keep working
// unchanged.
export type {
  CliConfig,
  DetectedShell,
  EnvOverrideEntry,
  EnvOverrideValue,
  EffectiveShellConfig,
} from "@traycer/protocol/config/schema";
export {
  applyEnvOverrides,
  deleteEnvOverride,
  detectShells,
  getEnvOverride,
  listEnvOverrides,
  loadEffectiveShellConfig,
  readCliConfig,
  resetShell,
  setEnvOverride,
  setShell,
  writeCliConfig,
} from "@traycer/protocol/config/store";
