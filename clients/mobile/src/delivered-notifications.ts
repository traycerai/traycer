/**
 * Takes a Traycer notification out of the phone's notification list once its
 * item is read or cleared on any device, whenever the app runs.
 *
 * A run lists what the OS delivered (`@capacitor/push-notifications`), decodes
 * which person and feed entry each notification is for, asks the server for
 * those entries' read and cleared state with the phone's own sign-in, and
 * removes each one answered read or cleared. Which person and which entry
 * come from the server's push contract (`push-identity.ts` in the internal
 * repository): on iOS `entryId` and `recipient` at the root of the push's
 * data; on Android the notification tag `trc1:<recipient>:<entryId>`, since
 * Android's list exposes the tag and not the data. `recipient` is the first
 * 16 lowercase hex characters of the SHA-256 of the user id's UTF-8 bytes.
 *
 * Nothing is removed that is not known to be this person's and read or
 * cleared: another person's recipient, a tag that does not decode, an id the
 * server does not answer or answers `notFound`, and everything while the
 * server has no such route. A notification with no recipient (sent before the
 * server added it) is removed on a read or cleared answer.
 *
 * One run at a time; a request during a run queues one more. A sign-out or a
 * change of account cancels the run in flight (it stops at its next step) and
 * drops anything queued or scheduled. Triggers: start, every accepted cloud
 * feed frame (through the GUI), resume, the network coming back, and a 30 s
 * poll while the app is in front and one of this person's Traycer
 * notifications is still listed. A phone connected to a team computer gets no
 * cloud feed frames, so the poll is what sees a read or clear made elsewhere
 * while the app stays open. A failed run retries after 2, 5 and 15 s, then
 * waits for the next trigger.
 */
import type { IDeliveredNotificationsHost } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import {
  canonicalNotificationEntryId,
  type NotificationEntryStatesFetchResult,
} from "@traycer-clients/shared/host-client/notification-entry-states";
import {
  utf8Bytes,
  type Sha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import { SignedInUser, type StoredSignInSource } from "./signed-in-user";

const POLL_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];
const RECIPIENT_HEX_LENGTH = 16;

