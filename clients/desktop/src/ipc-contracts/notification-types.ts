/** `undeliverable` means the platform cannot present notifications and no window was focused. */
export type DesktopNotificationShowOutcome =
  | "presented"
  | "duplicate"
  | "undeliverable";

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
