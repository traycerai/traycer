import type { GlobalShortcutId } from "@traycer-clients/shared/keybindings/global-shortcuts";
import type { DesktopAppUpdateSnapshot } from "@/lib/windows/types";

const supportBridgeQueryScopeIds = new WeakMap<object, number>();
let nextSupportBridgeQueryScopeId = 1;

/**
 * TanStack Query hashes keys through JSON serialization, so a bridge object
 * whose public surface is methods would serialize as `{}`. Give each bridge
 * instance a stable, serializable scope instead.
 */
export function supportBridgeQueryScopeId(
  support: object | null,
): number | null {
  if (support === null) return null;
  const existing = supportBridgeQueryScopeIds.get(support);
  if (existing !== undefined) return existing;
  const scopeId = nextSupportBridgeQueryScopeId;
  nextSupportBridgeQueryScopeId += 1;
  supportBridgeQueryScopeIds.set(support, scopeId);
  return scopeId;
}

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
  traycerShellConfigAdd: () => ["runner.traycer.shellConfigAdd"] as const,
  traycerShellConfigRemove: () => ["runner.traycer.shellConfigRemove"] as const,
  traycerShellRevertArgs: () => ["runner.traycer.shellRevertArgs"] as const,
  traycerEnvOverrideSet: () => ["runner.traycer.envOverrideSet"] as const,
  traycerEnvOverrideDelete: () => ["runner.traycer.envOverrideDelete"] as const,
  // A rename is ONE operation on the bridge too: the boundary that loses the
  // second half is the OBSERVER, not the transport, so chaining a delete onto
  // the set's per-`mutate` callback drops it on unmount exactly as the RPC
  // path did before `config.env.rename`.
  traycerEnvOverrideRename: () => ["runner.traycer.envOverrideRename"] as const,
  // Host-management mutations consumed by the host gate, update banner,
  // Settings → Host, and the Doctor failure card.
  hostInstallVersion: () => ["runner.host.installVersion"] as const,
  hostConvergeReady: () => ["runner.host.convergeReady"] as const,
  hostApplyStaged: () => ["runner.host.applyStaged"] as const,
  hostActivateInstalled: () => ["runner.host.activateInstalled"] as const,
  // On-demand bridge read of this machine's host log, for a Doctor report on a
  // host with no `diagnostics.*` family to ask. Mutation-shaped like the RPC
  // card's own logs read: it is a button, not a subscription.
  hostDoctorBridgeLogs: () => ["runner.host.doctorBridgeLogs"] as const,
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
  supportFreezeEvidence: () => ["runner.support.freezeEvidence"] as const,
  supportSaveDiagnosticBundle: () =>
    ["runner.support.saveDiagnosticBundle"] as const,
  // Builds the scrubbed public draft for the publish preview (ticket 09/07).
  supportBuildPublicDraft: () => ["runner.support.buildPublicDraft"] as const,
  // Opens the previewed draft's GitHub issue-form URL in the browser
  // (ticket 07's publish preview - Flow 3b), separate from the fetch above so
  // the preview can render before the user opts to leave the app.
  supportPublicDraftOpen: () => ["runner.support.publicDraftOpen"] as const,
  // Reveal a log file in the OS file manager (Diagnostics → Logs).
  revealLog: () => ["runner.support.revealLog"] as const,
  // On-demand V8 heap snapshot of this renderer (Diagnostics → Memory).
  // The key identifies the mutation; it does NOT serialize it - TanStack
  // Query only serializes on `scope`, which the caller sets, and which is
  // what keeps a double-click from starting a second renderer-freezing
  // heap walk.
  captureHeapSnapshot: () =>
    ["runner.diagnostics.captureHeapSnapshot"] as const,
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
  openExternalLink: () => ["runner.openExternalLink"] as const,
  // Re-open a file the desktop save dialog just wrote (`fileDrops.openSavedFile`).
  openSavedFile: () => ["runner.fileDrops.openSavedFile"] as const,
  // Windows frameless title-bar menu strip: pop up a top-level native submenu.
  openTopLevelMenu: () => ["runner.menu.openTopLevel"] as const,
  zoomSet: (scope: string | null) => ["runner.zoom.set", scope] as const,
  zoomStepIn: (scope: string | null) => ["runner.zoom.stepIn", scope] as const,
  zoomStepOut: (scope: string | null) =>
    ["runner.zoom.stepOut", scope] as const,
  zoomReset: (scope: string | null) => ["runner.zoom.reset", scope] as const,
  // Settings → log level (desktop/cli/host). Machine-local config, not
  // host-scoped, so a single static key suffices.
  logLevelsSet: () => ["runner.logLevels.set"] as const,
  agentRolesEnabledSet: () =>
    ["runner.featureSettings.agentRoles.set"] as const,
  setAllowPrereleaseUpdates: () =>
    ["runner.appUpdates.setAllowPrerelease"] as const,
  globalShortcutsSet: (id: GlobalShortcutId) =>
    ["runner.globalShortcuts.set", id] as const,
  // Settings → Notifications → "This phone". Both act on the ONE device this
  // renderer runs on, so a static key is the whole scope - there is no second
  // OS permission to hold a separate entry for.
  pushPermissionRequest: () => ["runner.pushPermission.request"] as const,
  pushPermissionOpenSettings: () =>
    ["runner.pushPermission.openSettings"] as const,
};

