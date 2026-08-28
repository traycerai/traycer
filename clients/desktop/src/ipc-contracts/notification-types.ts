/**
 * IPC mirror of the shared `NotificationShowOutcome` union: what the main
 * process did with a `notifications.show` request. `undeliverable` means the
 * platform cannot present notifications and no window was focused - nothing
 * was shown or relayed, the delivery key is burnt, and the calling renderer
 * owns any fallback cue. It resolves rather than rejects because rejection is
 * the retry signal for app-local deliveries.
 */
export type DesktopNotificationShowOutcome =
  | "presented"
  | "duplicate"
  | "undeliverable";

/**
 * IPC mirror of the shared `NotificationFeedSource`: which feed produced the
 * row. Carried on the relay separately from the activation payload, which
 * degrades to `null` for unrecognized rows and would erase provenance exactly
 * where the receive-side gates need it.
 */
export type DesktopNotificationFeedSource =
  | "host"
  | "cloud"
  | "app-local"
  | "global";

/** Plain-data notification projection relayed main -> focused renderer. */
export interface DesktopNotificationForegroundAppLocal {
  readonly userId: string;
  readonly entry: unknown;
}

export interface DesktopNotificationForegroundDisplay {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string | null;
  readonly deliveryKey: string | null;
  readonly feedSource: DesktopNotificationFeedSource | null;
  readonly foregroundAppLocal: DesktopNotificationForegroundAppLocal | null;
}
