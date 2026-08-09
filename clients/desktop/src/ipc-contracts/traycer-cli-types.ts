/**
 * Desktop IPC re-exports of the shared Traycer CLI contract. Preload modules
 * import through this plain-data contract layer so Electron's CommonJS bridge
 * does not depend directly on the shared package.
 */
export type {
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerHostStatusSnapshot,
  TraycerModelEntry,
  TraycerModelGroup,
  TraycerModelTier,
  TraycerOrchestration,
  TraycerOrchestrationPrelude,
  TraycerOrchestrationRole,
  TraycerArtifactStep,
  TraycerRoleModelInfo,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
  TraycerShellProbeResult,
} from "@traycer-clients/shared/platform/runner-host";
