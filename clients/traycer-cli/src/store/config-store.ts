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
export type {
  DiagnosticLogLevel,
  DiagnosticsEffectiveConfig,
  DiagnosticsPatch,
  DiagnosticsRawConfig,
  DiagnosticsStatus,
  DiagnosticsTemporaryScope,
  DiagnosticsWriteResult,
  HostDiagnosticLogLevel,
  TemporaryDiagnosticLogLevel,
  TemporaryHostDiagnosticLogLevel,
} from "@traycer/protocol/config/diagnostics-schema";
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
export {
  clearTemporaryDiagnosticsLogLevel,
  clearTemporaryDiagnosticsLogLevelScope,
  clearTemporaryDiagnosticsLogLevels,
  clearTemporaryHostDiagnosticsLogLevel,
  loadEffectiveDiagnosticsConfig,
  patchDiagnosticsConfig,
  readDiagnosticsRaw,
  resetDiagnosticsConfig,
  resolveDiagnosticsEffective,
  setDiagnosticsLogLevel,
  setHostDiagnosticsLogLevel,
  setTemporaryDiagnosticsLogLevel,
  setTemporaryHostDiagnosticsLogLevel,
} from "@traycer/protocol/config/diagnostics-store";
export {
  DIAGNOSTIC_LOG_LEVELS,
  EMPTY_DIAGNOSTICS_PATCH,
  HOST_DIAGNOSTIC_LOG_LEVELS,
  isDiagnosticLogLevel,
  isHostDiagnosticLogLevel,
  placeholderDiagnosticsStatus,
} from "@traycer/protocol/config/diagnostics-schema";
