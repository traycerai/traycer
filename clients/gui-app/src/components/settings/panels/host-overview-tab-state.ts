/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview).
 * Update that file whenever this settings surface changes.
 */
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  hostOverviewTabForAnchor,
  isHostOverviewTab,
  type HostOverviewTab,
} from "@/components/settings/panels/host-overview.definitions";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  acknowledgeSettingsOpenIntent,
  useSettingsOpenIntent,
} from "@/stores/tabs/settings-open-intent-store";

/*
 * The Overview's tab state: which tab is selected, how it moves, and the one
 * seam that selects a tab from inside the page. The components that draw the
 * bar and the bodies are in `host-overview-tabs.tsx`; this module holds no
 * component, so both files keep Fast Refresh.
 */

/** Selects one of the Overview's tabs. */
export type HostOverviewSelectTab = (tab: HostOverviewTab) => void;

/**
 * What each tab's trigger (and its phone Select item) carries after its label,
 * or `null` for nothing. The Ports count and the Installation warning dot hang
 * here; every other tab passes `null`.
 */
export type HostOverviewTabBadges = Readonly<
  Record<HostOverviewTab, ReactNode>
>;

export const NO_HOST_OVERVIEW_TAB_BADGES: HostOverviewTabBadges = {
  status: null,
  updates: null,
  ports: null,
  data: null,
  installation: null,
};

/** The tab bodies, one per tab, rendered by `HostOverviewTabs`. */
export type HostOverviewTabBodies = Readonly<
  Record<HostOverviewTab, ReactNode>
>;

export interface HostOverviewTabSelection {
  readonly tab: HostOverviewTab;
  readonly selectTab: HostOverviewSelectTab;
  /**
   * An open intent names a machine the Settings scope has not moved to yet.
   * The page renders nothing for that one pre-paint pass, so no read starts
   * against the machine it is about to leave.
   */
  readonly scopePending: boolean;
}

/**
 * The Overview's selected tab, and every way it moves.
 *
 * Owned ABOVE the per-host remount (`HostSettingsPanel`'s `key={scopeKey}`),
 * which is what lets a switch of host in the sidebar picker keep the tab while
 * the remount still closes whatever was open for the previous host - a
 * confirmation, the rename field, the Doctor panel. The page opens on Status,
 * and nothing here switches tabs by itself: only the reader, an open intent
 * naming a tab, and a settings-search landing on a tab's anchor move it.
 *
 * The intent and the landing are applied during render, the Permissions
 * panel's shape, so the tab they name is the first one drawn and a search
 * reveal finds the anchor it asked for on its first poll. Each is keyed by its
 * own id (the intent's `id`, the request's `requestedAt`), so asking for the
 * same tab twice opens it twice.
 */
export function useHostOverviewTabSelection(
  scope: HostScope,
): HostOverviewTabSelection {
  const intent = useSettingsOpenIntent("host");
  const pendingReveal = useSettingsSearchStore((state) => state.pendingReveal);
  const [tab, setTab] = useState<HostOverviewTab>("status");
  const [appliedIntentId, setAppliedIntentId] = useState<number | null>(null);
  const [appliedRevealAt, setAppliedRevealAt] = useState<number | null>(null);

  // A tab this page does not have is ignored; the intent is still spent.
  if (intent !== null && intent.id !== appliedIntentId) {
    setAppliedIntentId(intent.id);
    if (isHostOverviewTab(intent.tab)) setTab(intent.tab);
  }
  // A page result (`anchor: null`) names no tab and moves nothing.
  if (
    pendingReveal !== null &&
    pendingReveal.section === "host" &&
    pendingReveal.requestedAt !== appliedRevealAt
  ) {
    setAppliedRevealAt(pendingReveal.requestedAt);
    const revealTab = hostOverviewTabForAnchor(pendingReveal.anchor);
    if (revealTab !== null) setTab(revealTab);
  }
  // The intent's machine becomes the Settings scope before paint, and the
  // intent is spent. LAYOUT, so the page never paints a frame of the previous
  // machine under an intent that named another.
  useLayoutEffect(() => {
    if (intent === null) return;
    carryViewedHostIntoSettingsScope(intent.hostId);
    acknowledgeSettingsOpenIntent(intent.id);
  }, [intent]);

  // Compared with the machine the scope RESOLVES to, not the pin: an intent
  // naming the machine Settings already shows moves nothing, and holding
  // would unmount the page for a frame.
  const scopePending =
    intent !== null && intent.hostId !== null && intent.hostId !== scope.hostId;
  return { tab, selectTab: setTab, scopePending };
}

/** Provided by `HostOverviewSelectTabProvider` (`host-overview-tabs.tsx`). */
export const HostOverviewSelectTabContext =
  createContext<HostOverviewSelectTab | null>(null);

/**
 * THE way to select an Overview tab from the header or from inside a tab body
 * - the header's update pill, "Change in Updates", "Pick it in Updates".
 *
 * `null` outside the Overview (a component mounted on its own, as a unit test
 * does), where there is no tab to select: render the words without the link.
 */
export function useHostOverviewSelectTab(): HostOverviewSelectTab | null {
  return use(HostOverviewSelectTabContext);
}
