import { useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { consumeIndependentPageOpenedTab } from "@/lib/browser-view/sessions/independent-page-open-registry";
import {
  landingBrowserTabs,
  landingTabRefKey,
  useLandingPanelStore,
  type LandingBrowserTabRef,
  type LandingPanelTabRef,
} from "@/stores/home/landing-panel-store";

/**
 * The Start Page's browser scope. Its tabs belong to the user on a device and
 * to no task, which the wire spells `independent` rather than with a sentinel
 * epic id.
 */
export const INDEPENDENT_BROWSER_SCOPE: HostResourceScope = {
  kind: "independent",
};

/**
 * The device's independent browser inventory, reconciled into the panel's
 * `(device, browser)` slice.
 *
 * It mirrors the RULES of the terminal reconciler - adopt what the host has and
 * the store does not, drop what the host no longer has unless it is tombstoned,
 * refresh derived titles but never a manual one - and deliberately not its
 * MACHINERY. The terminal side runs an abortable zero-stale `terminal.list`
 * fetch with a latch and two wake sources because its authority is a request.
 * This one's authority is a push stream the coordinator already holds, so the
 * whole pass is a projection of `sessions.items` and re-runs when that changes.
 *
 * `inventoryReady` is the gate and it is not optional: the coordinator reports
 * an empty `items` while a stream is still connecting, which is indistinguishable
 * from "this device has no browser tabs" - and acting on it would drop every
 * browser tab in the panel on every reconnect.
 */
export function useLandingBrowserReconciliation(args: {
  readonly hostId: string;
  readonly sessions: BrowserSessionsState;
  /**
   * `false` for a surface that shares the coordinator but must not write the
   * store. Two reconcilers on one slice would each act against a snapshot the
   * other had already applied.
   */
  readonly enabled: boolean;
}): void {
  const { hostId, sessions, enabled } = args;
  const inventoryReady = sessions.inventoryReady;
  const items = sessions.items;

  useEffect(() => {
    if (!enabled || !inventoryReady) return;
    const store = useLandingPanelStore.getState();
    const reconciliation = reconcileLandingBrowserTabs({
      tabs: landingBrowserTabs(store.tabs).filter(
        (tab) => tab.hostId === hostId,
      ),
      hostId,
      sessions: items,
      excludedTabKeys: new Set(
        store.pendingKills
          .filter((pending) => pending.hostId === hostId)
          .map((pending) => landingTabRefKey(pending)),
      ),
      mintInstanceId: () => `landing-browser-${uuidv4()}`,
    });
    store.applyReconciliationSlice(
      hostId,
      "browser",
      reconciliation.tabs,
      reconciliation.collapseWhenEmpty,
    );
    // A tab the PAGE opened is a gesture the reader made, so the row it lands
    // as is the one they should be on. Everything else the pass adopts is the
    // device's existing inventory arriving - another window's tabs, a
    // reconnect's snapshot - and yanking the selection onto those would move
    // the panel for reasons the person at this keyboard did not cause.
    //
    // The last one wins because activation is single-valued and a pass can
    // adopt several: the most recent open is the one still on screen in the
    // reader's head.
    const pageOpened = reconciliation.adoptedTabs.filter((tab) =>
      consumeIndependentPageOpenedTab({
        hostId: tab.hostId,
        sessionId: tab.sessionId,
        tabId: tab.tabId,
      }),
    );
    const landed = pageOpened.at(-1);
    if (landed !== undefined) store.activateTab(landed.instanceId);
  }, [enabled, hostId, inventoryReady, items]);
}

export interface LandingBrowserReconciliationInput {
  /** The `(hostId, "browser")` slice, not the whole panel list. */
  readonly tabs: ReadonlyArray<LandingBrowserTabRef>;
  readonly hostId: string;
  readonly sessions: readonly BrowserSessionInfo[];
  /** Tombstoned tabs, which stay dropped rather than being re-adopted. */
  readonly excludedTabKeys: ReadonlySet<string>;
  readonly mintInstanceId: () => string;
}

export interface LandingBrowserReconciliationResult {
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  readonly adoptedTabs: ReadonlyArray<LandingBrowserTabRef>;
  readonly removedInstanceIds: ReadonlyArray<string>;
  readonly collapseWhenEmpty: boolean;
}

/**
 * A browser tab's default title: the page title, falling back to the address.
 *
 * The address is the fallback rather than a placeholder because it is what the
 * user recognises a tab by before its title arrives, and a blank page has no
 * title at all.
 */
export function defaultLandingBrowserTitle(tab: {
  readonly title: string | null;
  readonly url: string;
}): string {
  const title = tab.title?.trim() ?? "";
  return title.length > 0 ? title : tab.url;
}

/**
 * Pure so the adopt / drop / title rules can be driven directly, which is the
 * only way to pin the tombstone exclusion: a tombstoned tab is still in the
 * host's inventory until the close lands, so "absent from the snapshot" is not
 * what keeps it out of the panel.
 */
export function reconcileLandingBrowserTabs(
  input: LandingBrowserReconciliationInput,
): LandingBrowserReconciliationResult {
  // Only this device's independent sessions. The coordinator is keyed by scope
  // and host, so its items are already both - filtering again is a guard, not a
  // second opinion.
  const hostSessions = input.sessions.filter(
    (session) =>
      session.hostId === input.hostId && session.scope.kind === "independent",
  );
  const tabBySessionTab = new Map(
    hostSessions.flatMap((session) =>
      session.tabs.map((tab) => [
        landingTabRefKey({
          kind: "browser",
          hostId: input.hostId,
          sessionId: session.sessionId,
          tabId: tab.tabId,
        }),
        tab,
      ]),
    ),
  );
  const matchedKeys = new Set<string>();
  const removedInstanceIds: string[] = [];

  const tabs = input.tabs.flatMap((tab) => {
    const key = landingTabRefKey(tab);
    if (input.excludedTabKeys.has(key)) {
      removedInstanceIds.push(tab.instanceId);
      return [];
    }
    const live = tabBySessionTab.get(key);
    if (live === undefined) {
      // The host is publishing this device's whole inventory, so a tab it does
      // not list is a tab that is gone - unlike a terminal, whose absence can
      // mean a create still in flight under a client-supplied id. Every browser
      // tab id here was minted by the host and reported before it was stored.
      removedInstanceIds.push(tab.instanceId);
      return [];
    }
    matchedKeys.add(key);
    if (tab.titleSource === "manual") return [tab];
    const name = defaultLandingBrowserTitle(live);
    return [name === tab.name ? tab : { ...tab, name }];
  });

  const adoptedTabs = hostSessions.flatMap((session) =>
    session.tabs.flatMap((live) => {
      const key = landingTabRefKey({
        kind: "browser",
        hostId: input.hostId,
        sessionId: session.sessionId,
        tabId: live.tabId,
      });
      if (matchedKeys.has(key) || input.excludedTabKeys.has(key)) return [];
      const adopted: LandingBrowserTabRef = {
        kind: "browser",
        instanceId: input.mintInstanceId(),
        hostId: input.hostId,
        sessionId: session.sessionId,
        tabId: live.tabId,
        name: defaultLandingBrowserTitle(live),
        titleSource: "default",
      };
      return [adopted];
    }),
  );

  return {
    tabs: [...tabs, ...adoptedTabs],
    adoptedTabs,
    removedInstanceIds,
    collapseWhenEmpty: removedInstanceIds.length > 0,
  };
}
