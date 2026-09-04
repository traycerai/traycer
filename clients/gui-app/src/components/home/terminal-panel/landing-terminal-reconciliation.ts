import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { selectPlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";
import {
  hostAcknowledgedTab,
  isProviderLoginLandingTab,
  terminalSessionKey,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";

export interface LandingTerminalReconciliationInput {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly activeHostId: string;
  readonly sessions: ReadonlyArray<
    CanonicalTerminalSessionInfo | CanonicalTerminalSessionInfoWithCurrentCwd
  >;
  /** Tombstones captured before their kill retries begin. */
  readonly excludedSessionKeys: ReadonlySet<string>;
  readonly mintInstanceId: () => string;
  /**
   * The provider a listed session was opened to sign in to, or `null` for an
   * ordinary terminal. Injected rather than read here so this stays pure, the
   * same way `mintInstanceId` is.
   *
   * Adoption needs it because `terminal.list` carries no origin: a sign-in
   * session started in ANOTHER window (or before this renderer reloaded)
   * arrives here as an ordinary running session, and an adopted ref without
   * the marker is one a tile will happily `terminal.create` under - spawning a
   * bare shell with none of the provider's spawn env, which looks like the
   * sign-in terminal and cannot sign anyone in.
   */
  readonly providerLoginProviderFor: (sessionId: string) => ProviderId | null;
}

/**
 * `tab` with its sign-in provenance applied, or `tab` unchanged.
 *
 * Only ever ADDS the marker: a tab that already carries it keeps its recorded
 * provider (the registry is bounded and evicts, so a later miss must not
 * un-classify a tab that was classified when the record was still there).
 */
function classifyLandingTab(
  tab: LandingTerminalTabRef,
  input: Pick<LandingTerminalReconciliationInput, "providerLoginProviderFor">,
): LandingTerminalTabRef {
  if (isProviderLoginLandingTab(tab)) return tab;
  const originProviderId = input.providerLoginProviderFor(tab.sessionId);
  if (originProviderId === null) return tab;
  return {
    ...tab,
    name: `${PROVIDER_DISPLAY_NAMES[originProviderId]} sign-in`,
    titleSource: "manual",
    origin: "provider-login",
    originProviderId,
  };
}

export interface LandingTerminalReconciliationResult {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly adoptedTabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly exitedInstanceIds: ReadonlyArray<string>;
  readonly collapseWhenEmpty: boolean;
}

export interface HostAuthoritativeLandingTerminalReconciliationInput {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly hostId: string;
  readonly terminals: readonly PlainTerminalProjection[];
  readonly excludedTerminalKeys: ReadonlySet<string>;
  readonly mintInstanceId: () => string;
  /**
   * Same injected registry read as the legacy pass, for the same reason - a
   * plain snapshot carries no origin either.
   *
   * A manager-owned sign-in session is never PROJECTED here, so this pass has
   * nothing to adopt from it. What it does have is a tab: one adopted without
   * the marker while the host still read `legacy`, which after the switch is
   * unacknowledged, unprojected, and therefore both `importLegacy` bait and a
   * `terminal.plain.create` bare shell. Only the registry can tell it apart.
   */
  readonly providerLoginProviderFor: (sessionId: string) => ProviderId | null;
}

export function resolveLandingTerminalTitleCwd(input: {
  readonly currentCwd: string | null;
  readonly currentCwdReported: boolean;
  readonly launchCwd: string;
}): string | null {
  return input.currentCwdReported ? input.currentCwd : input.launchCwd;
}

export function resolveLandingTerminalSyncedTitle(input: {
  readonly snapshotLoaded: boolean;
  readonly title: string | null;
  readonly activeProcessName: string | null;
  readonly currentCwd: string | null;
  readonly currentCwdReported: boolean;
  readonly launchCwd: string;
}): string | null {
  if (!input.snapshotLoaded) return null;
  return terminalSessionTitle({
    title: input.title,
    activeProcessName: input.activeProcessName,
    currentCwd: resolveLandingTerminalTitleCwd(input),
  });
}

/**
 * Reconciles only the selected host. Other-host references deliberately stay
 * intact: their own bound tile bootstrap owns their reattach/dead/recreate
 * lifecycle, and an active-host list cannot authoritatively classify them.
 */
export function reconcileLandingTerminalTabs(
  input: LandingTerminalReconciliationInput,
): LandingTerminalReconciliationResult {
  const survivingTabs = input.tabs.filter(
    (tab) =>
      !input.excludedSessionKeys.has(
        terminalSessionKey(tab.hostId, tab.sessionId),
      ),
  );
  const sessions = input.sessions.filter(
    (session) =>
      session.scope.kind === "independent" &&
      session.sessionKind === "terminal" &&
      !input.excludedSessionKeys.has(
        terminalSessionKey(input.activeHostId, session.sessionId),
      ),
  );
  const sessionById = new Map(
    sessions.map((session) => [session.sessionId, session]),
  );
  const matchedSessionIds = new Set<string>();
  const exitedInstanceIds: string[] = [];

  const tabs = survivingTabs.flatMap((tab) => {
    if (tab.hostId !== input.activeHostId) return [tab];
    const session = sessionById.get(tab.sessionId);
    if (session === undefined) {
      // The host is reachable (the successful list is our proof). Leave an
      // absent ref for its bound tile bootstrap to recreate with this exact
      // desired id and cwd after the ordered pass completes.
      return [tab];
    }
    matchedSessionIds.add(session.sessionId);
    // Provenance can arrive AFTER the tab. Another window can list a running
    // sign-in session before this one has been told what it is, and that pass
    // adopts an ordinary tab; from then on the session is MATCHED, so without
    // this the adoption branch below never reconsiders it and the tab stays
    // legacy-importable - and recreatable as a bare shell - for life.
    const classified = classifyLandingTab(tab, input);
    // A sign-in tab outlives its session's exit: its tile shows the ended
    // state with a restart, the way the epic sign-in tile does. Dropping it
    // here would retract the only surface that can restart the sign-in.
    if (session.status === "exited" && !isProviderLoginLandingTab(classified)) {
      exitedInstanceIds.push(classified.instanceId);
      return [];
    }
    if (classified.titleSource === "manual") return [classified];
    const name = defaultLandingTerminalTitle(session, classified.cwd);
    return [name === classified.name ? classified : { ...classified, name }];
  });

  const adoptedTabs = sessions.flatMap((session) => {
    if (
      session.status !== "running" ||
      matchedSessionIds.has(session.sessionId)
    ) {
      return [];
    }
    const originProviderId = input.providerLoginProviderFor(session.sessionId);
    if (originProviderId !== null) {
      // Same ref shape the opening path writes, so every reader downstream -
      // the adopt-only tile, the legacy-import exclusion, the close and rename
      // paths - classifies a session discovered here exactly as one this
      // window opened. Manual title for the same reason: the host names it
      // "<Provider> sign-in" and reconciliation must not retitle it from cwd.
      const signInTab: LandingTerminalTabRef = {
        instanceId: input.mintInstanceId(),
        sessionId: session.sessionId,
        hostId: input.activeHostId,
        cwd: session.cwd,
        name: `${PROVIDER_DISPLAY_NAMES[originProviderId]} sign-in`,
        titleSource: "manual",
        origin: "provider-login",
        originProviderId,
      };
      return [signInTab];
    }
    const tab: LandingTerminalTabRef = {
      instanceId: input.mintInstanceId(),
      sessionId: session.sessionId,
      hostId: input.activeHostId,
      cwd: session.cwd,
      name: defaultLandingTerminalTitle(session, session.cwd),
      titleSource: "default",
    };
    return [tab];
  });
  const nextTabs = [...tabs, ...adoptedTabs];
  const activeInstanceId = resolveActiveInstanceId(
    input.activeInstanceId,
    nextTabs,
  );

  return {
    tabs: nextTabs,
    activeInstanceId,
    adoptedTabs,
    exitedInstanceIds,
    collapseWhenEmpty:
      nextTabs.length === 0 &&
      (exitedInstanceIds.length > 0 ||
        survivingTabs.length !== input.tabs.length),
  };
}

/**
 * Reconciles one host's local presentation pointers against a fresh durable
 * independent-terminal snapshot. Only acknowledged refs may be classified as
 * authoritatively deleted; unacknowledged legacy refs remain available to the
 * migration coordinator.
 */
export function reconcileHostAuthoritativeLandingTerminalTabs(
  input: HostAuthoritativeLandingTerminalReconciliationInput,
): LandingTerminalReconciliationResult {
  const projectionById = new Map(
    input.terminals.map((terminal) => [terminal.record.terminalId, terminal]),
  );
  const matchedTerminalIds = new Set<string>();
  const removedInstanceIds: string[] = [];

  const tabs = input.tabs.flatMap((rawTab) => {
    if (rawTab.hostId !== input.hostId) return [rawTab];
    const terminalKey = terminalSessionKey(rawTab.hostId, rawTab.sessionId);
    if (input.excludedTerminalKeys.has(terminalKey)) {
      removedInstanceIds.push(rawTab.instanceId);
      return [];
    }
    const tab = classifyLandingTab(rawTab, input);
    const projection = projectionById.get(tab.sessionId);
    if (projection === undefined) {
      if (tab.hostAuthorityAcknowledged === true) {
        removedInstanceIds.push(tab.instanceId);
        return [];
      }
      return [tab];
    }
    matchedTerminalIds.add(projection.record.terminalId);
    const acknowledged = hostAcknowledgedTab(tab, projection);
    // Reuse the existing reference when nothing derived actually moved, the
    // same way the legacy pass above reuses `tab` on an unchanged name. Stream
    // frames bump `projectionSequence` constantly, and every new object here
    // becomes a fresh `tabs` array in the store - re-rendering every tab
    // consumer and re-serializing the persisted slot for identical data.
    return [landingTerminalTabsEqual(tab, acknowledged) ? tab : acknowledged];
  });

  const adoptedTabs = input.terminals.flatMap((terminal) => {
    const terminalId = terminal.record.terminalId;
    if (
      matchedTerminalIds.has(terminalId) ||
      input.excludedTerminalKeys.has(
        terminalSessionKey(input.hostId, terminalId),
      )
    ) {
      return [];
    }
    const view = selectPlainTerminalViewModel(terminal);
    const tab: LandingTerminalTabRef = {
      instanceId: input.mintInstanceId(),
      sessionId: terminalId,
      hostId: terminal.record.hostId,
      cwd: terminal.record.launch.cwd,
      name: view.displayTitle,
      titleSource: terminal.record.manualTitle === null ? "default" : "manual",
      hostAuthorityAcknowledged: true,
      pendingCreate: false,
    };
    return [tab];
  });
  const nextTabs = [...tabs, ...adoptedTabs];

  return {
    tabs: nextTabs,
    activeInstanceId: resolveActiveInstanceId(input.activeInstanceId, nextTabs),
    adoptedTabs,
    exitedInstanceIds: removedInstanceIds,
    collapseWhenEmpty: nextTabs.length === 0 && removedInstanceIds.length > 0,
  };
}

/**
 * Every field `hostAcknowledgedTab` writes, plus the identity it preserves.
 * Extend this together with that helper: a field compared here but not written
 * there is harmless, one written there but missed here silently re-pins the
 * stale value by reusing the old reference.
 */
function landingTerminalTabsEqual(
  left: LandingTerminalTabRef,
  right: LandingTerminalTabRef,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.sessionId === right.sessionId &&
    left.hostId === right.hostId &&
    left.cwd === right.cwd &&
    left.name === right.name &&
    left.titleSource === right.titleSource &&
    left.hostAuthorityAcknowledged === right.hostAuthorityAcknowledged &&
    left.pendingCreate === right.pendingCreate &&
    left.sourceStoreVersion === right.sourceStoreVersion &&
    left.origin === right.origin &&
    left.originProviderId === right.originProviderId
  );
}

function defaultLandingTerminalTitle(
  session:
    | CanonicalTerminalSessionInfo
    | CanonicalTerminalSessionInfoWithCurrentCwd,
  launchCwd: string,
): string {
  const currentCwdReported = "currentCwd" in session;
  const liveCwd = resolveLandingTerminalTitleCwd({
    currentCwd: currentCwdReported ? session.currentCwd : null,
    currentCwdReported,
    launchCwd,
  });
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
    currentCwd: liveCwd,
  });
}

function resolveActiveInstanceId(
  activeInstanceId: string | null,
  tabs: ReadonlyArray<LandingTerminalTabRef>,
): string | null {
  if (
    activeInstanceId !== null &&
    tabs.some((tab) => tab.instanceId === activeInstanceId)
  ) {
    return activeInstanceId;
  }
  return tabs[0]?.instanceId ?? null;
}
