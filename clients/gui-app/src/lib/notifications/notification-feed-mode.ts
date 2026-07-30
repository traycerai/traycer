import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

/**
 * The notification center has one authoritative source at a time. The v1
 * local feed is the capability fallback for older or otherwise methodless
 * hosts. Capability negotiation stays local while pending so an offline host
 * cannot blank retained rows; only confirmed method support selects cloud.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  const cloudFeedSupport = useStreamMethodSupport(
    "host.notifications.cloudFeed.subscribe",
  );
  return cloudFeedSupport === "supported" ? "cloud" : "local";
}
