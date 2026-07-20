/**
 * Desktop IPC re-exports of the shared Traycer CLI contract. Preload modules
 * import through this plain-data contract layer so Electron's CommonJS bridge
 * does not depend directly on the shared package.
 */
export type {
  TraycerDetectedShell,
  TraycerEnvOverride,
  TraycerHostStatusSnapshot,
  TraycerShellConfig,
  TraycerShellConfigSetInput,
  TraycerShellProbeResult,
} from "@traycer-clients/shared/platform/runner-host";
