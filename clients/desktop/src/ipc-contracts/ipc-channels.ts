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
import type {
  SelectionAuthorityEventMap,
  SelectionAuthorityInvokeMap,
  SelectionAuthoritySyncMap,
} from "./selection-authority-ipc";

export const RunnerHostInvoke = {
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
  // Credentials-file token store (tech plan §3). `get`/`signIn`/`rotate`/`delete`
  // route the renderer's `ITokenStore` through the main-process `FileTokenStore`,
  // which owns the single machine-local credentials file + its lock/WAL. `rotate`
  // performs the refresh HTTP spend in main, inside the file lock.
  authTokenStoreGet: "runnerHost:auth:tokenStore:get",
  authTokenStoreSignIn: "runnerHost:auth:tokenStore:signIn",
  authTokenStoreRotate: "runnerHost:auth:tokenStore:rotate",
  authTokenStoreDelete: "runnerHost:auth:tokenStore:delete",
  authTokenStoreDeleteIfToken: "runnerHost:auth:tokenStore:deleteIfToken",
  authTokenStoreMigrateLegacy: "runnerHost:auth:tokenStore:migrateLegacy",
  // Remote Host Support (§7): `GET /api/v3/hosts` with the user bearer. Run in
  // main for the same CORS reason as the token validators — authn-v3's CORS
  // allow-list is the web dashboard origin, not the app renderer.
  listRegisteredHosts: "runnerHost:hosts:list",
  // Devices & Sessions account-security surface. These authn-v3 calls run in
  // main for the same renderer-origin CORS reason as token validation.
  listUserSessions: "runnerHost:auth:sessions:list",
  revokeUserSession: "runnerHost:auth:sessions:revoke",
  revokeAllSessions: "runnerHost:auth:sessions:revokeAll",
  // Delegated host-credential mint. Same main-process placement as the revoke
  // calls, with the added reason that the retained step-up bearer must never
  // reach the renderer.
  mintHostCredential: "runnerHost:auth:hosts:mintCredential",
  // Cross-window arbitration for the mint above. Each BrowserWindow is its own
  // module realm, so the renderer's "one prompt per host" memo does not span
  // them; main holds the single registry every window claims against.
  requestStepUpChallenge: "runnerHost:auth:stepUp:challenge",
  verifyStepUpChallenge: "runnerHost:auth:stepUp:verify",
  // Remote Host Support (§13, T16): `PATCH /api/v3/hosts/:hostId` — "Update
  // now" / auto-policy toggle / "Apply now — ends N sessions". Same CORS
  // reason as `listRegisteredHosts`.
  updateHostVersionPolicy: "runnerHost:hosts:updateVersionPolicy",
  // "Remove from account": `POST /api/v3/hosts/:hostId/deregister`. Same CORS
  // reason as the two above — and, like them, a registry-only write that needs
  // no route to the machine, which is why it does not live on the host-
  // management bridge next to the OS-service verbs it must not be confused with.
  deregisterHostFromAccount: "runnerHost:hosts:deregisterFromAccount",
  openExternalLink: "runnerHost:openExternalLink",
  getRegisteredUrlSchemes: "runnerHost:getRegisteredUrlSchemes",
  requestMicrophoneAccess: "runnerHost:requestMicrophoneAccess",
  openMicrophoneSettings: "runnerHost:openMicrophoneSettings",
  notificationShow: "runnerHost:notifications:show",
  traySetEpics: "runnerHost:tray:setEpics",
  traySetIndicator: "runnerHost:tray:setIndicator",
  workspaceFoldersPick: "runnerHost:workspaceFolders:pick",
  fileDropWriteTemporary: "runnerHost:fileDrops:writeTemporary",
  fileDropCopyTemporary: "runnerHost:fileDrops:copyTemporary",
  fileDropReadNativeClipboardPaths:
    "runnerHost:fileDrops:readNativeClipboardPaths",
  fileSave: "runnerHost:file:save",
  // Opens a file `fileSave` wrote earlier in this process lifetime with the
  // OS default app (the "Open file" action on the saved toast). Main keeps
  // the allowlist of paths it saved, so the renderer can only ever open what
  // the user just chose in the native save dialog - never an arbitrary path.
  fileOpenSaved: "runnerHost:file:openSaved",
  clipboardWriteImage: "runnerHost:clipboard:writeImage",
  requestHostRespawn: "runnerHost:host:requestRespawn",
  // The `hostId` in `pid.json`, read as a pure structural parse with no
  // reachability requirement. `localHostChange` only ever emits a snapshot
  // for a host that is actually dialable, so while the host is down the
  // renderer has no way to recognise this machine's own registry entry.
  // This is that durable identity, and the renderer needs it precisely when
  // no snapshot exists.
  lastKnownLocalHostId: "runnerHost:host:lastKnownLocalHostId",
  // PULL for the same snapshot `localHostChange` pushes.
  //
  // The push side is edge-triggered onto a renderer-side cache that starts at
  // `null`, so every delivery hazard between the two processes - a window that
  // registers after the fan-out, a `webContents` reload that resets the preload
  // cache, a send dropped while the renderer navigates - is INDISTINGUISHABLE
  // in the renderer from "this machine has no host", and stays that way until
  // the main process happens to emit a change. On a steady-state host that
  // change may never come. This channel removes the whole class: a subscriber
  // asks for the current value instead of hoping it was told.
  localHostSnapshot: "runnerHost:host:localHostSnapshot",
  setUnsyncedEditsSnapshot: "runnerHost:appLifecycle:setUnsyncedEditsSnapshot",
  // Renderer-initiated app quit (the removed surface's "Quit Traycer" button).
  // Routes through the normal `before-quit` flow (unsynced-edits guard etc.).
  appLifecycleQuit: "runnerHost:appLifecycle:quit",
  acknowledgeQuitRequest: "runnerHost:appLifecycle:acknowledgeQuitRequest",
  respondToQuitRequest: "runnerHost:appLifecycle:respondToQuitRequest",
  freshUnsyncedSnapshotResponse:
    "runnerHost:appLifecycle:freshUnsyncedSnapshotResponse",
  // The CROSS-WINDOW unsyncable set, which no renderer can compute: each one
  // holds only its own Epic session registry, while `appUpdateInstall`
  // restarts the whole app and its quit path deliberately skips the
  // unsynced-edits interception. Asked before authorizing that install.
  unsyncableWorkAcrossWindows:
    "runnerHost:appLifecycle:unsyncableWorkAcrossWindows",
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
  perWindowStateCapabilities: "runnerHost:windows:perWindowState:capabilities",
  perWindowStateUpdate: "runnerHost:windows:perWindowState:update",
  perWindowStateClear: "runnerHost:windows:perWindowState:clear",
  authSessionGet: "runnerHost:windows:authSession:get",
  authSessionSet: "runnerHost:windows:authSession:set",
  supportSnapshotGet: "runnerHost:support:snapshot:get",
  supportRevealLog: "runnerHost:support:log:reveal",
  supportSubmitReport: "runnerHost:support:report:submit",
  supportTailLog: "runnerHost:support:log:tail",
  supportFreezeEvidence: "runnerHost:support:evidence:freeze",
  supportDiscardFrozenEvidence: "runnerHost:support:evidence:discard",
  supportReadFrozenLogTail: "runnerHost:support:evidence:log:tail",
  supportSaveDiagnosticBundle: "runnerHost:support:diagnosticBundle:save",
  // Per-install report ledger (T3.5). Read-only surface for the dialog's
  // "Nth time on this install" strip; sightings write via freezeEvidence,
  // filed reports write on delivered submit - neither is renderer-writable.
  supportGetFingerprintOccurrence:
    "runnerHost:support:ledger:fingerprintOccurrence:get",
  // Ticket 09 / T6: the sole main-process producer of public (GitHub-bound)
  // text, always behind the deep scrubber.
  supportBuildPublicDraft: "runnerHost:support:publicDraft:build",
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
  traycerConfigShellAdd: "runnerHost:traycer:config:shell:add",
  traycerConfigShellRemove: "runnerHost:traycer:config:shell:remove",
  traycerConfigShellRevertArgs: "runnerHost:traycer:config:shell:revert-args",
  // Native (non-CLI) helpers for the "Add a shell" picker section: a debounced
  // fs existence/executability probe and the native file dialog.
  traycerConfigShellProbe: "runnerHost:traycer:config:shell:probe",
  traycerConfigShellPickProgramFile:
    "runnerHost:traycer:config:shell:pickProgramFile",
  traycerConfigEnvList: "runnerHost:traycer:config:env:list",
  traycerConfigEnvSet: "runnerHost:traycer:config:env:set",
  traycerConfigEnvDelete: "runnerHost:traycer:config:env:delete",
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
  appUpdateSetAllowPrerelease: "runnerHost:appUpdate:setAllowPrerelease",
  appUpdateDownload: "runnerHost:appUpdate:download",
  appUpdateInstall: "runnerHost:appUpdate:install",
  appUpdateResolveCompatRecovery: "runnerHost:appUpdate:resolveCompatRecovery",
  globalShortcutsGetSnapshot: "runnerHost:globalShortcuts:getSnapshot",
  globalShortcutsSet: "runnerHost:globalShortcuts:set",
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
  // Windows-only: repaints the native min/max/close controls (Chromium's
  // Window Controls Overlay) with the renderer's theme-derived colors.
  windowSetTitleBarOverlay: "runnerHost:window:setTitleBarOverlay",
  // Windows frameless title bars cannot display Electron's native menu row.
  // The renderer supplies the clicked top-level label's anchor point and main
  // opens the corresponding submenu from the canonical application Menu.
  menuOpenTopLevel: "runnerHost:menu:openTopLevel",
  displayList: "runnerHost:display:list",
  gpuAccelerationGet: "runnerHost:gpu:get",
  gpuAccelerationSet: "runnerHost:gpu:set",
  logLevelsGet: "runnerHost:logLevels:get",
  logLevelsSet: "runnerHost:logLevels:set",
  featureSettingsGet: "runnerHost:featureSettings:get",
  agentRolesEnabledSet: "runnerHost:featureSettings:agentRoles:set",
  // Enumerates fonts installed on this machine for the Appearance font
  // pickers (Settings → Appearance → UI/Code/Terminal font).
  fontsList: "runnerHost:fonts:list",
  // Renderer-driven sleep prevention. The renderer recomputes
  // `preventSleepWhileRunning && anyLocalAgentActive` and pushes the boolean
  // here; main holds a single `powerSaveBlocker` while any window wants it.
  powerSetSleepBlocked: "runnerHost:power:setSleepBlocked",
  // Host management - Settings → Host, Doctor failure card, registry
  // update notice. Each handler invokes a `traycer host …` subcommand
  // (NDJSON) and projects the terminal `result.data` payload to the
  // renderer. Long-running invokes also fan out progress on
  // `cliOperationProgress` keyed by `operationId`.
  // Two-lane canonical `HostController` status (Host Update Layer Redesign
  // Tech Plan). Read once on mount; live updates arrive on
  // `hostControllerStatusChange`.
  traycerHostControllerStatusGet:
    "runnerHost:traycer:host:controllerStatus:get",
  // Idempotent "converge the host to reachable" (post-auth provisioning,
  // manual retry, Force restart). Resolves a `MutationOutcome`.
  traycerHostConvergeReady: "runnerHost:traycer:host:convergeReady",
  // Applies the currently-staged version. Resolves a `MutationOutcome`.
  traycerHostApplyStaged: "runnerHost:traycer:host:applyStaged",
  // Activates an installed-but-not-activated record (packaged-macOS
  // post-commit activation, or clearing activation debt). Resolves a
  // `MutationOutcome`.
  traycerHostActivateInstalled: "runnerHost:traycer:host:activateInstalled",
  // Pins an explicit version (incl. downgrades). Resolves a
  // `MutationOutcome`.
  traycerHostInstallVersion: "runnerHost:traycer:host:installVersion",
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
  traycerFreePortAndRestart: "runnerHost:traycer:freePortAndRestart",
  traycerFreePortAndRestartIfIdle:
    "runnerHost:traycer:freePortAndRestartIfIdle",
  traycerDoctorRepairQueued: "runnerHost:traycer:doctorRepairQueued",
  traycerCliManifestRead: "runnerHost:traycer:cli:manifestRead",
  // The `maintenance:*` channels answer the v1.2.0 host maintenance RPCs for
  // the GUI's local fallback (a local host ≤ 1.1.11 negotiated the family
  // away). Each handler projects the same CLI JSON / on-disk records the
  // host's own resolvers project, and resolves PROTOCOL response shapes — CLI
  // failures are classified into the wire taxonomy in main, because an invoke
  // rejection loses its error shape at the context-bridge boundary.
  traycerMaintenanceUpdateCheck: "runnerHost:traycer:maintenance:updateCheck",
  traycerMaintenanceDoctor: "runnerHost:traycer:maintenance:doctor",
  traycerMaintenanceInstallationInfo:
    "runnerHost:traycer:maintenance:installationInfo",
  // Separate from `host:installVersion` because the lane refusal must be
  // ATOMIC with the submission: main tests the exclusive mutation lane and
  // enqueues in one synchronous stretch, which a renderer reading status and
  // then submitting cannot do.
  traycerMaintenanceInstallVersion:
    "runnerHost:traycer:maintenance:installVersion",
  // Same atomicity, for the respawn. `host:restart` keeps its queueing
  // semantics for the tray/menu; a Settings restart refuses instead of
  // firing a kill against state the person never saw.
  traycerHostRestartIfIdle: "runnerHost:traycer:host:restartIfIdle",
  traycerDoctorRepairIfIdle: "runnerHost:traycer:doctor:repairIfIdle",
  traycerHostNameGet: "runnerHost:traycer:host:name:get",
  traycerHostNameSet: "runnerHost:traycer:host:name:set",
  // Selection authority (host-lifecycle redesign, D16 / P1.1). The engine
  // lives in main; windows claim an attach generation, report connection
  // evidence, and write Activate through these. Binding rules and the
  // request/result shapes are in `selection-authority-ipc.ts`; the constants
  // below are type-linked to its maps by `SelectionAuthorityChannels`.
  selectionAttach: "runnerHost:selection:attach",
  selectionReportEvidence: "runnerHost:selection:reportEvidence",
  selectionActivate: "runnerHost:selection:activate",
  selectionRefreshFleet: "runnerHost:selection:refreshFleet",
  zoomGet: "runnerHost:zoom:get",
  zoomSet: "runnerHost:zoom:set",
  zoomStepIn: "runnerHost:zoom:stepIn",
  zoomStepOut: "runnerHost:zoom:stepOut",
  zoomReset: "runnerHost:zoom:reset",
} as const;

