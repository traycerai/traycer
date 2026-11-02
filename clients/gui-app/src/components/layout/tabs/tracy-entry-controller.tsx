import { useEffect } from "react";
import { useBotListChangedSubscriptionForApp } from "@/hooks/bots/use-bot-list-changed-subscription";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import "@/stores/bots/tracy-entry";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { TRACY_TAB_REF } from "@/stores/tabs/kinds/tracy";

/**
 * Keeps the fixed Tracy entry (decision 150) in step with "Show Tracy",
 * once per window. On, and with a host that lists bots: the Tracy surface
 * opens on this window's host, with or without a main bot, and its tab is
 * pinned (`tracy-entry.ts`) and kept first in the strip. Off: the pin is
 * released and the surface stays open, an ordinary closable tab, if it was.
 * Which channel the surface shows is the surface's own; this never selects.
 */
export function TracyEntryController(): null {
  const show = useSettingsStore((state) => state.showTracy);
  const hostId = useEffectiveHostId();
  const supported = useHostMethodSupport(hostId, "bot.list") === true;
  // The entry names the surface's default channel when none is selected, and
  // is often the only bots surface mounted: a main bot archived or seeded
  // elsewhere refetches the list here too, not only on focus.
  useBotListChangedSubscriptionForApp(show && supported);

  useEffect(() => {
    if (!show || !supported || hostId === null) return;
    useTracySurfaceStore.getState().openSurface(hostId);
  }, [hostId, show, supported]);

  useEffect(() => {
    // After the change that moved it settles: a reconciliation appends a
    // restored tab, and the move is a transaction of its own.
    const keepFirst = (): void => {
      queueMicrotask(() => {
        if (!useSettingsStore.getState().showTracy) return;
        if (!useTracySurfaceStore.getState().open) return;
        tabCommandCoordinator.keepSourceRefFirst(TRACY_TAB_REF);
      });
    };
    keepFirst();
    const unsubscribeLayout = useTabsStore.subscribe((next, previous) => {
      if (next.items !== previous.items) keepFirst();
    });
    const unsubscribeSurface = useTracySurfaceStore.subscribe(
      (next, previous) => {
        if (next.open !== previous.open) keepFirst();
      },
    );
    const unsubscribeSetting = useSettingsStore.subscribe((next, previous) => {
      if (next.showTracy !== previous.showTracy) keepFirst();
    });
    return () => {
      unsubscribeLayout();
      unsubscribeSurface();
      unsubscribeSetting();
    };
  }, []);

  return null;
}
