import { isPaidTier } from "@traycer/protocol/auth/user";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

/**
 * The notification center has one authoritative source at a time. A paid
 * user asks for the cloud feed even while capability negotiation is pending;
 * the distinct optional method then resolves either to cloud or the explicit
 * old-host wall. Free/pending users never subscribe to the cloud method.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  const subscriptionStatus = useAuthStore((state) => state.subscriptionStatus);
  const cloudFeedSupport = useStreamMethodSupport(
    "host.notifications.cloudFeed.subscribe",
  );
  if (subscriptionStatus === null || !isPaidTier(subscriptionStatus)) {
    return "local";
  }
  return cloudFeedSupport === "unsupported" ? "upgrade-required" : "cloud";
}