/** The server's Android tag format; a tag that does not match names nothing. */
const TAG_PATTERN =
  /^trc1:([0-9a-f]{16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** One notification as the OS lists it; handed back as is to remove it. */
export interface DeliveredNotification {
  /** Android only. */
  readonly tag?: string;
  readonly data: unknown;
}

export interface DeliveredNotificationList {
  readonly notifications: readonly DeliveredNotification[];
}

/**
 * The slice of `@capacitor/push-notifications` this module drives. Tests fake
 * this boundary; `main.tsx` passes the real plugin.
 */
export interface DeliveredNotificationsPluginSlice {
  getDeliveredNotifications(): Promise<DeliveredNotificationList>;
  removeDeliveredNotifications(
    delivered: DeliveredNotificationList,
  ): Promise<void>;
}

export type DeliveredNotificationsPlatform = "ios" | "android";

/** The app's foreground state and its edges. */
export interface DeliveredNotificationsForeground {
  isBackgrounded(): boolean;
  subscribe(handler: () => void): Disposable;
  subscribeBackground(handler: () => void): Disposable;
}

export interface DeliveredNotificationsOptions {
  readonly plugin: DeliveredNotificationsPluginSlice;
  readonly platform: DeliveredNotificationsPlatform;
  readonly signIn: StoredSignInSource;
  /** The server's entry-states lookup under `bearerToken`. */
  readonly lookup: (
    bearerToken: string,
    entryIds: readonly string[],
  ) => Promise<NotificationEntryStatesFetchResult>;
  readonly foreground: DeliveredNotificationsForeground;
  readonly networkRecovered: { subscribe(handler: () => void): Disposable };
  readonly sha256Hex: Sha256Hex;
}

/** A listed notification that is this person's and names a feed entry. */
interface OwnNotification {
  readonly notification: DeliveredNotification;
  readonly entryId: string;
}

type RunOutcome = "done" | "failed";

export class MobileDeliveredNotifications implements IDeliveredNotificationsHost {
  private readonly signedIn: SignedInUser;
  /** Advanced by every sign-out and account change; a run of an older one stops. */
  private generation = 0;
  private running = false;
  private queued = false;
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  private pollTimer: number | null = null;
  /** Whether the last run left one of this person's notifications listed. */
  private ownListed = false;
  private recipient: {
    readonly userId: string;
    readonly value: string;
  } | null = null;

  constructor(private readonly options: DeliveredNotificationsOptions) {
    this.signedIn = new SignedInUser(options.signIn, () =>
      this.noteSignedInUser(),
    );
  }

  /**
   * Starts following the sign-in and the app's edges. The first answer about
   * who is signed in runs once.
   */
  start(): void {
    const { foreground, networkRecovered } = this.options;
    this.signedIn.start();
    foreground.subscribe(() => this.request(true));
    foreground.subscribeBackground(() => this.stopPoll());
    networkRecovered.subscribe(() => this.request(true));
  }

  noteCloudFeedFrame(userId: string): void {
    const signedIn = this.signedIn.userId;
    if (signedIn !== undefined && userId !== signedIn) return;
    this.request(true);
  }

  /** A new answer about who is signed in, the first one included. */
  private noteSignedInUser(): void {
    this.generation += 1;
    this.queued = false;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.ownListed = false;
    this.stopPoll();
    this.request(true);
  }

  /**
   * `fresh`: a new trigger, which earns its own retries. While who is signed
   * in is still unknown, a trigger reads the sign-in again instead, and its
   * answer runs.
   */
  private request(fresh: boolean): void {
    const userId = this.signedIn.userId;
    if (userId === undefined) {
      this.signedIn.readIfUnknown();
      return;
    }
    if (userId === null) return;
    if (fresh) this.retryAttempt = 0;
    if (this.running) {
      this.queued = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.clearRetryTimer();
    const generation = this.generation;
    let outcome: RunOutcome;
    try {
      outcome = await this.reconcile(generation);
    } catch {
      outcome = "failed";
    }
    this.running = false;
    if (generation === this.generation) {
      if (outcome === "failed") this.scheduleRetry();
      else this.retryAttempt = 0;
      this.updatePoll();
    }
    if (this.queued) {
      this.queued = false;
      void this.run();
    }
  }

  private async reconcile(generation: number): Promise<RunOutcome> {
    const { plugin, signIn, lookup } = this.options;
    const stored = await signIn.get();
    // A sign-in that no longer matches is the next run's; its change event
    // is on its way.
    if (
      generation !== this.generation ||
      stored === null ||
      stored.user.id !== this.signedIn.userId
    ) {
      return "done";
    }
    const userId = stored.user.id;
    const recipient = await this.recipientOf(userId);
    const listed = await plugin.getDeliveredNotifications();
    if (generation !== this.generation) return "done";
    const own = this.ownNotifications(listed.notifications, recipient);
    this.ownListed = own.length > 0;
    if (own.length === 0) return "done";

    const result = await lookup(
      stored.token,
      own.map((item) => item.entryId),
    );
    if (generation !== this.generation) return "done";
    if (result.kind === "unavailable") return "done";
    if (result.kind !== "ok") return "failed";

    const answers = new Map(
      result.entries.map((entry) => [entry.entryId, entry]),
    );
    let listedAfter = own.length;
    let outcome: RunOutcome = "done";
    for (const item of own) {
      const answer = answers.get(item.entryId);
      if (
        answer?.state !== "found" ||
        (answer.readAt === null && answer.clearedAt === null)
      ) {
        continue;
      }
      const current = await signIn.get();
      if (generation !== this.generation || current?.user.id !== userId) {
        return "done";
      }
      try {
        await plugin.removeDeliveredNotifications({
          notifications: [item.notification],
        });
        listedAfter -= 1;
      } catch {
        outcome = "failed";
      }
    }
    if (generation === this.generation) this.ownListed = listedAfter > 0;
    return outcome;
  }

  private ownNotifications(
    listed: readonly DeliveredNotification[],
    recipient: string,
  ): OwnNotification[] {
    const own: OwnNotification[] = [];
    for (const notification of listed) {
      const identity =
        this.options.platform === "ios"
          ? identityFromData(notification.data)
          : identityFromTag(notification.tag);
      if (identity === null) continue;
      if (identity.recipient !== null && identity.recipient !== recipient) {
        continue;
      }
      own.push({ notification, entryId: identity.entryId });
    }
    return own;
  }

  private async recipientOf(userId: string): Promise<string> {
    if (this.recipient?.userId === userId) return this.recipient.value;
    const digest = await this.options.sha256Hex(utf8Bytes(userId));
    const value = digest.slice(0, RECIPIENT_HEX_LENGTH);
    this.recipient = { userId, value };
    return value;
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.retryAttempt];
    if (delay === undefined) return;
    this.retryAttempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.request(false);
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private updatePoll(): void {
    const userId = this.signedIn.userId;
    const wanted =
      this.ownListed &&
      userId !== undefined &&
      userId !== null &&
      !this.options.foreground.isBackgrounded();
    if (!wanted) {
      this.stopPoll();
      return;
    }
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      this.request(true);
    }, POLL_INTERVAL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer === null) return;
    window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

interface NotificationIdentity {
  readonly entryId: string;
  /** `null` for a notification sent before the server added it. */
  readonly recipient: string | null;
}

/**
 * iOS: the push's root keys. A `recipient` that is present but not a string
 * stays in as a value no person's hash equals, so it is never removed.
 */
function identityFromData(data: unknown): NotificationIdentity | null {
  if (typeof data !== "object" || data === null) return null;
  const rawEntryId = "entryId" in data ? data.entryId : undefined;
  const entryId =
    typeof rawEntryId === "string"
      ? canonicalNotificationEntryId(rawEntryId)
      : null;
  if (entryId === null) return null;
  const raw = "recipient" in data ? data.recipient : undefined;
  if (raw === undefined || raw === null) return { entryId, recipient: null };
  return { entryId, recipient: typeof raw === "string" ? raw : "" };
}

/** Android: the tag, which always carries the recipient. */
function identityFromTag(tag: unknown): NotificationIdentity | null {
  if (typeof tag !== "string") return null;
  const [, recipient, entryId] = TAG_PATTERN.exec(tag) ?? [];
  if (recipient === undefined || entryId === undefined) return null;
  return { recipient, entryId };
}
