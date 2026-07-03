/**
 * IPC channel names shared between the Electron main process and the preload
 * bridge. Keeping them in one module avoids drift between `ipcMain.handle`
 * registrations and the `ipcRenderer.invoke` call sites in the preload.
 *
 * `invoke` channels are request/response (renderer -> main). `event` channels
 * are one-way pushes (main -> renderer via `webContents.send`). `sync`
 * channels are synchronous renderer -> main reads used at preload load for
 * values the renderer needs before constructing its `IRunnerHost`.
 */
export const RunnerHostInvoke = {
  validateAuthToken: "runnerHost:auth:validateToken",
  validateAuthTokenIdentity: "runnerHost:auth:validateTokenIdentity",
  // Device Authorization Grant (RFC 8628) - the only interactive login. `start`
  // runs `/device/authorize` + the `/device/token` poll loop in main (CORS-safe,
  // resilient to renderer sleep) and returns the authorization; the terminal
  // outcome is pushed on `deviceFlowResult`. The attempt is owned by the window
  // that started it: when that `webContents` is destroyed the attempt is
  // cancelled, so closing a window mid device-flow never leaks the poll loop.
  // `pollNow` nudges the named attempt's loop to poll immediately (the
  // browser-return deep link uses it). `cancel` aborts the named attempt's loop.
  deviceFlowStart: "runnerHost:auth:deviceFlowStart",
  deviceFlowPollNow: "runnerHost:auth:deviceFlowPollNow",
  deviceFlowCancel: "runnerHost:auth:deviceFlowCancel",
  refreshAuthToken: "runnerHost:auth:refreshToken",
  openExternalLink: "runnerHost:openExternalLink",
  getRegisteredUrlSchemes: "runnerHost:getRegisteredUrlSchemes",
  requestMicrophoneAccess: "runnerHost:requestMicrophoneAccess",
  openMicrophoneSettings: "runnerHost:openMicrophoneSettings",
  notificationShow: "runnerHost:notifications:show",
  traySetEpics: "runnerHost:tray:setEpics",
  traySetIndicator: "runnerHost:tray:setIndicator",
  hostPickerRequestOpen: "runnerHost:hostPicker:requestOpen",
  hostPickerRequestClose: "runnerHost:hostPicker:requestClose",
  workspaceFoldersPick: "runnerHost:workspaceFolders:pick",
  fileDropWriteTemporary: "runnerHost:fileDrops:writeTemporary",
  fileDropCopyTemporary: "runnerHost:fileDrops:copyTemporary",
  fileSave: "runnerHost:file:save",
  requestHostRespawn: "runnerHost:host:requestRespawn",
  setUnsyncedEditsSnapshot: "runnerHost:appLifecycle:setUnsyncedEditsSnapshot",
  // Renderer-initiated app quit (the removed surface's "Quit Traycer" button).
  // Routes through the normal `before-quit` flow (unsynced-edits guard etc.).
  appLifecycleQuit: "runnerHost:appLifecycle:quit",
  acknowledgeQuitRequest: "runnerHost:appLifecycle:acknowledgeQuitRequest",
  respondToQuitRequest: "runnerHost:appLifecycle:respondToQuitRequest",
  freshUnsyncedSnapshotResponse:
    "runnerHost:appLifecycle:freshUnsyncedSnapshotResponse",
  windowsList: "runnerHost:windows:list",
  windowsRequestNew: "runnerHost:windows:requestNew",
  windowsRequestFocus: "runnerHost:windows:requestFocus",
  windowsRequestClose: "runnerHost:windows:requestClose",
  windowsRequestOpenEpicInNewWindow:
    "runnerHost:windows:requestOpenEpicInNewWindow",
  ownershipSnapshot: "runnerHost:windows:ownership:snapshot",
  ownershipClaim: "runnerHost:windows:ownership:claim",
  ownershipRelease: "runnerHost:windows:ownership:release",
  perWindowStateGet: "runnerHost:windows:perWindowState:get",
  perWindowStateUpdate: "runnerHost:windows:perWindowState:update",
  perWindowStateClear: "runnerHost:windows:perWindowState:clear",
  authSessionGet: "runnerHost:windows:authSession:get",
  authSessionSet: "runnerHost:windows:authSession:set",
  supportSnapshotGet: "runnerHost:support:snapshot:get",
  supportRevealLog: "runnerHost:support:log:reveal",
  supportSubmitReport: "runnerHost:support:report:submit",
  supportTailLog: "runnerHost:support:log:tail",
  serviceStatus: "runnerHost:service:status",
  serviceInstall: "runnerHost:service:install",
  serviceUninstall: "runnerHost:service:uninstall",
  serviceStart: "runnerHost:service:start",
  serviceStop: "runnerHost:service:stop",
  serviceRestart: "runnerHost:service:restart",
  serviceUpgrade: "runnerHost:service:upgrade",
  serviceEnableLinger: "runnerHost:service:enableLinger",
  serviceGetLogTail: "runnerHost:service:getLogTail",
  migrationAnnounceRunning: "runnerHost:migration:announceRunning",
  migrationGetRunningSnapshot: "runnerHost:migration:getRunningSnapshot",
  // `traycer` CLI subprocess invocations. The renderer drives bootstrap-
  // config CRUD and host-status reads through these instead of hitting
  // SQLite or host RPC directly - single seam, host-down-tolerant.
  traycerHostStatus: "runnerHost:traycer:host:status",
  traycerConfigShellGet: "runnerHost:traycer:config:shell:get",
  traycerConfigShellSet: "runnerHost:traycer:config:shell:set",
  traycerConfigShellReset: "runnerHost:traycer:config:shell:reset",
  traycerConfigShellList: "runnerHost:traycer:config:shell:list",
  traycerConfigEnvList: "runnerHost:traycer:config:env:list",
  traycerConfigEnvSet: "runnerHost:traycer:config:env:set",
  traycerConfigEnvDelete: "runnerHost:traycer:config:env:delete",
  // Seeds the CLI's stored credentials from the captured bearer post sign-in
  // (`traycer login --token -`, token piped on stdin so it never lands in argv).
  traycerCliLogin: "runnerHost:traycer:cli:login",
  // Deletes the CLI's stored credentials at sign-out (`traycer logout`) so the
  // host's owner-binding gate falls back to deny-by-default on this machine.
  traycerCliLogout: "runnerHost:traycer:cli:logout",
  recentDocumentAdd: "runnerHost:recentDocuments:add",
  windowFlashFrame: "runnerHost:window:flashFrame",
  windowSetProgressBar: "runnerHost:window:setProgressBar",
  windowSetBadge: "runnerHost:app:setBadge",
  windowSetRepresentedFilename: "runnerHost:window:setRepresentedFilename",
  windowSetDocumentEdited: "runnerHost:window:setDocumentEdited",
  windowSetContentProtection: "runnerHost:window:setContentProtection",
  diagnosticsGetMetrics: "runnerHost:diagnostics:getMetrics",
  diagnosticsTakeHeapSnapshot: "runnerHost:diagnostics:takeHeapSnapshot",
  diagnosticsTraceStart: "runnerHost:diagnostics:trace:start",
  diagnosticsTraceStop: "runnerHost:diagnostics:trace:stop",
  appUpdateGetSnapshot: "runnerHost:appUpdate:getSnapshot",
  appUpdateCheck: "runnerHost:appUpdate:check",
  appUpdateDownload: "runnerHost:appUpdate:download",
  appUpdateInstall: "runnerHost:appUpdate:install",
  systemPreferencesAccentColor: "runnerHost:systemPreferences:accentColor",
  systemPreferencesAppearance: "runnerHost:systemPreferences:appearance",
  systemPreferencesAccessibilityTheme:
    "runnerHost:systemPreferences:accessibilityTheme",
  touchIdAvailable: "runnerHost:touchId:available",
  touchIdPrompt: "runnerHost:touchId:prompt",
  windowSetVibrancy: "runnerHost:window:setVibrancy",
  windowSetBackgroundMaterial: "runnerHost:window:setBackgroundMaterial",
  windowSetVisibleOnAllWorkspaces:
    "runnerHost:window:setVisibleOnAllWorkspaces",
  proxyAuthList: "runnerHost:proxyAuth:list",
  proxyAuthSave: "runnerHost:proxyAuth:save",
  proxyAuthClear: "runnerHost:proxyAuth:clear",
  proxySetConfig: "runnerHost:proxy:setConfig",
  proxyResolve: "runnerHost:proxy:resolve",
  certTrustList: "runnerHost:cert:list",
  certTrustAdd: "runnerHost:cert:trust",
  certTrustRemove: "runnerHost:cert:untrust",
  certTrustListPending: "runnerHost:cert:listPending",
  certTrustDismissPending: "runnerHost:cert:dismissPending",
  certTrustSystemDialog: "runnerHost:cert:systemDialog",
  windowSetOverlayIcon: "runnerHost:window:setOverlayIcon",
  displayList: "runnerHost:display:list",
  gpuAccelerationGet: "runnerHost:gpu:get",
  gpuAccelerationSet: "runnerHost:gpu:set",
  logLevelsGet: "runnerHost:logLevels:get",
  logLevelsSet: "runnerHost:logLevels:set",
  // Renderer-driven sleep prevention. The renderer recomputes
  // `preventSleepWhileRunning && anyLocalAgentActive` and pushes the boolean
  // here; main holds a single `powerSaveBlocker` while any window wants it.
  powerSetSleepBlocked: "runnerHost:power:setSleepBlocked",
  // Host management - Settings → Host, Doctor failure card, registry
  // update notice. Each handler invokes a `traycer host …` subcommand
  // (NDJSON) and projects the terminal `result.data` payload to the
  // renderer. Long-running invokes also fan out progress on
  // `cliOperationProgress` keyed by `operationId`.
  traycerHostInstall: "runnerHost:traycer:host:install",
  // Idempotent "ensure the host is installed + registered + running".
  // The renderer invokes this once after sign-in (post-auth provisioning);
  // it streams NDJSON progress on `cliOperationProgress` keyed by
  // `operationId` and resolves once the host is reachable.
  traycerHostEnsure: "runnerHost:traycer:host:ensure",
  traycerHostUpdate: "runnerHost:traycer:host:update",
  traycerHostUninstall: "runnerHost:traycer:host:uninstall",
  // In-app "Remove Traycer" (Settings → General → Danger Zone). Orchestrates
  // the full background-component teardown (sentinel + login item + `host
  // uninstall --all`); distinct from the host-only `traycerHostUninstall`.
  traycerAppUninstall: "runnerHost:traycer:app:uninstall",
  // Read / clear the persisted "removed by user" sentinel that gates
  // auto-provisioning after an in-app removal.
  traycerHostRemovalGet: "runnerHost:traycer:host:removal:get",
  traycerHostRemovalClear: "runnerHost:traycer:host:removal:clear",
  traycerHostRestart: "runnerHost:traycer:host:restart",
  traycerHostLogs: "runnerHost:traycer:host:logs",
  traycerHostDoctor: "runnerHost:traycer:host:doctor",
  traycerHostAvailable: "runnerHost:traycer:host:available",
  traycerHostInstalled: "runnerHost:traycer:host:installed",
  traycerServiceRegister: "runnerHost:traycer:service:register",
  traycerServiceDeregister: "runnerHost:traycer:service:deregister",
  traycerRegistryCheck: "runnerHost:traycer:registry:check",
  // Reads the current cross-surface host operation status (or null when
  // idle) once on mount, so a component that mounts mid-operation (e.g.
  // Settings opened after the banner already started an update) sees it
  // immediately instead of waiting for the next `hostOperationStatusChange`.
  traycerHostOperationStatusGet: "runnerHost:traycer:host:operationStatus:get",
  traycerFreePortAndRestart: "runnerHost:traycer:freePortAndRestart",
  traycerCliManifestRead: "runnerHost:traycer:cli:manifestRead",
  traycerHostNameGet: "runnerHost:traycer:host:name:get",
  traycerHostNameSet: "runnerHost:traycer:host:name:set",
  zoomGet: "runnerHost:zoom:get",
  zoomSet: "runnerHost:zoom:set",
  zoomStepIn: "runnerHost:zoom:stepIn",
  zoomStepOut: "runnerHost:zoom:stepOut",
  zoomReset: "runnerHost:zoom:reset",
} as const;

