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
  readonly foregroundAppLocal: DesktopNotificationForegroundAppLocal | null;
}
