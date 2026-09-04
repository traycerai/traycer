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

  // Sign-ins first, through the one adoption rule both arms share (it also
  // takes an exited session, which an ordinary adoption never does), then
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
 * The ref for a listed sign-in session this window did not open. Same shape
 * the opening path writes, so every reader downstream - the adopt-only tile,
 * the legacy-import exclusion, the close and rename paths - classifies a
 * session discovered here exactly as one this window opened. Manual title for
 * the same reason: the host names it "<Provider> sign-in" and reconciliation
 * must not retitle it from cwd.
 */
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

/**
 * What the registry-claimed sessions the host lists say about each provider:
 * which are running, and which exited one is newest. Computed over EVERY
 * listed claimed session, tombstoned ones included - a tombstone means "raise
 * no tab for this session", not "this session did not happen". The newest
 * retry the user just closed still outranks the older retries beside it in
 * the exit-grace listing; dropping it from the summary would promote one of
 * them into a fresh "Start again" tab the moment the close landed.
 */
interface ProviderLoginListing {
  readonly runningSessionIds: ReadonlySet<string>;
  readonly newestExited: Pick<
    CanonicalTerminalSessionInfo,
    "sessionId" | "createdAt"
  > | null;
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
  const summary = new Map<
    ProviderId,
    {
      runningSessionIds: Set<string>;
      newestExited: ProviderLoginListing["newestExited"];
    }
  >();
  for (const session of sessions) {
    const providerId = providerLoginProviderFor(session.sessionId);
    if (providerId === null) continue;
    const entry = summary.get(providerId) ?? {
      runningSessionIds: new Set<string>(),
      newestExited: null,
    };
    if (session.status === "running") {
      entry.runningSessionIds.add(session.sessionId);
    } else if (
      entry.newestExited === null ||
      session.createdAt > entry.newestExited.createdAt
    ) {
      entry.newestExited = session;
    }
    summary.set(providerId, entry);
  }
  return summary;
}

/**
 * Whether a sign-in session (or the tab standing for it) is one this window
 * should show for its provider: every running one, else the newest exited
 * one. Rapid retries can leave several exited sign-ins for one provider in
 * the grace listing; only the newest is the one a "Start again" should stand
 * for, the rest are the predecessors those retries killed. An absent session
 * (aged out of the grace window, or gone with a host restart) is outranked by
 * anything listed - it is by construction older.
 */
function providerLoginSessionIsCurrent(
  listing: ProviderLoginListing | undefined,
  sessionId: string,
): boolean {
  if (listing === undefined) return true;
  if (listing.runningSessionIds.has(sessionId)) return true;
  if (listing.runningSessionIds.size > 0) return false;
  return listing.newestExited === null
    ? true
    : listing.newestExited.sessionId === sessionId;
}

/**
 * The sign-in sessions the host lists that this window should hold a tab for
 * and does not, as sign-in tabs. Shared by both arms.
 *
 * The capable arm reconciles against the plain-terminal projection, and a
 * host-created sign-in session is never in it: the host made it for
 * `providers.startTerminalLogin`, through the session manager, so the plain
 * registry has no row for it. Without this the capable arm could classify a
 * tab that already existed but never CREATE one - so a sign-in started in
 * another window, whose record arrived through the shared registry, had no
 * tab on a capable host and its code stayed invisible there.
 *
 * Sign-in sessions ONLY - a session the registry does not claim is left to the
 * projection, which is the capable host's authority over ordinary terminals.
 * A tombstoned session (closed here, kill still in flight) is never adopted:
 * that would resurrect a tab the user just closed. It still counts in the
 * per-provider listing above, so closing the newest retry does not promote an
 * older one.
 *
 * An EXITED sign-in is adopted too, unlike an ordinary session. A sign-in tab
 * keeps its ended state on purpose - that is the "Start again" surface - and
 * a short-lived sign-in can end before this window learns what it was, while
 * the host still lists it through its exit grace window; adopting running
 * sessions only would leave this window without that surface for good.
 */
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

/**
 * The sign-in tabs the host's listing has SUPERSEDED: this host's tabs whose
 * session is no longer the one to show for its provider (a running sign-in
 * exists, or a newer exited one does). Returned as instance ids for the
 * caller to drop in the same pass that adopts, in both arms.
 *
 * A restart kills its predecessor, and only the window that pressed it
 * retires that tab (`openLandingSignInTerminal`). Every other window that
 * shows the predecessor - adopted, or reclassified once its provenance
 * arrived - would otherwise hold it beside the successor and have two
 * "Start again" tabs for one provider, the stale one restarting only itself.
 * Judged from the listing rather than from what THIS pass adopted: the
 * successor may already be a tab here, adopted as an ordinary terminal
 * before its record arrived and classified since, in which case nothing is
 * adopted and the predecessor still has to go. A tab whose own session is
 * still running is never retired: two live sign-ins are the host's to
 * resolve, not this window's to hide.
 */
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
