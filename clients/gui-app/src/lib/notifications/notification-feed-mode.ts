import {
  useStreamMethodSchemaVersion,
  useStreamMethodSupport,
} from "@/lib/host/stream-runtime-context";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

/**
 * A cloud-capable host is mixed-plane only once all durable-home projections
 * negotiated. An older host may advertise the relay but still expose whole
 * origin summaries; selecting both there would double-count replicas. In that
 * case local remains the single safe view until the host upgrades.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  const cloudFeedSupport = useStreamMethodSupport(
    "host.notifications.cloudFeed.subscribe",
  );
  const cloudFeedVersion = useStreamMethodSchemaVersion(
    "host.notifications.cloudFeed.subscribe",
  );
  const localFeedVersion = useStreamMethodSchemaVersion(
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
