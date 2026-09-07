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
  /** Injected rather than read here so this stays pure, the same way `mintInstanceId` is. */
  readonly providerLoginProviderFor: (sessionId: string) => ProviderId | null;
}

/** Only ever adds the marker: a tab that already carries it keeps its recorded provider (the registry is
 * bounded and evicts. */
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
  /** A manager-owned sign-in session is never projected here, so this pass has nothing to adopt from it. */
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

/** Other-host references deliberately stay intact: their own bound tile bootstrap owns their
 * reattach/dead/recreate lifecycle, and an active-host list cannot authoritatively classify them. */
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
      // Leave an absent ref for its bound tile bootstrap to recreate with this exact desired id and cwd after the
      // ordered pass completes.
      return [tab];
    }
    matchedSessionIds.add(session.sessionId);
    // Provenance can arrive after the tab.
    const classified = classifyLandingTab(tab, input);
    // Dropping it here would retract the only surface that can restart the sign-in.
    if (session.status === "exited" && !isProviderLoginLandingTab(classified)) {
      exitedInstanceIds.push(classified.instanceId);
      return [];
    }
    if (classified.titleSource === "manual") return [classified];
    const name = defaultLandingTerminalTitle(session, classified.cwd);
    return [name === classified.name ? classified : { ...classified, name }];
  });

  // Sign-ins first, through the one adoption rule both arms share, then
  // ordinary running sessions the registry does not claim.
  const signInTabs = adoptListedProviderLoginSessions({
    ...input,
    tabs: survivingTabs,
  });
  const ordinaryTabs = sessions.flatMap((session) => {
    if (
      session.status !== "running" ||
      matchedSessionIds.has(session.sessionId) ||
      input.providerLoginProviderFor(session.sessionId) !== null
    ) {
      return [];
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
  const adoptedTabs = [...signInTabs, ...ordinaryTabs];
  const retired = new Set(
    retiredProviderLoginPredecessors({
      tabs,
      activeHostId: input.activeHostId,
      sessions: input.sessions,
      providerLoginProviderFor: input.providerLoginProviderFor,
    }),
  );
  const nextTabs = [
    ...tabs.filter((tab) => !retired.has(tab.instanceId)),
    ...adoptedTabs,
  ];
  const retiredAny = retired.size > 0;
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
        retiredAny ||
        survivingTabs.length !== input.tabs.length),
  };
}

/** Manual title for the same reason: the host names it "<Provider> sign-in" and reconciliation must not retitle
 * it from cwd. */
function providerLoginLandingTab(input: {
  readonly instanceId: string;
  readonly hostId: string;
  readonly session: Pick<CanonicalTerminalSessionInfo, "sessionId" | "cwd">;
  readonly providerId: ProviderId;
}): LandingTerminalTabRef {
  return {
    instanceId: input.instanceId,
    sessionId: input.session.sessionId,
    hostId: input.hostId,
    cwd: input.session.cwd,
    name: `${PROVIDER_DISPLAY_NAMES[input.providerId]} sign-in`,
    titleSource: "manual",
    origin: "provider-login",
    originProviderId: input.providerId,
  };
}

/** What the registry-claimed sessions the host lists say about each provider: which of them are running. */
interface ProviderLoginListing {
  readonly runningSessionIds: ReadonlySet<string>;
}

function listedProviderLoginSessions(
  sessions: LandingTerminalReconciliationInput["sessions"],
): LandingTerminalReconciliationInput["sessions"] {
  return sessions.filter(
    (session) =>
      session.scope.kind === "independent" &&
      session.sessionKind === "terminal",
  );
}

function summarizeProviderLoginListing(
  sessions: LandingTerminalReconciliationInput["sessions"],
  providerLoginProviderFor: (sessionId: string) => ProviderId | null,
): ReadonlyMap<ProviderId, ProviderLoginListing> {
  const summary = new Map<ProviderId, { runningSessionIds: Set<string> }>();
  for (const session of sessions) {
    if (session.status !== "running") continue;
    const providerId = providerLoginProviderFor(session.sessionId);
    if (providerId === null) continue;
    const entry = summary.get(providerId) ?? {
      runningSessionIds: new Set<string>(),
    };
    entry.runningSessionIds.add(session.sessionId);
    summary.set(providerId, entry);
  }
  return summary;
}

/** Whether the tab standing for a sign-in session is one this window should keep showing for its provider. */
function providerLoginSessionIsCurrent(
  listing: ProviderLoginListing | undefined,
  sessionId: string,
): boolean {
  if (listing === undefined) return true;
  return (
    listing.runningSessionIds.has(sessionId) ||
    listing.runningSessionIds.size === 0
  );
}

/** A tombstoned session (closed here, kill still in flight) is never adopted: that would resurrect a tab the
 * user just closed. */
export function adoptListedProviderLoginSessions(
  input: Pick<
    LandingTerminalReconciliationInput,
    | "tabs"
    | "activeHostId"
    | "sessions"
    | "excludedSessionKeys"
    | "mintInstanceId"
    | "providerLoginProviderFor"
  >,
): ReadonlyArray<LandingTerminalTabRef> {
  const tabbedSessionIds = new Set(
    input.tabs
      .filter((tab) => tab.hostId === input.activeHostId)
      .map((tab) => tab.sessionId),
  );
  const listed = listedProviderLoginSessions(input.sessions);
  const listing = summarizeProviderLoginListing(
    listed,
    input.providerLoginProviderFor,
  );
  return listed.flatMap((session) => {
    if (
      session.status !== "running" ||
      tabbedSessionIds.has(session.sessionId) ||
      input.excludedSessionKeys.has(
        terminalSessionKey(input.activeHostId, session.sessionId),
      )
    ) {
      return [];
    }
    const providerId = input.providerLoginProviderFor(session.sessionId);
    if (providerId === null) return [];
    if (
      !providerLoginSessionIsCurrent(listing.get(providerId), session.sessionId)
    ) {
      return [];
    }
    return [
      providerLoginLandingTab({
        instanceId: input.mintInstanceId(),
        hostId: input.activeHostId,
        session,
        providerId,
      }),
    ];
  });
}

/** Returned as instance ids for the caller to drop in the same pass that adopts, in both arms. */
export function retiredProviderLoginPredecessors(input: {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeHostId: string;
  readonly sessions: LandingTerminalReconciliationInput["sessions"];
  readonly providerLoginProviderFor: (sessionId: string) => ProviderId | null;
}): ReadonlyArray<string> {
  const listing = summarizeProviderLoginListing(
    listedProviderLoginSessions(input.sessions),
    input.providerLoginProviderFor,
  );
  return input.tabs
    .filter((tab) => {
      if (
        tab.hostId !== input.activeHostId ||
        !isProviderLoginLandingTab(tab)
      ) {
        return false;
      }
      const providerId =
        tab.originProviderId ?? input.providerLoginProviderFor(tab.sessionId);
      if (providerId === null) return false;
      return !providerLoginSessionIsCurrent(
        listing.get(providerId),
        tab.sessionId,
      );
    })
    .map((tab) => tab.instanceId);
}

/** Only acknowledged refs may be classified as authoritatively deleted; unacknowledged legacy refs remain
 * available to the migration coordinator. */
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
    // Reuse the existing reference when nothing derived actually moved, the same way the legacy pass above reuses
    // `tab` on an unchanged name.
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

/** Extend this together with that helper: a field compared here but not written there is harmless, one written
 * there but missed here silently re-pins the stale value by reusing the old reference. */
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