export const RunnerHostEvent = {
  authCallback: "runnerHost:event:authCallback",
  // Credentials-file change broadcast (tech plan §3/§4). Fired by the main
  // `FileTokenStore`'s owned watcher on every observed change (external writes
  // AND self-writes) so each renderer's reconcile worker re-reads the file. The
  // watcher itself lands in §4; the channel + preload subscription ship now.
  authTokenStoreChange: "runnerHost:event:auth:tokenStore:change",
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
  notificationForegroundDisplay:
    "runnerHost:event:notificationForegroundDisplay",
  trayEpicSelected: "runnerHost:event:trayEpicSelected",
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
  // Tray-driven host commands forwarded to the renderer's
  // `HostTrayCommandListener`. Payloads match the shared
  // `HostTrayCommand` union.
  hostTrayCommand: "runnerHost:event:host:trayCommand",
  // Canonical two-lane `HostController` status broadcast (Host Update Layer
  // Redesign Tech Plan). Fired on every mutation-lane progress/status
  // change (push) and on a download-lane poll tick while a download is
  // active (see `host-controller-status-broadcast.ts`), so every open
  // window's gate/banner/Settings/tray stay in lockstep.
  hostControllerStatusChange: "runnerHost:event:host:controllerStatusChange",
  // ONE registry read per app, fanned out to every window (redesign P4.1/F22,
  // connection registry §1b/§6). The 60s `GET /api/v3/hosts` cadence used to
  // be a per-window renderer timer, so N windows meant N timers and N fetches
  // against one endpoint; main owns the cadence now and pushes the rows it
  // already fetches for the selection authority's fleet port. The renderer
  // keeps its own timer ONLY where there is no main process to own one
  // (browser/dev, the single-window topology D16 names).
  registeredHostsChange: "runnerHost:event:host:registeredHostsChange",
  zoomChange: "runnerHost:event:zoom:change",
  globalShortcutsChange: "runnerHost:event:globalShortcuts:change",
  // Selection-authority broadcasts. THREE kinds, each emission carrying its
  // own unique authority revision, so one high-water mark per client totally
  // orders all three (see `selection-authority-ipc.ts`).
  selectionChanged: "runnerHost:event:selection:selectionChanged",
  selectionLeasesChanged: "runnerHost:event:selection:leasesChanged",
  selectionReattachRequired: "runnerHost:event:selection:reattachRequired",
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
  // The attach generation for this preload load, allocated ENGINE-side (the
  // same pattern that serves `windowId`). No preload-local counter exists, so
  // a reloaded preload can never repeat or reset the sequence.
  selectionAttachSeq: "runnerHost:sync:selectionAttachSeq",
} as const;

