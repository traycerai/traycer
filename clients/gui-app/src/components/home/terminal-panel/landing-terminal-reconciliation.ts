import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { selectPlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";
import {
  hostAcknowledgedTab,
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
    if (session.status === "exited") {
      exitedInstanceIds.push(tab.instanceId);
      return [];
    }
    if (tab.titleSource === "manual") return [tab];
    const name = defaultLandingTerminalTitle(session, tab.cwd);
    return [name === tab.name ? tab : { ...tab, name }];
  });

  const adoptedTabs = sessions.flatMap((session) => {
    if (
      session.status !== "running" ||
      matchedSessionIds.has(session.sessionId)
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

  const tabs = input.tabs.flatMap((tab) => {
    if (tab.hostId !== input.hostId) return [tab];
    const terminalKey = terminalSessionKey(tab.hostId, tab.sessionId);
    if (input.excludedTerminalKeys.has(terminalKey)) {
      removedInstanceIds.push(tab.instanceId);
      return [];
    }
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
    left.sourceStoreVersion === right.sourceStoreVersion
  );
}

function defaultLandingTerminalTitle(
  session:
    CanonicalTerminalSessionInfo | CanonicalTerminalSessionInfoWithCurrentCwd,
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
