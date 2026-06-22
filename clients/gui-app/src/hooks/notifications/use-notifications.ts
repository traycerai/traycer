import { useCallback, useEffect } from "react";
import { useRunnerHost } from "@/providers/use-runner-host";

export type NotificationShow = (
  title: string,
  body: string,
  payload: unknown,
) => Promise<void>;

/**
 * Returns a stable callback that forwards GUI-driven notification requests
 * to the runner-host notification surface.
 */
export function useNotificationShow(): NotificationShow {
  const runnerHost = useRunnerHost();
  return useCallback<NotificationShow>(
    async (title, body, payload) => {
      await runnerHost.notifications.show(title, body, payload);
    },
    [runnerHost],
  );
}

/**
 * Subscribes to native notification-click events and routes the payload to
 * the supplied handler. The handler is re-bound on change so Hooks-style
 * dependencies flow through normally.
 *
 * Payload shape is intentionally `unknown` - notification senders decide
 * the envelope (sessionId, approvalId, route hint, etc.). Consumers narrow
 * the payload in their own handler.
 */
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
