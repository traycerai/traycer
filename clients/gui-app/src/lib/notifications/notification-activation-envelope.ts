// Versioned native-notification activation envelope. Native display paths
// (native OS notifications, not in-app Sonner toasts, which already hold the
// row object) wrap the route payload with feed correlation and origin-host
// context so a click can be acknowledged against the right row and guarded
// against a stale/switched host, without leaking any of that identity into
// analytics or logs.

import {
  parseNotificationPayload,
  type NotificationPayload,
} from "@/lib/notifications/payload";

const ENVELOPE_KIND = "notificationActivation";
const ENVELOPE_VERSION = 1;

export type NotificationActivationEnvelopeFeedSource =
  "host" | "app-local" | "global";

export interface NotificationActivationEnvelopeFeed {
  readonly source: NotificationActivationEnvelopeFeedSource;
  readonly id: string;
}

export interface NotificationActivationEnvelopeV1 {
  readonly kind: typeof ENVELOPE_KIND;
  readonly version: typeof ENVELOPE_VERSION;
  readonly route: NotificationPayload;
  readonly feed: NotificationActivationEnvelopeFeed;
  /** Active host id captured at emission time for a host-sourced row; `null`
   * for app-local/global rows, which carry no host binding. */
  readonly originHostId: string | null;
}

export function buildNotificationActivationEnvelope(input: {
  readonly route: NotificationPayload;
  readonly feed: NotificationActivationEnvelopeFeed;
  readonly originHostId: string | null;
}): NotificationActivationEnvelopeV1 {
  return {
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    route: input.route,
    feed: input.feed,
    originHostId: input.originHostId,
  };
}

/** Feed identity travels as a delimited string everywhere else in the
 * renderer (`merged-notifications.ts`'s `hostFeedId`/`appLocalFeedId`/
 * `globalFeedId`); this reconstructs the same shape from an envelope's
 * structured feed field without importing the store layer. */
export function feedIdFromEnvelopeFeed(
  feed: NotificationActivationEnvelopeFeed,
): string {
  return `${feed.source}:${feed.id}`;
}

export type ParsedNotificationActivationPayload =
  | { readonly kind: "v1"; readonly envelope: NotificationActivationEnvelopeV1 }
  | { readonly kind: "legacy"; readonly payload: NotificationPayload }
  | { readonly kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseEnvelopeFeed(
  value: unknown,
): NotificationActivationEnvelopeFeed | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  if (source !== "host" && source !== "app-local" && source !== "global") {
    return null;
  }
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) return null;
  return { source, id };
}

function parseEnvelopeV1(
  value: Record<string, unknown>,
): NotificationActivationEnvelopeV1 | null {
  if (value.kind !== ENVELOPE_KIND || value.version !== ENVELOPE_VERSION) {
    return null;
  }
  const route = parseNotificationPayload(value.route);
  if (route === null) return null;
  const feed = parseEnvelopeFeed(value.feed);
  if (feed === null) return null;
  const originHostId = value.originHostId;
  if (originHostId !== null && typeof originHostId !== "string") {
    return null;
  }
  return {
    kind: ENVELOPE_KIND,
    version: ENVELOPE_VERSION,
    route,
    feed,
    originHostId,
  };
}

/**
 * Parses a native-notification click payload. Accepts the versioned V1
 * envelope first (route + feed correlation + nullable origin host), falls
 * back to a legacy raw route payload with no feed identity, and reports
 * `unknown` for anything unrecognized so the caller can fall back to opening
 * the center rather than silently dropping the click.
 */
export function parseNotificationActivationPayload(
  value: unknown,
): ParsedNotificationActivationPayload {
  if (isRecord(value)) {
    const envelope = parseEnvelopeV1(value);
    if (envelope !== null) return { kind: "v1", envelope };
  }
  const legacy = parseNotificationPayload(value);
  if (legacy !== null) return { kind: "legacy", payload: legacy };
  return { kind: "unknown" };
}
