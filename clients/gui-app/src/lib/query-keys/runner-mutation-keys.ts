export const runnerMutationKeys = {
  requestHostRespawn: () => ["runner.requestHostRespawn"] as const,
  serviceInstall: () => ["runner.serviceInstall"] as const,
  serviceUninstall: () => ["runner.serviceUninstall"] as const,
  serviceStart: () => ["runner.serviceStart"] as const,
  serviceStop: () => ["runner.serviceStop"] as const,
  serviceRestart: () => ["runner.serviceRestart"] as const,
  serviceUpgrade: () => ["runner.serviceUpgrade"] as const,
  serviceEnableLinger: () => ["runner.serviceEnableLinger"] as const,
  traycerShellConfigSet: () => ["runner.traycer.shellConfigSet"] as const,
  traycerShellConfigReset: () => ["runner.traycer.shellConfigReset"] as const,
  traycerEnvOverrideSet: () => ["runner.traycer.envOverrideSet"] as const,
  traycerEnvOverrideDelete: () => ["runner.traycer.envOverrideDelete"] as const,
  traycerCliLogin: () => ["runner.traycer.cliLogin"] as const,
  // Host-management mutations consumed by Settings → Host and the
  // Doctor failure card.
  hostInstall: () => ["runner.host.install"] as const,
  hostEnsure: () => ["runner.host.ensure"] as const,
  hostUpdate: () => ["runner.host.update"] as const,
  hostRestart: () => ["runner.host.restart"] as const,
  hostRegisterService: () => ["runner.host.registerService"] as const,
  hostDeregisterService: () => ["runner.host.deregisterService"] as const,
  hostRunDoctor: () => ["runner.host.runDoctor"] as const,
  hostFreePortAndRestart: () => ["runner.host.freePortAndRestart"] as const,
  hostNameSet: () => ["runner.host.name.set"] as const,
  // In-app "Remove Traycer" (Settings → General → Danger Zone) and the
  // removed-surface "Reinstall" escape hatch.
  uninstallTraycer: () => ["runner.host.uninstallTraycer"] as const,
  reinstallTraycer: () => ["runner.host.reinstallTraycer"] as const,
  supportSubmitReport: () => ["runner.support.submitReport"] as const,
  // Reveal a log file in the OS file manager (Diagnostics → Logs).
  revealLog: () => ["runner.support.revealLog"] as const,
  // Force-refresh the registry update probe (bypasses the desktop's 24h
  // on-disk cache). Used by the Settings → Host Updates row's
  // "Check now" / "Retry" buttons so stale cached failures don't survive
  // a fix or a transient outage.
  hostRegistryCheck: () => ["runner.host.registryCheck"] as const,
  // "Clear local app state" wipe (Settings → General). Awaits the windows
  // bridge (IRunnerHost) per-window `clear` RPC, sweeps localStorage, then
  // reloads. Keyed so the destructive action dedups and shows in devtools.
  clearAllLocalData: () => ["runner.clearAllLocalData"] as const,
  mermaidPngDownload: () => ["runner.mermaidPngDownload"] as const,
  zoomSet: (scope: string | null) => ["runner.zoom.set", scope] as const,
  zoomStepIn: (scope: string | null) => ["runner.zoom.stepIn", scope] as const,
  zoomStepOut: (scope: string | null) =>
    ["runner.zoom.stepOut", scope] as const,
  zoomReset: (scope: string | null) => ["runner.zoom.reset", scope] as const,
  // Settings → log level (desktop/cli/host). Machine-local config, not
  // host-scoped, so a single static key suffices.
  logLevelsSet: () => ["runner.logLevels.set"] as const,
};

export const runnerQueryKeys = {
  serviceStatus: (service: object) =>
    ["runner.serviceStatus", service] as const,
  serviceLogTail: (service: object, maxLines: number) =>
    ["runner.serviceLogTail", service, maxLines] as const,
  // `traycerCli: object` keys these queries to a specific runner-host
  // instance so a host swap (test setups, hot reload) invalidates the
  // cache cleanly. Identity comparison only - the object is never
  // serialised.
  traycerHostStatus: (traycerCli: object) =>
    ["runner.traycer.hostStatus", traycerCli] as const,
  traycerShellConfig: (traycerCli: object) =>
    ["runner.traycer.shellConfig", traycerCli] as const,
  traycerShellList: (traycerCli: object) =>
    ["runner.traycer.shellList", traycerCli] as const,
  traycerEnvOverrideList: (traycerCli: object) =>
    ["runner.traycer.envOverrideList", traycerCli] as const,
  // Host-management queries are scoped by the `IHostManagement`
  // instance identity so a host swap invalidates them cleanly.
  hostAvailableVersionsScope: (management: object) =>
    ["runner.host.availableVersions", management] as const,
  hostAvailableVersions: (management: object, includePreReleases: boolean) =>
    [
      ...runnerQueryKeys.hostAvailableVersionsScope(management),
      includePreReleases,
    ] as const,
  hostRegistryUpdate: (management: object) =>
    ["runner.host.registryUpdate", management] as const,
  // Canonical cross-surface "is a host mutation running" status (Ticket:
  // host-update-race-conditions). Primed once via `getOperationStatus()` on
  // mount, then pushed by `HostOperationStatusListener` - never refetched by
  // TanStack's normal mechanisms, since it is entirely event-sourced.
  hostOperationStatus: (management: object) =>
    ["runner.host.operationStatus", management] as const,
  hostInstalledRecord: (management: object) =>
    ["runner.host.installedRecord", management] as const,
  hostLogs: (management: object, tailLines: number) =>
    ["runner.host.logs", management, tailLines] as const,
  hostDoctor: (management: object) =>
    ["runner.host.doctor", management] as const,
  hostCliManifest: (management: object) =>
    ["runner.host.cliManifest", management] as const,
  hostName: (management: object) => ["runner.host.name", management] as const,
  // Direct removal-sentinel read used by the host gate, independent of
  // `ensureHost`'s one-shot auto-provision result.
  hostRemovalState: (management: object) =>
    ["runner.host.removalState", management] as const,
  /**
   * Stable cache key for the placeholder ServiceStatusSnapshot used by
   * Settings → Host when the shell does not expose `IServiceHost`. The
   * matching query stays `enabled: false`; no fetch ever runs.
   */
  hostStatusNoService: () => ["runner.host.status-no-service"] as const,
  // The three configurable log thresholds, read together from the desktop
  // platform bridge. Machine-local, so not host-scoped.
  logLevels: () => ["runner.logLevels"] as const,
  zoomPercent: (scope: string | null) =>
    ["runner.zoom.percent", scope] as const,
  // Desktop support log viewer (Diagnostics → Logs). Scoped by the support
  // bridge object identity so a host/shell swap invalidates cleanly, matching
  // the other runner-host queries.
  supportLogList: (support: object | null) =>
    ["runner.support.logList", support] as const,
  supportLogTail: (support: object | null, target: string) =>
    ["runner.support.logTail", support, target] as const,
};
