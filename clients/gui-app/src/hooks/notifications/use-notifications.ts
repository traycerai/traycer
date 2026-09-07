import { useCallback, useEffect } from "react";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  NotificationFeedSource,
  NotificationForegroundAppLocal,
  NotificationForegroundDisplay,
  NotificationShowOutcome,
} from "@traycer-clients/shared/platform/runner-host";

export interface NotificationShowRequest {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string | null;
  readonly deliveryKey: string | null;
  readonly feedSource: NotificationFeedSource | null;
  readonly foregroundAppLocal: NotificationForegroundAppLocal | null;
}

export type NotificationShow = (
  request: NotificationShowRequest,
) => Promise<NotificationShowOutcome>;

export function useNotificationShow(): NotificationShow {
  const runnerHost = useRunnerHost();
  return useCallback<NotificationShow>(
    ({
      title,
      body,
      payload,
      replaceKey,
      deliveryKey,
      feedSource,
      foregroundAppLocal,
    }) =>
      runnerHost.notifications.show(
        title,
        body,
        payload,
        replaceKey,
        deliveryKey,
        feedSource,
        foregroundAppLocal,
      ),
    [runnerHost],
  );
}

export function useNotificationForegroundDisplay(
  handler: (display: NotificationForegroundDisplay) => void,
): void {
  const runnerHost = useRunnerHost();
  useEffect(() => {
    const subscription = runnerHost.notifications.onForegroundDisplay(handler);
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, handler]);
}

/** Subscribes to native notification-click events and routes the payload to the supplied handler. */
export function useNotificationClick(
  handler: (payload: unknown) => void,
): void {
  const runnerHost = useRunnerHost();
  useEffect(() => {
    const subscription = runnerHost.notifications.onClick(handler);
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, handler]);
}
