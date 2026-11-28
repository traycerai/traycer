import { useEffect } from "react";
import type { IAppIconBadgeHost } from "@traycer-clients/shared/platform/runner-host";
import { useShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";
import { appIconBadgeCount } from "@/lib/notifications/bell-mark";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useNotificationBellState } from "@/stores/notifications/merged-notifications";
import { useNotificationsNeedsYouCount } from "@/stores/notifications/needs-you-task-count-store";

/**
 * Hands the shell the number this app shows, for its icon: the bell's inputs,
 * counted the way the shell's `countSource` says its app draws them. `0` while
 * the app shell is not admitted (signed out, or a session this shell refuses),
 * since neither the bell nor the phone's Notifications row is drawn then, and
 * `0` on unmount. Mount once per window; a shell with no badge gets nothing.
 */
export function useAppIconBadge(): void {
  const { appIconBadge } = useRunnerHost();
  const bellState = useNotificationBellState();
  const needsYouCount = useNotificationsNeedsYouCount();
  const { admitted } = useShellLocalPlaneAdmission();
  const count =
    appIconBadge === null || !admitted
      ? 0
      : appIconBadgeCount(appIconBadge.countSource, bellState, needsYouCount);

  useEffect(() => {
    if (appIconBadge === null) return;
    publishAppIconBadgeCount(appIconBadge, count);
  }, [appIconBadge, count]);

  useEffect(() => {
    if (appIconBadge === null) return;
    return () => publishAppIconBadgeCount(appIconBadge, 0);
  }, [appIconBadge]);
}

/** The badge is decoration: a shell that refuses a count costs nothing else. */
function publishAppIconBadgeCount(
  badge: IAppIconBadgeHost,
  count: number,
): void {
  badge.setCount(count).catch((error: unknown) => {
    appLogger.debug("[notifications] app icon badge refused", {
      count,
      error: describeLogErrorSummary(error),
    });
  });
}
