import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { isSurfacePinDeposed } from "@/stores/host/surface-host-selection-store";

/**
 * The host a browser the person opens from this canvas tab is created on: the
 * Browsers panel's pin while its host can serve, else this machine's own host
 * while IT can serve, else `tabHostId`.
 *
 * The local host comes before the tab's host because a native tab exists only
 * on the machine the app runs on: from a MacBook, a task served by another
 * machine would otherwise get a headless browser there, shown as video. The
 * pin comes first because it is the one way to put a browser somewhere else on
 * purpose, a sandbox teammates can watch for one. No principal check here: the
 * host's owner gate decides who can view what it runs.
 *
 * Both tiers are judged by the pin's own death rule ({@link isSurfacePinDeposed}),
 * so they cannot disagree about "cannot serve": a dead lease falls through, an
 * expected restart holds. The local id alone would not do, since
 * `useReactiveLocalHostId` keeps it through a death on purpose.
 *
 * `tabHostId` is the site's own host, the one it used before this existed, and
 * it differs by site (the panel's resolved host for its add action, a tile's
 * host for a link clicked in it). `null` asks only for the first two tiers.
 */
export function useBrowserOpenHost(
  tabId: string,
  tabHostId: string | null,
): string | null {
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", tabId));
  const localHostId = useReactiveLocalHostId();
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  const honoredLocalHostId =
    localHostId !== null &&
    !isSurfacePinDeposed(localHostId, { authorityAttached, leases })
      ? localHostId
      : null;
  return hostPin.honoredSelection ?? honoredLocalHostId ?? tabHostId;
}