export const RunnerHostEvent = {
  authCallback: "runnerHost:event:authCallback",
  // Terminal outcome of a device-flow attempt, keyed by `attemptId` so a
  // superseded attempt's late result can't be mistaken for the live one.
  deviceFlowResult: "runnerHost:event:deviceFlowResult",
  localHostChange: "runnerHost:event:localHostChange",
  // OS wake pulse (powerMonitor `resume` / `unlock-screen`) bridged to the
  // renderer so it force-reconnects its host streams - re-registering the
  // live request context within seconds of wake instead of waiting out the
  // ~60s heartbeat. No payload: it is a pure "the machine just woke" signal.
  systemResumed: "runnerHost:event:systemResumed",
  notificationClick: "runnerHost:event:notificationClick",
  trayEpicSelected: "runnerHost:event:trayEpicSelected",
  hostPickerChange: "runnerHost:event:hostPickerChange",
  quitRequested: "runnerHost:event:quitRequested",
  getFreshUnsyncedSnapshot: "runnerHost:event:getFreshUnsyncedSnapshot",
  windowsChange: "runnerHost:event:windows:change",
  ownershipChange: "runnerHost:event:windows:ownership:change",
  perWindowStateChange: "runnerHost:event:windows:perWindowState:change",
  authSessionChange: "runnerHost:event:windows:authSession:change",
  menuCommand: "runnerHost:event:menu:command",
  migrationRunChange: "runnerHost:event:migration:runChange",
  accessibilityThemeChange: "runnerHost:event:accessibilityTheme:change",
  certificateErrorPending: "runnerHost:event:cert:errorPending",
  appUpdateChange: "runnerHost:event:appUpdate:change",
  displayTopologyChange: "runnerHost:event:display:topologyChange",
  // Progress events emitted by long-running host-management invokes
  // (install / update / register-service). The preload bridge filters by
  // `operationId` so concurrent operations don't cross-contaminate.
  cliOperationProgress: "runnerHost:event:cli:operationProgress",
  // Tray-driven host commands forwarded to the renderer's
  // `HostTrayCommandListener`. Payloads match the shared
  // `HostTrayCommand` union.
  hostTrayCommand: "runnerHost:event:host:trayCommand",
  // Main-process registry refreshes (launch probe, auto-update reconcile,
  // renderer forced checks) fan out here so already-mounted renderer update
  // surfaces can keep their TanStack Query cache in lockstep.
  hostRegistryUpdateStateChange:
    "runnerHost:event:host:registryUpdateStateChange",
  // Canonical cross-surface "is a host mutation running" broadcast (see
  // `HostOperationStatus`). Fired on start, every progress tick, and settle
  // (success/error) of any install/update/register-service/ensure
  // operation, whether triggered by a renderer surface or the background
  // auto-update reconciler, so every open window's banner/Settings stay in
  // lockstep without racing the CLI's cross-process lock file.
  hostOperationStatusChange: "runnerHost:event:host:operationStatusChange",
  zoomChange: "runnerHost:event:zoom:change",
} as const;

/**
 * Synchronous preload -> main reads. The preload calls
 * `ipcRenderer.sendSync` at module load to snapshot values the renderer
 * exposes as plain `readonly` strings on its `IRunnerHost`.
 */
export const RunnerHostSync = {
  authnBaseUrl: "runnerHost:sync:authnBaseUrl",
  authRedirectUri: "runnerHost:sync:authRedirectUri",
  windowId: "runnerHost:sync:windowId",
  sentryRendererDsn: "runnerHost:sync:sentryRendererDsn",
} as const;

export type RunnerHostInvokeChannel =
  (typeof RunnerHostInvoke)[keyof typeof RunnerHostInvoke];
export type RunnerHostEventChannel =
  (typeof RunnerHostEvent)[keyof typeof RunnerHostEvent];
export type RunnerHostSyncChannel =
  (typeof RunnerHostSync)[keyof typeof RunnerHostSync];
