import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import {
  useSurfaceHostPin,
  useTabSurfaceKey,
} from "@/hooks/host/use-surface-host-pin";
import { isSurfacePinDeposed } from "@/stores/host/surface-host-selection-store";

/**
 * The host a link opened in the app from this canvas tab lands on: the
 * Browsers panel's pin while its host can serve, else this machine's own host
 * while IT can serve ({@link useServingLocalHostId}), else `tabHostId`.
 *
 * The local host comes before the tab's host because a native tab exists only
 * on the machine the app runs on: from a MacBook, a task served by another
 * machine would otherwise get a headless browser there, shown as video. The
 * pin comes first because it is the one way to steer a link somewhere else on
 * purpose, a sandbox teammates can watch for one. No principal check here: the
 * host's owner gate decides who can view what it runs.
 *
 * Only link opens honour the pin (`BrowserOpenSessionsProvider`). The Browsers
 * panel's create picker suggests {@link useServingLocalHostId} over the task's
 * host and ignores the pin: there the person names the device themselves, and
 * the pin mostly scopes the Simulators group.
 *
 * `tabHostId` is the host the link used before this existed, the tile it was
 * clicked in. `null` asks only for the first two tiers.
 */
export function useBrowserOpenHost(
  tabId: string,
  tabHostId: string | null,
): string | null {
  const hostPin = useSurfaceHostPin(useTabSurfaceKey("browsers", tabId));
  const localHostId = useServingLocalHostId();
  return hostPin.honoredSelection ?? localHostId ?? tabHostId;
}

/**
 * This machine's own host while it can serve, else `null`.
 *
 * Judged by the pin's own death rule ({@link isSurfacePinDeposed}), so the two
 * cannot disagree about "cannot serve": a dead lease drops it, an expected
 * restart holds it. The local id alone would not do, since
 * `useReactiveLocalHostId` keeps it through a death on purpose.
 */
export function useServingLocalHostId(): string | null {
  const localHostId = useReactiveLocalHostId();
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  return localHostId !== null &&
    !isSurfacePinDeposed(localHostId, { authorityAttached, leases })
    ? localHostId
    : null;
}