export type RunnerHostInvokeChannel =
  (typeof RunnerHostInvoke)[keyof typeof RunnerHostInvoke];
export type RunnerHostEventChannel =
  (typeof RunnerHostEvent)[keyof typeof RunnerHostEvent];
export type RunnerHostSyncChannel =
  (typeof RunnerHostSync)[keyof typeof RunnerHostSync];

/**
 * The selection-authority channel set, TYPE-LINKED to the binding maps in
 * `selection-authority-ipc.ts`: the `satisfies` clause below requires exactly
 * one channel constant per map member, so renaming or adding a member there
 * fails this module's compile instead of drifting into a channel that no
 * handler serves. Both the main registration and the preload bridge read the
 * names from here rather than from a second list.
 */
export const SelectionAuthorityChannels = {
  sync: {
    selectionAttachSeq: RunnerHostSync.selectionAttachSeq,
  },
  invoke: {
    attach: RunnerHostInvoke.selectionAttach,
    reportEvidence: RunnerHostInvoke.selectionReportEvidence,
    activate: RunnerHostInvoke.selectionActivate,
    refreshFleet: RunnerHostInvoke.selectionRefreshFleet,
  },
  event: {
    selectionChanged: RunnerHostEvent.selectionChanged,
    leasesChanged: RunnerHostEvent.selectionLeasesChanged,
    reattachRequired: RunnerHostEvent.selectionReattachRequired,
  },
} as const satisfies {
  sync: Record<keyof SelectionAuthoritySyncMap, RunnerHostSyncChannel>;
  invoke: Record<keyof SelectionAuthorityInvokeMap, RunnerHostInvokeChannel>;
  event: Record<keyof SelectionAuthorityEventMap, RunnerHostEventChannel>;
};
