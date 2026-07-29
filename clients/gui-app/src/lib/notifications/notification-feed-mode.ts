import { isPaidTier } from "@traycer/protocol/auth/user";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

/**
 * The notification center has one authoritative source at a time. A paid
 * user stays on the v1 local feed while capability negotiation is pending.
 * Only a confirmed method upgrades the session to cloud; an offline or older
 * host therefore cannot blank retained local rows while discovery waits.
 * Free/pending users never select the cloud method.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  const subscriptionStatus = useAuthStore((state) => state.subscriptionStatus);
  const cloudFeedSupport = useStreamMethodSupport(
    "host.notifications.cloudFeed.subscribe",
  );
  if (subscriptionStatus === null || !isPaidTier(subscriptionStatus)) {
    return "local";
  }
  return cloudFeedSupport === "supported" ? "cloud" : "local";
}
