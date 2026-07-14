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
  ShellEntry,
} from "@traycer/protocol/config/schema";
export {
  addShell,
  applyEnvOverrides,
  deleteEnvOverride,
  detectShells,
  getEnvOverride,
  listEnvOverrides,
  listShells,
  loadEffectiveShellConfig,
  probeShellPath,
  readCliConfig,
  removeShell,
  resetShell,
  revertShellArgs,
  setEnvOverride,
  setShell,
  writeCliConfig,
} from "@traycer/protocol/config/store";
