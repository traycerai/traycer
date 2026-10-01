/** One origin occurrence, independent of the feed that transported it. */
export interface NotificationFeedOccurrence {
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

export interface NotificationFeedDisplay {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
  readonly replaceKey: string;
  readonly deliveryKey: string;
  readonly feedSource: "host" | "cloud";
  readonly feedOccurrences: ReadonlyArray<NotificationFeedOccurrence>;
}

/** Only the shell's accepted subset may render; null means it was relayed. */
export interface NotificationFeedDeliveryResult {
  readonly kind: "feed";
  readonly outcome: "presented" | "undeliverable";
  readonly display: NotificationFeedDisplay | null;
}

/** Bounded, process-lifetime receipts; reconnects do not reopen delivery. */
export class NotificationDeliveryReceipts {
  private readonly keys = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  record(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    while (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next();
      if (oldest.done) break;
      this.keys.delete(oldest.value);
    }
  }

  clear(): void {
    this.keys.clear();
  }
}

/** Rebuild content after deduplication, including a partially delivered batch. */
export function projectNotificationFeedDisplay(
  occurrences: ReadonlyArray<NotificationFeedOccurrence>,
): NotificationFeedDisplay | null {
  const first = occurrences[0];
  if (first === undefined) return null;
  const batched = occurrences.length > 1;
  return {
    title: batched ? "Traycer" : first.title,
    body: batched ? `${occurrences.length} new notifications` : first.body,
    payload: first.payload,
    replaceKey: batched ? "notification-batch" : first.replaceKey,
    deliveryKey: JSON.stringify(occurrences.map((entry) => entry.key).sort()),
    feedSource: first.feedSource,
    feedOccurrences: occurrences,
  };
}
