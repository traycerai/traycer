import { use } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  useStreamMethodSchemaVersionFor,
  useStreamMethodSupportFor,
} from "@/lib/host/stream-runtime-context";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

/**
 * The negotiated feed mode for the host the notification streams are OPEN on.
 *
 * Read from context rather than recomputed per call site. The capability read
 * has to name the exact client `NotificationsSessionProvider` opened the
 * streams against - `useReactiveLocalHostEntry()`, which is deliberately not
 * the app-wide active host - and `useHostStreamClientFor` builds a client per
 * hook instance, so recomputing it in each of the ~8 consumers would both dial
 * spare clients and, worse, read the wrong host's manifest.
 *
 * Defaults to `local` outside the provider: that is the single safe view, the
 * same answer an incomplete negotiation gives.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  return use(NotificationFeedModeContext);
}

/**
 * Negotiates the feed mode against ONE explicit stream client.
 *
 * A cloud-capable host is mixed-plane only once all durable-home projections
 * negotiated. An older host may advertise the relay but still expose whole
 * origin summaries; selecting both there would double-count replicas. In that
 * case local remains the single safe view until the host upgrades.
 */
export function useNotificationFeedModeFor(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): NotificationFeedMode {
  const cloudFeedSupport = useStreamMethodSupportFor(
    client,
    "host.notifications.cloudFeed.subscribe",
  );
  const cloudFeedVersion = useStreamMethodSchemaVersionFor(
    client,
    "host.notifications.cloudFeed.subscribe",
  );
  const localFeedVersion = useStreamMethodSchemaVersionFor(
    client,
    "host.notifications.feed.subscribe",
  );
  const hasCloudProjection =
    cloudFeedVersion?.major === 1 && cloudFeedVersion.minor >= 1;
  const hasLocalProjection =
    localFeedVersion?.major === 1 && localFeedVersion.minor >= 2;
  return cloudFeedSupport === "supported" &&
    hasCloudProjection &&
    hasLocalProjection
    ? "cloud"
    : "local";
}