const runnerHostQueryScopeIds = new WeakMap<object, number>();
let nextRunnerHostQueryScopeId = 1;

/**
 * Same hazard `supportBridgeQueryScopeId` above exists for: TanStack Query
 * hashes keys STRUCTURALLY (JSON serialization), so two runner-host instances
 * whose enumerable surface serializes identically hash to the same key - and a
 * pending `fetchQuery` for the OLD runner then dedupes the NEW runner's read
 * onto it, seeding the replacement directory with the previous shell's
 * identity. A per-instance primitive token is what actually delivers the
 * "scoped by instance" the key promises.
 */
export function runnerHostQueryScopeId(runnerHost: object): number {
  const existing = runnerHostQueryScopeIds.get(runnerHost);
  if (existing !== undefined) return existing;
  const scopeId = nextRunnerHostQueryScopeId;
  nextRunnerHostQueryScopeId += 1;
  runnerHostQueryScopeIds.set(runnerHost, scopeId);
  return scopeId;
}

export const runnerQueryKeys = {
  serviceLogTail: (service: object, maxLines: number) =>
    ["runner.serviceLogTail", service, maxLines] as const,
  /**
   * Where recovery from a host's client-compatibility rejection should send
   * this user, as decided by the desktop main process.
   *
   * KEYED ON THE INPUTS THAT CHANGE THE ANSWER, and deliberately not on the
   * whole snapshot. The floor and the RC authorization are the question;
   * `candidateSufficient` and `allowPrerelease` are the two facts about the
   * held candidate that flip the route. Keying on `status` / `latestVersion`
   * as well would mint a fresh key - and so a fresh paginated RC probe - every
   * time the updater merely re-narrated the same candidate.
   *
   * Scoped to the bridge instance the plan was resolved through
   * (`runnerHostQueryScopeId`), for the same structural-hashing reason every
   * other runner query is.
   */
  appUpdateCompatRecovery: (input: {
    readonly runnerHostScopeId: number;
    readonly minimumEpoch: number;
    readonly hostAllowsRcRecovery: boolean;
    readonly candidateSufficient: boolean;
    readonly allowPrerelease: boolean;
    /**
     * The updater status; `"idle"` means it currently holds no candidate.
     *
     * ⚠ THIS SEGMENT IS NOT A CACHE-EFFICIENCY DETAIL - it is what makes
     * `resolveCompatRecovery`'s SIDE EFFECTS run when they are needed. Resolving
     * a plan discards an insufficient staged artifact and disarms quit-time
     * install, and on macOS it is what produces the `restart-to-clear-staged`
     * warning.
     *
     * Without it, the very common opening sequence silently skips all of that:
     * the dialog mounts, the plan resolves while the mount-triggered update
     * check is still in flight (nothing held, so `candidateSufficient: false`),
     * and the check then lands an INSUFFICIENT candidate. `candidateSufficient`
     * is still `false` and `allowPrerelease` has not moved, so the key is
     * unchanged, the `staleTime: Infinity` entry is reused, and main is never
     * asked again - leaving a Windows user with a staged build still armed to
     * install on quit, and a macOS user with no warning that one will.
     */
    readonly candidateStatus: DesktopAppUpdateSnapshot["status"];
  }) =>
    [
      ...runnerQueryKeys.appUpdateCompatRecoveryScope(input.runnerHostScopeId),
      input.minimumEpoch,
      input.hostAllowsRcRecovery,
      input.candidateSufficient,
      input.allowPrerelease,
      input.candidateStatus,
    ] as const,
  /**
   * Every recovery plan resolved through one bridge, as a partial-match prefix.
   *
   * The RC opt-in invalidates through THIS rather than through a reconstructed
   * full key: after a channel change the inputs that identified the entry have
   * themselves moved, so naming the old key exactly means naming an entry
   * nobody will read again while leaving the one they will read stale. It is a
   * prefix EXTENSION above, not a sibling, which is what keeps the partial
   * match reaching it.
   */
  appUpdateCompatRecoveryScope: (runnerHostScopeId: number) =>
    ["runner.appUpdates.compatRecovery", runnerHostScopeId] as const,
  // The shell's durable answer to "which host id belongs to THIS machine",
  // read once while the host directory bootstraps. Takes the SCOPE ID, not
  // the runner object - see `runnerHostQueryScopeId`.
  lastKnownLocalHostId: (runnerHostScopeId: number) =>
    ["runner.host.lastKnownLocalHostId", runnerHostScopeId] as const,
  // `traycerCli: object` keys these queries to a specific runner-host
  // instance so a host swap (test setups, hot reload) invalidates the
  // cache cleanly. Identity comparison only - the object is never
  // serialised.
  traycerHostStatus: (traycerCli: object) =>
    ["runner.traycer.hostStatus", traycerCli] as const,
  // The host-status read on a shell with no CLI at all (mobile, web). A key of
  // its own so the disabled query can never collide with a real runner's.
  traycerHostStatusDisabled: () =>
    ["runner.traycer.hostStatus", "disabled"] as const,
  /**
   * A PRIVATE host-status entry, one per mount of a reader that needs a sample
   * it took itself rather than whatever the shared entry holds
   * (`LocalBootstrapAttempts`, mounting on a settled failure). A key nothing
   * else has used has no entry and no in-flight retryer, so the fetch cannot
   * be deduplicated onto a request that started before the failure.
   *
   * It EXTENDS `traycerHostStatus` rather than standing beside it, and that is
   * load-bearing: the recovery mutations invalidate the shared key by partial
   * match, and only a prefix extension is still reached by them.
   */
  traycerHostStatusFreshRead: (traycerCli: object, readId: number) =>
    [
      ...runnerQueryKeys.traycerHostStatus(traycerCli),
      "fresh-read",
      readId,
    ] as const,
  traycerShellConfig: (traycerCli: object) =>
    ["runner.traycer.shellConfig", traycerCli] as const,
  traycerShellList: (traycerCli: object) =>
    ["runner.traycer.shellList", traycerCli] as const,
  // Live "Add a shell" validation probe, keyed by the candidate path so each
  // debounced value caches independently. Scoped to the runner-host instance
  // like the other traycer queries.
  traycerShellProbe: (traycerCli: object, path: string) =>
    ["runner.traycer.shellProbe", traycerCli, path] as const,
  traycerEnvOverrideList: (traycerCli: object) =>
    ["runner.traycer.envOverrideList", traycerCli] as const,
  // Host-management queries carry the `IHostManagement` instance as a key
  // segment.
  //
  // It does NOT discriminate: `IHostManagement` and its desktop wrapper are
  // method-only, so TanStack's key hash serializes every instance to `{}`.
  // That is harmless here only because the bridge is app-wide and singular -
  // `runnerHost.hostManagement` is this computer's local CLI bridge, and a
  // remote host has none at all (those callers take the
  // `...Unavailable()` keys). A host swap does not swap this object, so it is
  // effectively a namespace marker rather than a scope. Anything that ever
  // needs two live bridges to hold distinct cache entries has to key on a
  // stable primitive instead - this segment will not do it.
  hostAvailableVersionsScope: (management: object) =>
    ["runner.host.availableVersions", management] as const,
  hostAvailableVersions: (management: object, includePreReleases: boolean) =>
    [
      ...runnerQueryKeys.hostAvailableVersionsScope(management),
      includePreReleases,
    ] as const,
  hostRegistryUpdate: (management: object) =>
    ["runner.host.registryUpdate", management] as const,
  // Canonical two-lane `HostController` status (Host Update Layer Redesign
  // Tech Plan). Primed once via `getHostControllerStatus()` on mount, then
  // pushed by `HostControllerStatusListener` - never refetched by TanStack's
  // normal mechanisms, since it is entirely event-sourced.
  hostControllerStatus: (management: object) =>
    ["runner.host.controllerStatus", management] as const,
  hostInstalledRecord: (management: object) =>
    ["runner.host.installedRecord", management] as const,
  // The no-bridge variant of the key above: a disabled placeholder query
  // still needs a key, and an inlined one drifts when this resource's keys
  // change.
  hostInstalledRecordUnavailable: () =>
    ["runner.host.installedRecord", "unavailable"] as const,
  hostLogs: (management: object, tailLines: number) =>
    ["runner.host.logs", management, tailLines] as const,
  // Keyed on the HOST ID as well, unlike its neighbours. The `management`
  // segment hashes to `{}` (see the note above) and the bridge is app-wide, so
  // it survives a local host replacement — a report cached for host A would
  // otherwise be served to host B's console, and this report's issues carry
  // the port/pid numbers its repairs act on. A primitive is what discriminates.
  hostDoctor: (management: object, expectedHostId: string) =>
    ["runner.host.doctor", management, expectedHostId] as const,
  hostCliManifest: (management: object) =>
    ["runner.host.cliManifest", management] as const,
  // Same no-bridge placeholder contract as `hostInstalledRecordUnavailable`.
  hostCliManifestUnavailable: () =>
    ["runner.host.cliManifest", "unavailable"] as const,
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
  featureSettings: () => ["runner.featureSettings"] as const,
  // Fonts installed on this machine (Settings → Appearance font pickers).
  // Machine-local and effectively static for the session, so a single
  // static key suffices.
  installedFonts: () => ["runner.installedFonts"] as const,
  zoomPercent: (scope: string | null) =>
    ["runner.zoom.percent", scope] as const,
  // Desktop support log viewer (Diagnostics → Logs). Scoped by the support
  // bridge scope so a host/shell swap invalidates cleanly, matching
  // the other runner-host queries.
  supportLogList: (supportScopeId: number | null) =>
    ["runner.support.logList", supportScopeId] as const,
  supportLogTail: (supportScopeId: number | null, target: string) =>
    ["runner.support.logTail", supportScopeId, target] as const,
  // Report-issue dialog's machine/user/delivery snapshot. Scoped by bridge
  // identity so shell swaps never reuse another bridge's cached state.
  supportSnapshot: (supportScopeId: number | null) =>
    ["runner.support.snapshot", supportScopeId] as const,
  // Report-issue consent panel's log "view" affordance (ticket 07/04): reads
  // the tail FROZEN at report-open, not a live tail, so what the user reviews
  // is exactly what a submit would send. Scoped by draftId (frozen evidence
  // is per-draft) as well as support identity.
  supportFrozenLogTail: (
    supportScopeId: number | null,
    draftId: number,
    target: string,
  ) =>
    ["runner.support.frozenLogTail", supportScopeId, draftId, target] as const,
  // This phone's OS push permission (Settings → Notifications → "This
  // phone"). Machine-local and singular - one renderer, one OS switch - so a
  // static key suffices, like `logLevels` and `installedFonts` above.
  pushPermission: () => ["runner.pushPermission"] as const,
  // Report-issue evidence strip's "Nth time on this install" line (ticket 06
  // ledger read). Scoped by fingerprint - each distinct defect caches
  // independently.
  supportFingerprintOccurrence: (
    supportScopeId: number | null,
    fingerprint: string,
  ) =>
    [
      "runner.support.fingerprintOccurrence",
      supportScopeId,
      fingerprint,
    ] as const,
};
