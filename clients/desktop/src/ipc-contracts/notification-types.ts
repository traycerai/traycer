/**
 * IPC mirror of the shared `NotificationShowOutcome` union: what the main
 * process did with a `notifications.show` request. `undeliverable` means the
 * platform cannot present notifications and no window was focused - nothing
 * was shown or relayed, the delivery key is burnt, and the calling renderer
 * owns any fallback cue. It resolves rather than rejects because rejection is
 * the retry signal for app-local deliveries. Structured feed results carry
 * only accepted occurrences; null display means foreground delivery was
 * relayed, including when the focused window sent the request.
 */
export type DesktopNotificationShowOutcome =
  | DesktopNotificationLegacyShowOutcome
  | {
      readonly kind: "feed";
      readonly outcome: "presented" | "undeliverable";
      readonly display: DesktopNotificationFeedDisplay | null;
    };

export type DesktopNotificationLegacyShowOutcome =
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
  readonly feedOccurrences?: ReadonlyArray<DesktopNotificationFeedOccurrence>;
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string | null;
  readonly deliveryKey: string | null;
  readonly feedSource: DesktopNotificationFeedSource | null;
  readonly foregroundAppLocal: DesktopNotificationForegroundAppLocal | null;
}

/** IPC mirror of the shared feed occurrence display, owned by this delivery. */
export interface DesktopNotificationFeedOccurrence {
  readonly key: string;
  readonly userId: string | null;
  readonly chimeEventType: "needs_action" | "failure" | "done" | "info";
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string;
  readonly feedSource: "host" | "cloud";
  readonly originHostId: string | null;
  readonly epicId: string | null;
  readonly chatId: string | null;
}

export interface DesktopNotificationFeedDisplay {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string;
  readonly deliveryKey: string;
  readonly feedSource: "host" | "cloud";
  readonly feedOccurrences: ReadonlyArray<DesktopNotificationFeedOccurrence>;
}
