import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import {
  useNotificationsServingHostEntry,
  useNotificationsServingHostId,
} from "@/hooks/host/use-notifications-serving-host-entry";

export interface NotificationHost {
  /**
   * The host whose origin store the rendered host-notification rows came
   * from, or `null` when there is none right now (browser/mobile shell, or
   * the local host's IPC channel dropped).
   *
   * Also the honest "can these rows be mutated" signal: the entry this is
   * projected from disappears exactly when the host does, so a click gated on
   * it cannot fire an RPC into a host that is no longer there.
   */
  readonly hostId: string | null;
  /** RPC client bound to {@link hostId}, or `null` on the same conditions. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

const NO_NOTIFICATION_HOST: NotificationHost = { hostId: null, client: null };

/**
 * The ONE host the notification centre speaks to - the host that SERVES this
 * client's feeds, per the G8 decision that notifications never follow the
 * active host.
 *
 * `NotificationsSessionProvider` opens both notification streams on
 * `useNotificationsServingHostEntry()`, but everything DOWNSTREAM of those
 * streams - the rows' `originHostId` stamp, the mark-read / resolve / paginate
 * mutations, the indicator query - reached for the app-wide
 * `useReactiveActiveHostId()` / `useHostClient()` instead. Those two agree
 * only while the local host is also the active one. Select a remote host and
 * they diverge: the rows on screen are host A's, while activating one routes
 * to host B (opening the wrong machine's tile, or nothing), marking it read
 * writes B's store, and "load older" pages A's cursor against B's feed.
 *
 * Reading the same binding the streams use makes that skew unrepresentable
 * rather than merely unlikely - which is why this resolves through the
 * provider's own authority and NOT through `useReactiveLocalHostEntry()`
 * directly. They agree on every shell that has a local host, and diverge on
 * exactly the shell where the local rule has no subject: a relay-only shell
 * (Capacitor mobile, web) serves its feeds from the BOUND host, where the
 * local entry is permanently `null`. Resolving the local entry here handed
 * `useHostClientFor` a `null` target on those shells, so the streams were live
 * and every mutation against them was inert.
 */
export function useNotificationResolveHost(): NotificationHost {
  const entry = useNotificationsServingHostEntry();
  const client = useHostClientFor(entry);
  const hostId = entry?.hostId ?? null;
  return useMemo(
    () => (hostId === null ? NO_NOTIFICATION_HOST : { hostId, client }),
    [hostId, client],
  );
}

/**
 * {@link useNotificationResolveHost}'s id half, for the consumers that only need to
 * FILE rows under the owning host rather than talk to it.
 *
 * Deliberately not `useNotificationResolveHost().hostId`: resolving the client goes
 * through `useHostClient()`, which THROWS outside a `<HostRuntimeProvider>`.
 * The indicator query is read by ordinary chrome - the tab strip, the sidebar
 * rows - that renders in trees with no host runtime at all, so pulling the
 * client in just to read an id turned a null host into a render crash.
 * `useNotificationsServingHostId` exists to answer the same question under
 * that constraint, and shares the serving rule with the entry hook rather than
 * restating it.
 */
export function useNotificationResolveHostId(): string | null {
  return useNotificationsServingHostId();
}
