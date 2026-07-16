import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import {
  terminalSessionKey,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";

export interface LandingTerminalReconciliationInput {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  readonly activeHostId: string;
  readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo>;
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
    return [tab];
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
      name: workspaceFolderName(session.cwd),
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
